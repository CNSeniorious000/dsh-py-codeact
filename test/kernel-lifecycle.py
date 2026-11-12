# ruff: noqa: SLF001 — drive exact event-loop ordering through the kernel's internal protocol handler.
import asyncio
import io
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
import kernel


class MemoryKernel(kernel.Kernel):
    def __init__(self):
        with patch.object(kernel.os, "fdopen", return_value=io.BytesIO()):
            super().__init__()
        self.frames = []

    async def _send(self, frame):
        self.frames.append(frame)

    async def send(self, kind, **fields):
        if kind == "init":
            fields.setdefault("tools", [])
        await self._handle({"t": kind, "shell": "test", **fields})

    async def finish(self):
        await asyncio.gather(*self._cleanups)
        if running := self._tasks.get("test"):
            await running

    def expect(self, exec_id, **expected):
        frames = [frame for frame in self.frames if frame.get("id") == exec_id]
        assert len(frames) == 1, frames
        assert {key: frames[0][key] for key in expected} == expected, frames[0]


async def rejects_late_tasks(runner):
    loop = asyncio.get_running_loop()
    session = runner._sessions["test"]
    attempted = loop.create_future()
    effects = []

    async def helper():
        effects.append("ran")

    late_coro = helper()

    def spawn():
        try:
            attempted.set_result(asyncio.create_task(late_coro))
        except RuntimeError as error:
            attempted.set_result(str(error))

    async def background():
        try:
            await asyncio.sleep(3600)
        finally:
            # Timer handles preserve the old context even after its task finishes.
            loop.call_later(0.05, spawn)

    token = kernel._current_session.set(session)
    task = asyncio.create_task(background())
    kernel._current_session.reset(token)
    await asyncio.sleep(0)
    await runner.send("dispose")
    await runner._closing["test"]
    await runner.send("init")
    rejection = await asyncio.wait_for(attempted, 1)
    await asyncio.sleep(0)
    assert task.cancelled()
    assert runner._sessions["test"] is not session
    assert rejection == "Session is closed", (rejection, effects)
    assert effects == []
    assert late_coro.cr_frame is None, "rejection must close the unawaited coroutine"


async def preserves_replacement_cleanup(runner):
    await runner.send("dispose")
    old_cleanup = runner._closing["test"]
    # Finish disposal without running its queued done callbacks yet.
    await asyncio.sleep(0)
    assert old_cleanup.done()
    assert runner._closing["test"] is old_cleanup
    await runner.send("init")
    effects = []
    runner._sessions["test"].shell.user_ns["effects"] = effects
    await runner.send("exec", id=1, code="effects.append('ran')")
    await runner.send("dispose")
    new_cleanup = runner._closing["test"]
    # The old callback now runs while the replacement is still cleaning up.
    await asyncio.sleep(0)
    assert not new_cleanup.done()
    assert runner._closing.get("test") is new_cleanup, "old callback removed the replacement's cleanup"
    assert effects == [], "a buffered cell ran after its session closed"
    await runner.send("init")
    await runner.send("exec", id=2, code="42")
    await runner.finish()
    runner.expect(2, ok=True, repr="42")


async def interrupt_preserves_old_finalizer(runner):
    started, cleaning, release, released = (asyncio.Event() for _ in range(4))
    runner._sessions["test"].shell.user_ns.update(started=started, cleaning=cleaning, release=release, released=released)
    await runner.send("exec", id=1, code="started.set()\ntry:\n    await release.wait()\nfinally:\n    cleaning.set()\n    await release.wait()\n    released.set()")
    await started.wait()
    await runner.send("dispose")
    await cleaning.wait()
    await runner.send("init")
    await runner.send("exec", id=2, code="replacement_ran = True")
    await runner.send("interrupt")
    runner.expect(2, ok=False)
    release.set()
    await asyncio.gather(*runner._cleanups)
    assert released.is_set(), "interrupting the queued cell cancelled the old finalizer"
    assert "replacement_ran" not in runner._sessions["test"].shell.user_ns
    await runner.send("exec", id=3, code="42")
    await runner._tasks["test"]
    runner.expect(3, ok=True, repr="42")


