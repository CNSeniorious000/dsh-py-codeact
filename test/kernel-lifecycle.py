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


async def main():
    loop = asyncio.get_running_loop()
    factory = loop.get_task_factory()
    streams = sys.stdout, sys.stderr, sys.displayhook
    loop.set_task_factory(kernel.Kernel._task_factory)
    try:
        await rejects_late_tasks()
        await preserves_replacement_cleanup()
        await interrupt_preserves_old_finalizer()
    finally:
        loop.set_task_factory(factory)
        sys.stdout, sys.stderr, sys.displayhook = streams
    print("  ok   disposed sessions cannot spawn tasks from delayed callbacks")
    print("  ok   old cleanup callbacks preserve replacement sessions")
    print("  ok   interrupting a queued cell preserves the old finalizer")


if __name__ == "__main__":
    asyncio.run(main())
