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


async def main():
    loop = asyncio.get_running_loop()
    factory = loop.get_task_factory()
    streams = sys.stdout, sys.stderr, sys.displayhook
    loop.set_task_factory(kernel.Kernel._task_factory)
    try:
        await rejects_late_tasks()
    finally:
        loop.set_task_factory(factory)
        sys.stdout, sys.stderr, sys.displayhook = streams
    print("  ok   disposed sessions cannot spawn tasks from delayed callbacks")


if __name__ == "__main__":
    asyncio.run(main())