async def deferred_init_precedes_new_exec(runner):
    gate = asyncio.Event()
    replay = runner._after_cleanup

    async def paused_replay(shell, cleanup):
        await gate.wait()
        await replay(shell, cleanup)

    runner._after_cleanup = paused_replay
    await runner.send("dispose")
    await runner.send("init", tools=[{"name": "expected", "params": []}])
    await runner._closing["test"]
    # Disposal has completed, but its replay has not received another loop turn.
    await runner.send("exec", id=1, code="import __dsh__.tools as T; sorted(dir(T))")
    gate.set()
    await runner.finish()
    runner.expect(1, ok=True, repr="['expected']")


async def cancel_during_replayed_ready(runner, action):
    ready, drain = asyncio.Event(), asyncio.Event()
    send = runner._send

    async def blocked_send(frame):
        if frame["t"] == "ready":
            ready.set()
            await drain.wait()
        await send(frame)

    runner._send = blocked_send
    effects = []
    sys.modules["__dsh__.shared"].replay_effects = effects
    await runner.send("dispose")
    await runner.send("init")
    await runner.send("exec", id=1, code="import __dsh__.shared as S; S.replay_effects.append('ran')")
    await ready.wait()
    await runner.send(action)
    drain.set()
    await runner.finish()
    runner.expect(1, ok=False, error="InterruptedError: deferred cell cancelled")
    assert effects == []
    if action == "dispose":
        assert "test" not in runner._sessions
    await runner.send("init")
    await runner.send("exec", id=2, code="42")
    await runner._tasks["test"]
    runner.expect(2, ok=True, repr="42")


async def releases_retained_session_after_last_task(runner):
    session = runner._sessions["test"]
    gates = [asyncio.Event() for _ in range(3)]

    async def background(gate, resistant):
        try:
            await asyncio.sleep(3600)
        finally:
            try:
                await gate.wait()
            except asyncio.CancelledError:
                if not resistant:
                    raise
                await gate.wait()

    token = kernel._current_session.set(session)
    tasks = [asyncio.create_task(background(gate, index != 0)) for index, gate in enumerate(gates)]
    kernel._current_session.reset(token)
    await asyncio.sleep(0)
    await runner.send("dispose")
    await runner._closing["test"]
    await asyncio.sleep(0)
    assert tasks[0].cancelled(), "the second cancellation ends the non-resistant finalizer"
    assert not tasks[1].done() and not tasks[2].done()
    await runner.send("init")
    await runner.send("exec", id=1, code="42")
    assert runner._sessions["test"] is session
    runner.expect(1, ok=False)
    gates[1].set()
    await asyncio.gather(tasks[1], return_exceptions=True)
    assert runner._sessions["test"] is session, "one old task still owns this shell"
    gates[2].set()
    await asyncio.gather(*tasks, return_exceptions=True)
    assert "test" not in runner._sessions, "finished tasks must not pin the old namespace"
    assert "test" not in runner._tasks
    await runner.send("init", tools=[{"name": "fresh", "params": []}])
    await runner.send("exec", id=2, code="import __dsh__.tools as T; sorted(dir(T))")
    await runner._tasks["test"]
    runner.expect(2, ok=True, repr="['fresh']")


async def bridge_queue_deadlines(runner):
    frames = asyncio.Queue()
    bridge = kernel.Bridge(frames.put)
    binding = kernel._make_binding(bridge, {"name": "probe", "params": []})
    with patch.object(kernel, "TOOL_CALL_TIMEOUT", 0.1):
        task = asyncio.create_task(binding())
        call_id = (await frames.get())["id"]
        bridge.progress(call_id, "queued")
        await asyncio.sleep(0.15)
        assert not task.done(), "queue time must not consume the execution deadline"
        bridge.progress(call_id, "started")
        bridge.settle(call_id, True, 42, None, None)
        assert await task == 42
        for phase in (None, "started"):
            task = asyncio.create_task(binding())
            call_id = (await frames.get())["id"]
            if phase:
                bridge.progress(call_id, phase)
                # Late/duplicate status frames must not disable an active deadline.
                bridge.progress(call_id, "queued")
            await asyncio.sleep(0.15)
            assert task.done(), "the bridge deadline must still expire"
            try:
                await task
            except TimeoutError:
                assert task.done()
            else:
                raise AssertionError("missing results must still time out")
        task = asyncio.create_task(binding())
        call_id = (await frames.get())["id"]
        bridge.progress(call_id, "queued")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled(), "queued calls must honor caller cancellation"
        await asyncio.sleep(0)
        assert not bridge._pending and not bridge._timeouts


