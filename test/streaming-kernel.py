# /// script
# requires-python = ">=3.12"
# dependencies = ["ipython~=9.17.0", "objprint~=0.3.0", "partial-python~=0.1.0"]
# ///
"""Real control-channel smoke for raw-Python streaming and cancellation."""

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

KERNEL = Path(__file__).resolve().parents[1] / "py/kernel.py"


async def main():
    parent, child = socket.socketpair()
    bootstrap = "import os,runpy; os.dup2(int(os.environ['TEST_KERNEL_FD']),3); runpy.run_path(os.environ['TEST_KERNEL_PATH'],run_name='__main__')"
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        bootstrap,
        pass_fds=(child.fileno(),),
        env={**os.environ, "TEST_KERNEL_FD": str(child.fileno()), "TEST_KERNEL_PATH": str(KERNEL)},
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    child.close()
    reader, writer = await asyncio.open_connection(sock=parent)
    checks = []
    calls = []

    async def send(kind, **fields):
        writer.write((json.dumps({"t": kind, "shell": "main", **fields}) + "\n").encode())
        await writer.drain()

    async def receive():
        line = await asyncio.wait_for(reader.readline(), 5)
        assert line, "kernel exited without a frame"
        return json.loads(line)

    async def call(value):
        frame = await receive()
        assert frame["t"] == "call" and frame["args"]["value"] == value, frame
        calls.append(value)
        await send("result", id=frame["id"], ok=True, value=value)

    async def done(exec_id, ok=True):
        frame = await receive()
        assert frame["t"] == "done" and frame["id"] == exec_id and frame["ok"] == ok, frame
        return frame

    async def quiet():
        try:
            frame = await asyncio.wait_for(reader.readline(), 0.05)
        except TimeoutError:
            return
        raise AssertionError(f"unexpected early frame: {frame!r}")

    try:
        async with asyncio.timeout(40):
            await send("init", tools=[{"name": "mark", "doc": "Record one observed effect.", "params": [{"name": "value", "type": "str", "required": True}]}])
            assert (await receive())["t"] == "ready"
            prefix = "from __dsh__.tools import mark\nawait mark(value='early')\n"
            suite = "for value in ('loop-1', 'loop-2'):\n    await mark(value=value)\n"
            await send("stream_start", id=1)
            await send("stream_append", id=1, text=prefix)
            await call("early")
            await send("stream_append", id=1, text=suite)
            await quiet()
            await send("stream_finish", id=1, source=prefix + suite)
            await call("loop-1")
            await call("loop-2")
            await done(1)
            checks.append("early effect, compound holdback, successful EOF")

            prefix = "await mark(value='before-abort')\n"
            await send("stream_start", id=2)
            await send("stream_append", id=2, text=prefix + suite)
            await call("before-abort")
            await send("stream_abort", id=2, message="SourceError: token limit")
            assert "token limit" in (await done(2, False))["error"]
            checks.append("source abort preserves prior effects and withholds suite")

            prefix = "await mark(value='before-mismatch')\n"
            await send("stream_start", id=3)
            await send("stream_append", id=3, text=prefix + suite)
            await call("before-mismatch")
            await send("stream_finish", id=3, source=prefix + suite + "pass\n")
            assert "differs" in (await done(3, False))["error"]
            checks.append("final source mismatch never flushes pending suite")

            writer.write((json.dumps({"t": "stream_start", "id": 4}) + "\n" + json.dumps({"t": "stream_abort", "id": 4, "message": "cancel immediately"}) + "\n").encode())
            await writer.drain()
            await done(4, False)
            checks.append("abort before owner task starts still returns done")

            prefix = "await mark(value='before-failure')\nraise ValueError('expected')\nawait mark(value='never')\n"
            await send("stream_start", id=5)
            await send("stream_append", id=5, text=prefix)
            await call("before-failure")
            assert "ValueError" in (await done(5, False))["error"]
            await send("stream_finish", id=5, source=prefix)
            checks.append("runtime failure does not run queued statements")

            prefix = "from contextvars import ContextVar\nv = ContextVar('poc')\ntoken = v.set('context')\nawait mark(value=v.get())\n"
            suffix = "v.reset(token)\nprint('context reset')\n"
            await send("stream_start", id=6)
            await send("stream_append", id=6, text=prefix)
            await call("context")
            await send("stream_append", id=6, text=suffix)
            await send("stream_finish", id=6, source=prefix + suffix)
            assert (await done(6))["stdout"] == "context reset\n"
            checks.append("one task and capture preserve ContextVar across deltas")

            prefix = "await mark(value='held')\n"
            suffix = "await mark(value='received-while-awaiting')\n"
            await send("stream_start", id=7)
            await send("stream_append", id=7, text=prefix)
            held = await receive()
            assert held["t"] == "call" and held["args"]["value"] == "held", held
            calls.append("held")
            await send("stream_append", id=7, text=suffix)
            await send("stream_finish", id=7, source=prefix + suffix)
            await send("result", id=held["id"], ok=True, value="released")
            await call("received-while-awaiting")
            await done(7)
            checks.append("receives remaining source while a nested tool awaits")

            await send("stream_start", id=8)
            await send("stream_append", id=8, text="%whos\n")
            await send("stream_finish", id=8, source="%whos\n")
            assert "SyntaxError" in (await done(8, False))["error"]
            await send("exec", id=9, code="%whos")
            assert "mark" in (await done(9))["stdout"]
            checks.append("streaming is raw Python while whole-cell IPython still works")

            await send("stream_start", id=1)
            await send("stream_append", id=1, text="await mark(value='duplicate')\n")
            await send("stream_finish", id=1, source="await mark(value='duplicate')\n")
            await send("exec", id=10, code="40 + 2")
            assert (await done(10))["repr"] == "42"
            await quiet()
            assert "duplicate" not in calls
            checks.append("duplicate completed source never replays")

            await send("stream_start", id=11)
            await send("stream_append", id=11, text="await mark(value='cancel-held')\n")
            held = await receive()
            assert held["t"] == "call" and held["args"]["value"] == "cancel-held", held
            calls.append("cancel-held")
            await send("stream_abort", id=11, message="source disconnected during await")
            assert "disconnected" in (await done(11, False))["error"]
            await send("result", id=held["id"], ok=True, value="late completion")
            await send("exec", id=12, code="21 * 2")
            assert (await done(12))["repr"] == "42"
            checks.append("abort during nested await unwinds and later cells remain usable")

            await send("exec", id=20, code="from importlib.metadata import version\nversion('partial-python')")
            assert (await done(20))["repr"].startswith("'0.1.")
            checks.append("real worker resolves the supported partial-python release")

            setup = """from contextlib import asynccontextmanager
from contextvars import ContextVar
scope_value = ContextVar('scope_value', default=None)
@asynccontextmanager
async def recording_scope(label):
    token = scope_value.set(label)
    await mark(value=label + ':enter')
    try:
        yield
    finally:
        assert scope_value.get() == label
        await mark(value=label + ':exit')
        scope_value.reset(token)
"""
            await send("exec", id=21, code=setup)
            await done(21)
            for exec_id, mode in ((22, "eof"), (23, "source_abort"), (24, "interrupt")):
                label = "scope-" + mode
                prefix = f"async with recording_scope({label!r}):\n    await mark(value={label!r} + ':body')\n"
                await send("stream_start", id=exec_id)
                await send("stream_append", id=exec_id, text=prefix)
                await call(label + ":enter")
                await call(label + ":body")
                await quiet()
                if mode == "eof":
                    await send("stream_finish", id=exec_id, source=prefix)
                elif mode == "source_abort":
                    await send("stream_abort", id=exec_id, message="source disconnected with open context")
                else:
                    await send("interrupt")
                await call(label + ":exit")
                await done(exec_id, mode == "eof")
                await quiet()
                assert calls.count(label + ":enter") == calls.count(label + ":body") == calls.count(label + ":exit") == 1
                checks.append(f"open async with exits once with same ContextVar on {mode}")
            await send("exec", id=25, code="assert scope_value.get() is None\n21 * 2")
            assert (await done(25))["repr"] == "42"
            checks.append("worker and persistent namespace remain usable after open-context abort")

            setup = """import asyncio
cleanup_count = 0
@asynccontextmanager
async def repeated_abort_scope():
    global cleanup_count
    try:
        yield
    finally:
        await mark(value='cleanup-wait')
        cleanup_count += 1
"""
            await send("exec", id=26, code=setup)
            await done(26)
            await send("stream_start", id=27)
            await send("stream_append", id=27, text="async with repeated_abort_scope():\n    await mark(value='before-repeated-abort')\n")
            await call("before-repeated-abort")
            await send("stream_abort", id=27, message="first abort")
            cleanup = await receive()
            assert cleanup["t"] == "call" and cleanup["args"]["value"] == "cleanup-wait", cleanup
            await send("stream_abort", id=27, message="second abort")
            await send("interrupt")
            await send("result", id=cleanup["id"], ok=True, value="cleanup finished")
            assert (await done(27, False))["error"] == "first abort"
            await send("exec", id=28, code="cleanup_count")
            assert (await done(28))["repr"] == "1"
            checks.append("repeated cancellation lets an asynchronous finalizer complete once")

            await send("stream_start", id=29)
            await send("stream_append", id=29, text="await mark(value='current-source')\n")
            await call("current-source")
            await send("stream_append", id=27, text="await mark(value='late-source')\n")
            await send("stream_abort", id=27, message="late abort")
            await send("stream_finish", id=29, source="await mark(value='current-source')\n")
            await done(29)
            await quiet()
            assert "late-source" not in calls
            checks.append("late deltas and aborts cannot affect the next source")

            await send("stream_start", id=30)
            await send("stream_append", id=30, text="#" + "界" * 700000)
            assert "oversized" in (await done(30, False))["error"]
            checks.append("UTF-8 source limit rejects multibyte overflow")

            setup = """async def delayed_disposal():
    try:
        await asyncio.sleep(3600)
    finally:
        await mark(value='dispose-held')
asyncio.create_task(delayed_disposal())
await asyncio.sleep(0)
"""
            await send("exec", id=31, code=setup)
            await done(31)
            await send("dispose")
            held = await receive()
            assert held["t"] == "call" and held["args"]["value"] == "dispose-held", held
            await send("init", tools=[])
            await send("stream_start", id=32)
            await send("stream_append", id=32, text="print('must not run')\n")
            await send("interrupt")
            assert "deferred cell cancelled" in (await done(32, False))["error"]
            await send("result", id=held["id"], ok=True, value="released")
            assert (await receive())["t"] == "ready"
            await send("stream_start", id=32)
            await send("stream_append", id=32, text="print('must not run')\n")
            await send("stream_finish", id=32, source="print('must not run')\n")
            await send("exec", id=33, code="21 * 2")
            assert (await done(33))["repr"] == "42"
            await quiet()
            checks.append("cancelled deferred source cannot replay after session replacement")
    finally:
        writer.close()
        await writer.wait_closed()
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), 5)
        except TimeoutError:
            proc.kill()
            stdout, stderr = await proc.communicate()
        assert proc.returncode == 0, (proc.returncode, stdout.decode(), stderr.decode())
    print(json.dumps({"checks": checks, "effects": calls, "passed": len(checks)}, indent=2))


asyncio.run(main())
