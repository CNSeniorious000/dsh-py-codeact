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


async def rejects_late_tasks():
    loop = asyncio.get_running_loop()
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "late", "tools": []})
    session = runner._sessions["late"]
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
    await runner._handle({"t": "dispose", "shell": "late"})
    await runner._closing["late"]
    await runner._handle({"t": "init", "shell": "late", "tools": []})
    rejection = await asyncio.wait_for(attempted, 1)
    await asyncio.sleep(0)
    assert task.cancelled()
    assert runner._sessions["late"] is not session
    assert rejection == "Session is closed", (rejection, effects)
    assert effects == []
    assert late_coro.cr_frame is None, "rejection must close the unawaited coroutine"


async def preserves_replacement_cleanup():
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "race", "tools": []})
    await runner._handle({"t": "dispose", "shell": "race"})
    old_cleanup = runner._closing["race"]
    # Finish disposal without running its queued done callbacks yet.
    await asyncio.sleep(0)
    assert old_cleanup.done()
    assert runner._closing["race"] is old_cleanup
    await runner._handle({"t": "init", "shell": "race", "tools": []})
    await runner._handle({"t": "exec", "shell": "race", "id": 1, "code": "import asyncio; await asyncio.sleep(3600)"})
    await runner._handle({"t": "dispose", "shell": "race"})
    new_cleanup = runner._closing["race"]
    # The old callback now runs while the replacement is still cleaning up.
    await asyncio.sleep(0)
    assert not new_cleanup.done()
    assert runner._closing.get("race") is new_cleanup, "old callback removed the replacement's cleanup"
    await runner._handle({"t": "init", "shell": "race", "tools": []})
    await runner._handle({"t": "exec", "shell": "race", "id": 2, "code": "42"})
    await asyncio.gather(*runner._cleanups)
    await runner._tasks["race"]
    result = next(frame for frame in runner.frames if frame.get("id") == 2)
    assert result["ok"], result
    assert result["repr"] == "42"


async def interrupt_preserves_old_finalizer():
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "interrupt", "tools": []})
    started, cleaning, release, released = (asyncio.Event() for _ in range(4))
    runner._sessions["interrupt"].shell.user_ns.update(started=started, cleaning=cleaning, release=release, released=released)
    await runner._handle(
        {
            "t": "exec",
            "shell": "interrupt",
            "id": 1,
            "code": "started.set()\ntry:\n    await release.wait()\nfinally:\n    cleaning.set()\n    await release.wait()\n    released.set()",
        }
    )
    await started.wait()
    await runner._handle({"t": "dispose", "shell": "interrupt"})
    await cleaning.wait()
    await runner._handle({"t": "init", "shell": "interrupt", "tools": []})
    await runner._handle({"t": "exec", "shell": "interrupt", "id": 2, "code": "replacement_ran = True"})
    await runner._handle({"t": "interrupt", "shell": "interrupt"})
    cancelled = [frame for frame in runner.frames if frame.get("id") == 2]
    assert len(cancelled) == 1 and not cancelled[0]["ok"], cancelled
    release.set()
    await asyncio.gather(*runner._cleanups)
    assert released.is_set(), "interrupting the queued cell cancelled the old finalizer"
    assert "replacement_ran" not in runner._sessions["interrupt"].shell.user_ns
    await runner._handle({"t": "exec", "shell": "interrupt", "id": 3, "code": "42"})
    await runner._tasks["interrupt"]
    result = next(frame for frame in runner.frames if frame.get("id") == 3)
    assert result["ok"], result
    assert result["repr"] == "42"


async def deferred_init_precedes_new_exec():
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "catalogue", "tools": []})
    gate = asyncio.Event()
    replay = runner._after_cleanup

    async def paused_replay(shell, cleanup):
        await gate.wait()
        await replay(shell, cleanup)

    runner._after_cleanup = paused_replay
    await runner._handle({"t": "dispose", "shell": "catalogue"})
    await runner._handle({"t": "init", "shell": "catalogue", "tools": [{"name": "expected", "params": []}]})
    await runner._closing["catalogue"]
    # Disposal has completed, but its replay has not received another loop turn.
    await runner._handle({"t": "exec", "shell": "catalogue", "id": 1, "code": "import __dsh__.tools as T; sorted(dir(T))"})
    gate.set()
    await asyncio.gather(*runner._cleanups)
    await runner._tasks["catalogue"]
    result = next(frame for frame in runner.frames if frame.get("id") == 1)
    assert result["ok"], result
    assert result["repr"] == "['expected']", result