async def binding_failures_preserve_catalogue(runner):
    original = [{"name": "mcp__old__read", "params": []}]
    await runner.send("init", tools=original)
    session = runner._sessions["test"]
    bindings, tree = session.bindings, session.mcp_tree
    effects = session.shell.user_ns["effects"] = []
    exec_id = 0
    for kind in ("exec", "stream_start"):
        for params in ([{}], [{"name": None}], [{"name": "same"}, {"name": "same"}], [{"name": "a b"}, {"name": "a b"}]):
            invalid = [{"name": "new", "params": []}, {"name": "broken", "params": params}]
            # Repeating the rejected catalogue must fail again, not hit the successful-bind cache.
            for _ in range(2):
                exec_id += 1
                await runner.send(kind, id=exec_id, tools=invalid, code="effects.append('ran')")
                runner.expect(exec_id, ok=False, stdout="", stderr="")
                assert "failed to bind tools before execution" in runner.frames[-1]["error"]
                assert session.bindings is bindings and session.mcp_tree is tree
                assert session._last_specs is original
                if kind == "stream_start":
                    # Neither late deltas nor a repeated start may revive this rejected source.
                    await runner.send("stream_start", id=exec_id)
                    await runner.send("stream_append", id=exec_id, text="effects.append('ran')\n")
                    await runner.send("stream_finish", id=exec_id, source="effects.append('ran')\n")
                await asyncio.sleep(0)
                assert effects == []
                runner.expect(exec_id, ok=False)
    revised = [{"name": "mcp__new__read", "params": [{"name": "path", "type": "str", "required": True}]}]
    await runner.send("exec", id=100, tools=revised, code="from __dsh__.tools.mcp.new import read; import inspect; print(inspect.signature(read))")
    await runner.finish()
    runner.expect(100, ok=True, stdout="(*, path: 'str') -> 'Any'\n")
    assert session._last_specs is revised and session.bindings is not bindings
    assert "mcp__old__read" not in session.bindings
    await runner.send("dispose")
    await runner.send("init", tools=original)
    await runner.send("exec", id=101, tools=invalid, code="deferred_effect = True")
    await runner.finish()
    runner.expect(101, ok=False)
    assert "deferred_effect" not in runner._sessions["test"].shell.user_ns
    assert runner._sessions["test"]._last_specs is original


async def main():
    loop = asyncio.get_running_loop()
    factory = loop.get_task_factory()
    streams = sys.stdout, sys.stderr, sys.displayhook
    loop.set_task_factory(kernel.Kernel._task_factory)
    try:
        for test, *args in (
            (binding_failures_preserve_catalogue,),
            (bridge_queue_deadlines,),
            (rejects_late_tasks,),
            (preserves_replacement_cleanup,),
            (interrupt_preserves_old_finalizer,),
            (deferred_init_precedes_new_exec,),
            (cancel_during_replayed_ready, "interrupt"),
            (cancel_during_replayed_ready, "dispose"),
            (releases_retained_session_after_last_task,),
        ):
            runner = MemoryKernel()
            await runner.send("init")
            await test(runner, *args)
            print(f"  ok   {test.__name__} {' '.join(args)}".rstrip(), file=streams[0])
    finally:
        loop.set_task_factory(factory)
        sys.stdout, sys.stderr, sys.displayhook = streams


if __name__ == "__main__":
    asyncio.run(main())