async def cancel_during_replayed_ready(action):
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "backpressure", "tools": []})
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
    await runner._handle({"t": "dispose", "shell": "backpressure"})
    await runner._handle({"t": "init", "shell": "backpressure", "tools": []})
    await runner._handle({"t": "exec", "shell": "backpressure", "id": 1, "code": "import __dsh__.shared as S; S.replay_effects.append('ran')"})
    await ready.wait()
    await runner._handle({"t": action, "shell": "backpressure"})
    drain.set()
    await asyncio.gather(*runner._cleanups)
    if running := runner._tasks.get("backpressure"):
        await running
    cancelled = [frame for frame in runner.frames if frame.get("id") == 1]
    assert len(cancelled) == 1 and cancelled[0].get("error") == "InterruptedError: deferred cell cancelled", cancelled
    assert effects == []
    if action == "dispose":
        assert "backpressure" not in runner._sessions
    await runner._handle({"t": "init", "shell": "backpressure", "tools": []})
    await runner._handle({"t": "exec", "shell": "backpressure", "id": 2, "code": "42"})
    await runner._tasks["backpressure"]
    assert next(frame for frame in runner.frames if frame.get("id") == 2)["repr"] == "42"


async def releases_retained_session_after_last_task():
    runner = MemoryKernel()
    await runner._handle({"t": "init", "shell": "retained", "tools": []})
    session = runner._sessions["retained"]
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
    await runner._handle({"t": "dispose", "shell": "retained"})
    await runner._closing["retained"]
    await asyncio.sleep(0)
    assert tasks[0].cancelled(), "the second cancellation ends the non-resistant finalizer"
    assert not tasks[1].done() and not tasks[2].done()
    await runner._handle({"t": "init", "shell": "retained", "tools": []})
    await runner._handle({"t": "exec", "shell": "retained", "id": 1, "code": "42"})
    assert runner._sessions["retained"] is session
    assert not next(frame for frame in runner.frames if frame.get("id") == 1)["ok"]
    gates[1].set()
    await asyncio.gather(tasks[1], return_exceptions=True)
    assert runner._sessions["retained"] is session, "one old task still owns this shell"
    gates[2].set()
    await asyncio.gather(*tasks, return_exceptions=True)
    assert "retained" not in runner._sessions, "finished tasks must not pin the old namespace"
    assert "retained" not in runner._tasks
    await runner._handle({"t": "init", "shell": "retained", "tools": [{"name": "fresh", "params": []}]})
    await runner._handle({"t": "exec", "shell": "retained", "id": 2, "code": "import __dsh__.tools as T; sorted(dir(T))"})
    await runner._tasks["retained"]
    result = next(frame for frame in runner.frames if frame.get("id") == 2)
    assert result["ok"], result
    assert result["repr"] == "['fresh']"


async def main():
    loop = asyncio.get_running_loop()
    factory = loop.get_task_factory()
    streams = sys.stdout, sys.stderr, sys.displayhook
    loop.set_task_factory(kernel.Kernel._task_factory)
    try:
        await rejects_late_tasks()
        await preserves_replacement_cleanup()
        await interrupt_preserves_old_finalizer()
        await deferred_init_precedes_new_exec()
        for action in ("interrupt", "dispose"):
            await cancel_during_replayed_ready(action)
        await releases_retained_session_after_last_task()
    finally:
        loop.set_task_factory(factory)
        sys.stdout, sys.stderr, sys.displayhook = streams
    print("  ok   disposed sessions cannot spawn tasks from delayed callbacks")
    print("  ok   old cleanup callbacks preserve replacement sessions")
    print("  ok   interrupting a queued cell preserves the old finalizer")
    print("  ok   deferred initialization stays ordered and cancellable during replay")
    print("  ok   retained sessions are released after their last task ends")


if __name__ == "__main__":
    asyncio.run(main())
