#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "ipython~=9.18.1",
#     "objprint~=0.3.0",
#     "partial-python~=0.1.0",
# ]
# # Checked with `TY_UV=scripts ty check py/kernel.py` — that prefix is what hands ty this script's venv. A `ty.toml` would be found and then silently ignored for PEP 723 scripts (astral-sh/ty#4083), so any ty config has to live here.
# ///

"""Persistent IPython kernel for the dsh CodeAct REPL tool.

Each DSH session owns one long-lived process and `InteractiveShell`. Its namespace survives between cells, retaining IPython magics, history and introspection. DSH also supports persistent PTC runtimes; this kernel is exposed through an ordinary tool plugin.

Whole cells run through `InteractiveShell.run_cell_async`, which carries magics, top-level `await`, `store_history` (`_`, `Out[n]`), and IPython's own traceback formatter. Structure and the LLM-specific touches (redundant-import hints, objprint reprs) follow `CNSeniorious000/temporary-mcp-servers:ipython-mcp.py`.

Streaming cells use `partial_python.Executor` in one owner task. They share the namespace but bypass IPython transformations, history and expression echo. Only a matching successful source finish supplies EOF.

Wire protocol: JSON-lines on the inherited control channel (fd 7 under DSH, fd 3 standalone). stdout/stderr stay free for native writes.

Every frame but `call_state`, `result` and `shutdown` carries `shell` — the session whose shell it addresses, defaulting to "main". The host starts a separate process for each session, including delegated subagents.

  host  -> child  {"t":"init","shell":S,"tools":[{"name","doc","returns","params":[...]}]}
                  {"t":"exec","id":N,"shell":S,"code":"...","tools":[...]}
                  {"t":"stream_start","id":N,"shell":S,"tools":[...]}
                  {"t":"stream_append","id":N,"shell":S,"text":"..."}
                  {"t":"stream_finish","id":N,"shell":S,"source":"..."}
                  {"t":"stream_abort","id":N,"shell":S,"message":"..."}
                  {"t":"call_state","id":N,"phase":"queued"|"started"}
                  {"t":"result","id":N,"ok":true,"value":<json>}
                  {"t":"result","id":N,"ok":false,"tool":"read","message":"..."}
                  {"t":"interrupt","shell":S} | {"t":"dispose","shell":S} | {"t":"shutdown"}
  child -> host   {"t":"ready","shell":S,"env":{"executable","version","prefix","venv","cwd"}}
                  {"t":"call","id":N,"name":"read","args":{...}}
                  {"t":"done","id":N,"shell":S,"ok":bool,"stdout","stderr","repr","error","note"}

`id` namespaces are per frame type: an exec id and a call id never collide because each is only matched against frames of the same kind."""

import os

# No TTY here, so `get_terminal_size()` falls back to a cramped 80x24 and wraps tracebacks and pretty output far narrower than the harness renders at.
os.environ.setdefault("COLUMNS", "456")
os.environ.setdefault("LINES", "123")

# We run in a throwaway venv so `!uv pip install` cannot leak into the shared PEP 723 environment (or the user's project venv). That venv has none of our dependencies, so borrow the base environment's packages — BEFORE the IPython import below, and APPENDED, so anything installed into the throwaway venv shadows the inherited copy rather than the other way round.
if _inherited := os.environ.get("DSH_CODEACT_INHERIT_SITE"):
    import site

    for _directory in _inherited.split(os.pathsep):
        site.addsitedir(_directory)

# These sit below the two blocks above on purpose: COLUMNS/LINES must be set before IPython reads the terminal size, and the inherited site-packages must be on the path before IPython is imported at all.
import asyncio
import atexit
import contextlib
import inspect
import io
import json
import keyword
import shutil
import subprocess
import sys
import tempfile
import traceback
import types
from contextvars import ContextVar, copy_context
from dataclasses import dataclass, field
from dis import get_instructions
from functools import lru_cache, wraps
from inspect import isclass
from pathlib import Path

from IPython.core.interactiveshell import InteractiveShell
from IPython.lib.pretty import pretty
from objprint import ObjPrint
from traitlets.config import Config

# DSH's managed subprocess control channel uses fd 7; standalone launches retain fd 3.
PROTOCOL_FD = 7 if os.environ.pop("DSH_SUBPROCESS_CONTROL", None) == "pipe" else 3

# Wire default for the `shell` field. The JS host holds its own copy of this literal — the seam is the one place the two languages must agree by hand.
DEFAULT_SHELL = "main"

# Bound BEFORE any `redirect_stderr` can swap `sys.stderr`. IPython writes its traceback out itself; sending that copy here (the process's real stderr, which the host keeps only for crash diagnostics) keeps ANSI escapes and a duplicate traceback out of the cell's captured stderr. The model-facing copy is re-rendered without color by `Session.format_exc`.
REAL_STDERR = sys.stderr

# `uv pip install <pkg>` inside a cell has to know WHICH environment to install into. The harness spawns us with an allowlisted environment that deliberately drops VIRTUAL_ENV, and without it uv refuses outright — while IPython's `!cmd` does not fail on a non-zero exit, so the cell reports success and the import fails a cell later, with nothing connecting the two.
if sys.prefix != sys.base_prefix:
    os.environ.setdefault("VIRTUAL_ENV", sys.prefix)

# The host deletes this throwaway venv when it disposes the kernel, but a harness that is signalled or crashes never reaches that point — while the kernel it leaves behind still exits cleanly on EOF, which is the last moment anyone owns the directory. `DSH_CODEACT_INHERIT_SITE` is set on exactly the path where the host built one, and the name prefix keeps this off a venv that is not ours (`config.python`, `ephemeralEnv: false`).
if os.environ.get("DSH_CODEACT_INHERIT_SITE") and Path(sys.prefix).name.startswith("dsh-py-codeact-"):
    atexit.register(shutil.rmtree, sys.prefix, ignore_errors=True)

# ── the execution fence can take the terminal away ───────────────────────────
# A pty is a device node, and creating one opens `/dev/ptmx` for WRITING. `read-only` and `workspace-write` fence this
# process with `(allow default) (deny file-write*)` plus the workspace and temp roots, so that open returns EPERM and
# `pty.openpty()` degrades through the legacy `/dev/pty*` scan to the misleading `OSError: out of pty devices`. `!cmd` has
# no use for a terminal — but IPython's default `system` is `system_piped`, and `system_piped` spawns through pexpect,
# whose entire design is "the child runs on a pty". So every `!cmd` cell dies before its command starts, pointing at
# IPython rather than at the fence. Probe once here and, when there is no pty to be had, hand each shell a pipe runner.


def _pty_available() -> bool:
    try:
        master, slave = os.openpty()
    # Windows has no `os.openpty` at all, and under a fence the open itself fails — neither may abort the import.
    except (AttributeError, OSError):
        return False
    os.close(master)
    os.close(slave)
    return True


PTY_AVAILABLE = _pty_available()


def _pipe_system(shell):
    """`system_piped` without the terminal: the same `{var}` expansion, merged streams, `_exit_code` and raise contract, but the child runs on pipes, so its output streams into the cell instead of vanishing into a pty this process cannot open. Returning None matters — `!cmd` is the cell's transformed expression, and any non-None return would be echoed back as the cell's value."""

    def system(cmd: str) -> None:
        # A backgrounded child inherits the pipe, so the read loop below would block until IT exits — the same reason IPython's own `system_piped` refuses these.
        if cmd.rstrip().endswith("&"):
            raise OSError("Background processes not supported.")
        with subprocess.Popen(shell.var_expand(cmd, depth=1), shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace") as process:
            output = process.stdout
            assert output is not None  # stdout=PIPE always supplies the stream.
            for chunk in iter(lambda: output.read(8192), ""):
                sys.stdout.write(chunk)
            sys.stdout.flush()
            returncode = process.wait()
        shell.user_ns["_exit_code"] = returncode
        if shell.system_raise_on_error and returncode != 0:
            raise subprocess.CalledProcessError(returncode, cmd)

    return system


# `uv`'s cache defaults to `~/.cache/uv`, outside every writable root above, so a fenced `!uv pip install` dies at `Could not acquire lock … Operation not permitted` before resolving a single package. Point it somewhere writable when the default is not — but this runs at import, so every step of it has to be fail-soft: `tempfile.gettempdir()` is not a getter, it PROBES candidates by creating a file and raises `FileNotFoundError` when none is usable, which in a read-only session kills the kernel before it can say why. Read `TMPDIR` for the fallback's home instead: both it and `/tmp` are writable roots, the host forwards `TMPDIR` deliberately, and reading it needs no probe. Do NOT hang it off `sys.prefix` — with an explicit `command` that is the user's own venv and we would create a cache inside their project. Name it into the host's own pid-tagged namespace (`dsh-py-codeact-<harness pid>-…`, the one its venvs already use) so the sweep the host runs on a cold start reclaims it; a plain name would sit in the OS temp dir forever, since that sweep only ever matches a pid-tagged entry. That sweep sits behind the same early return as the venv, so a kernel configured with an explicit `command` is never swept — the OS temp cleanup is what bounds it there.


def _writable_directory(directory: Path) -> bool:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        descriptor, probe = tempfile.mkstemp(dir=directory)
    except OSError:
        return False
    os.close(descriptor)
    Path(probe).unlink()
    return True


def _uv_cache_directory() -> Path:
    """Where `uv` puts its cache when left alone: `UV_CACHE_DIR` is handled by the caller, then the XDG cache dir, then `~/.cache`."""
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "uv"


if "UV_CACHE_DIR" not in os.environ and not _writable_directory(_uv_cache_directory()):
    _uv_cache = Path(os.environ.get("TMPDIR") or "/tmp") / f"dsh-py-codeact-{os.getppid()}-uv-cache"
    # Nothing is writable in a read-only session, and an install there is a contradiction anyway — leave uv's own error rather than failing at import.
    if _writable_directory(_uv_cache):
        os.environ["UV_CACHE_DIR"] = str(_uv_cache)

# Cap one cell's captured output. The host caps the whole result again; this only stops a runaway loop from exhausting memory before the host sees it.
MAX_STREAM_BYTES = 1 << 20


class ToolCallError(Exception):
    """Raised inside cell code when a bridged tool call fails.

    Carries only `tool_name` and the message: harness-internal error codes and Native content deliberately stay outside the program-visible contract."""

    def __init__(self, tool_name: str, message: str) -> None:
        super().__init__(message)
        self.tool_name: str = tool_name


# ── model-facing repr ────────────────────────────────────────────────────────


class CustomObjectPrinter(ObjPrint):
    """Readable structure for objects whose own repr says nothing."""

    def _objstr(self, obj, memo, indent_level, cfg):
        cfg.attr_pattern = "(?!^__.*__$).*"
        if isclass(obj):
            return repr(obj)
        if type(obj).__repr__ is object.__repr__:
            # objprint does its cycle/depth bookkeeping in `_objstr`, immediately before dispatching. Jumping straight to `_get_custom_object_str` skips it, and `_get_custom_object_str` calls back into `_objstr` per attribute — so any self-referential object with a default repr (a tree node with `.parent`, a doubly-linked list) recurses until the stack blows. Mirror the guard rather than lose the unpacking.
            if (memo is not None and id(obj) in memo) or (cfg.depth is not None and indent_level >= cfg.depth):
                return self._get_ellipsis(obj, cfg)
            if memo is not None:
                memo = memo.copy()
                memo.add(id(obj))
            return self._get_custom_object_str(obj, memo, indent_level, cfg)
        if callable(obj):
            return pretty(obj, verbose=True, max_width=320)
        return super()._objstr(obj, memo, indent_level, cfg)


_objstr = CustomObjectPrinter().objstr


def safe_render(value) -> str:
    # A raising `__repr__` is ordinary in data work — a half-initialised ORM row, a mock, a lazy proxy whose fetch failed. Unguarded it escapes into `_exec`'s blanket handler, which answers with hardcoded empty `stdout`/`stderr`: the cell's real output is thrown away and a run that actually succeeded is reported as a kernel fault. Tell the model whose repr broke instead; everything else about the cell is intact.
    try:
        return render_value(value)
    except Exception as error:  # noqa: BLE001
        return f"<{type(value).__name__} object: its __repr__ raised {type(error).__name__}: {error}>"


def render_value(value) -> str:
    # No cap here. dsh's own `spill-policy` bounds the finished tool result: it saves the full text to the session's spill store and leaves the model a head/tail preview plus the path to `read` or `grep`. A cap here would run first and destroy those bytes before anything could store them — and it never saved memory either, since `_objstr` materializes the whole string before any cap could apply.
    return _objstr(value)


# ── redundant-import hints ───────────────────────────────────────────────────

_redundant_imports: ContextVar = ContextVar("dsh_codeact_redundant_imports", default=None)

# Which Session the currently running cell belongs to.
#
# Route process-wide stdout, displayhook and tools through the current cell. ContextVars also follow tasks created by the cell, preserving their ownership after it returns.
_current_session: ContextVar = ContextVar("dsh_codeact_session", default=None)


class HintingNamespace(dict):
    """Records names an `import` rebinds to the *same* object.

    A model driving a persistent REPL routinely forgets what it already imported; telling it so is cheaper than letting it re-import every cell. cpython#121306: top-level `STORE_NAME` routes through `__setitem__` for dict subclasses (a function body's `STORE_GLOBAL` does not — function-local imports never pollute the session namespace anyway)."""

    def __setitem__(self, key, value):
        if key in self and self[key] is value and (redundant := _redundant_imports.get()) is not None:
            # `PyObject_SetItem` is C, so there is no Python frame between us and the cell: `_getframe(1)` IS the cell. Match IMPORT_NAME/IMPORT_FROM -> STORE_NAME at f_lasti to skip coincidental rebinds (`x = x`).
            caller = sys._getframe(1)  # noqa: SLF001
            if caller.f_lasti in _import_stores(caller.f_code):
                redundant.append(key)
        super().__setitem__(key, value)


@lru_cache(maxsize=128)
def _import_stores(code) -> frozenset:
    """Offsets in `code` where a STORE_NAME follows an import — i.e. the only places the hint above can fire.

    Cached per code object because the alternative re-disassembled the WHOLE cell on every top-level rebind of a name to the same object. `True`, `None` and small ints are interned, so an ordinary `for x in [None] * 20000: y = x` at top level hits that path every iteration: measured 771 ms against 0.1 ms for byte-identical work inside a function body (where `STORE_FAST` never reaches `__setitem__`), and it produced no hint at all — the entire cost was waste. Cells are compiled fresh, so this is keyed on an object that is never reused with different bytecode."""
    offsets = set()
    previous = None
    for instruction in get_instructions(code):
        if instruction.opname == "STORE_NAME" and previous is not None and previous.opname in ("IMPORT_NAME", "IMPORT_FROM"):
            offsets.add(instruction.offset)
        previous = instruction
    return frozenset(offsets)


def format_import_hint(keys):
    if not (keys := list(dict.fromkeys(keys))):  # dedupe, preserve order
        return None
    quoted = [f"`{key}`" for key in keys]
    if len(quoted) == 1:
        return f"{quoted[0]} is already imported in this session — no need to re-import it."
    return f"{', '.join(quoted[:-1])} and {quoted[-1]} are already imported in this session — no need to re-import them."


# ── tool bridge ──────────────────────────────────────────────────────────────


TOOL_CALL_TIMEOUT = 660


class Bridge:
    """Outbound tool dispatch: one pending future per in-flight call."""

    def __init__(self, send) -> None:
        self._send = send
        self._pending: dict = {}
        self._timeouts: dict[int, tuple[asyncio.Timeout, bool]] = {}
        self._next = 0
        self._sends: set = set()  # hold fire-and-forget send tasks so the GC cannot drop a `call` frame mid-flight

    def call(self, name: str, args, timeout: asyncio.Timeout | None = None):
        self._next += 1
        call_id = self._next
        future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        if timeout is not None:
            self._timeouts[call_id] = (timeout, False)
        # Keep the originating shell on bridged calls, including calls from detached tasks: create_task snapshots this ContextVar.
        session = _current_session.get()

        # `_send` is async (it yields to the loop while the fd-3 buffer drains), but `call` stays sync so the binding can `return await bridge.call(...)` and hand the cell the Future itself to await — `await` on a coroutine that returned a Future would hand the cell a pending Future instead of its resolved value. A `call` frame is tiny, so fire it as a task: it runs immediately and only yields if the buffer is full, never blocking the caller. If `_send` itself raises (e.g. json.dumps hitting a raising __str__), fail the call instead of hanging the awaiter — the future's done callback then pops `_pending`.
        async def _send_call():
            try:
                await self._send({"t": "call", "id": call_id, "shell": None if session is None else session.shell_id, "name": name, "args": args})
            except Exception as exc:  # noqa: BLE001 - _send is host-provided; any failure must not leak the future
                if not future.done():
                    future.set_exception(exc)

        context = copy_context()
        context.run(_current_session.set, None)  # Protocol writes must finish even when their owning session closes.
        send = asyncio.create_task(_send_call(), context=context)
        send.add_done_callback(self._sends.discard)
        self._sends.add(send)

        # One done callback for both jobs. Popping `_pending` is the leak safety net: if the host never replies, or `_send` raised and we failed the future ourselves, or a `wait_for` timeout cancelled it, the entry still leaves. Cancelling `send` is the side-effect one: a cancelled or timed-out call whose frame has not gone out yet must not reach the host at all, or the tool runs and its side effects land after the cell already reported the call as cancelled. A frame mid-write is past that point — `_send` holds the lock and shields the drain wait, so it finishes the line rather than splicing the next frame onto a stump.
        def finish(_):
            self._pending.pop(call_id, None)
            self._timeouts.pop(call_id, None)
            send.cancel()

        future.add_done_callback(finish)
        return future

    def progress(self, call_id, phase) -> None:
        future = self._pending.get(call_id)
        state = self._timeouts.get(call_id)
        if future is None or future.done() or state is None:
            return
        timeout, started = state
        if timeout.expired() or started:
            return
        if phase == "queued":
            timeout.reschedule(None)
        elif phase == "started":
            timeout.reschedule(asyncio.get_running_loop().time() + TOOL_CALL_TIMEOUT)
            self._timeouts[call_id] = (timeout, True)

    def settle(self, call_id, ok, value, tool, message) -> None:
        future = self._pending.pop(call_id, None)
        if future is None or future.done():
            return  # late or duplicate reply — drop, never throw
        if ok:
            future.set_result(value)
        else:
            future.set_exception(ToolCallError(tool or "?", message or "tool call failed"))


def _make_binding(bridge: Bridge, spec):
    """One tool as a real `async def`: dsh's description becomes its docstring and its parameters become a keyword-only signature, so `read?`, `help(read)`, and tab-completion all work inside the REPL. The annotations arrive pre-rendered from the host, which projects them with dsh's own `jsonSchemaToPy` — no second mapper to drift out of sync."""
    name = spec["name"]

    # A parameter name travels to the tool as a JSON key, so a renamed one has to travel back: the block spells `file_path` and `from_`, the tool still expects `file-path` and `from`. A raw key passed straight through is left alone, which is what a cell written before the rename does.
    renames = {p["name"]: p["raw"] for p in spec.get("params") or [] if p.get("raw")}

    async def call(**kwargs):
        # Keep an orphan-result deadline above the documented 600s delegation budget. An explicit
        # host queue receipt suspends it until execution starts; caller/cell cancellation still applies.
        async with asyncio.timeout(TOOL_CALL_TIMEOUT) as timeout:
            return await bridge.call(name, {renames.get(key, key): value for key, value in kwargs.items()} if renames else kwargs, timeout)

    call.__name__ = name if name.isidentifier() else "call"
    call.__qualname__ = f"__dsh__.tools.{name}"
    call.__doc__ = spec.get("doc") or None
    # The same prose the block renders beside each parameter, repeated here so `read?` is not the poorer view: the block is read once a turn, while `?` is what a model reaches for to re-check ONE tool without scrolling back. Same source, so the two cannot drift.
    documented = [p for p in spec.get("params") or [] if p.get("doc")]
    if documented:
        # Continuation lines indented, or a description carrying its own newlines reads as the next parameter's.
        section = "Parameters:\n" + "\n".join(f"    {p['name']}: {p['doc'].replace(chr(10), chr(10) + '        ')}" for p in documented)
        call.__doc__ = f"{call.__doc__}\n\n{section}" if call.__doc__ else section
        # A rebind builds NEW callables, so a name already pulled out with `from __dsh__.tools import read` keeps the docstring it was imported with. `__dsh__.tools.read?` is the authoritative view after a schema revision. True of the signature and return annotation too, and deliberate: the shell's namespace is the model's, and a rebind that reached into it could swap a binding under a cell mid-await.
    # Keep valid parameters visible; only names Python cannot spell belong in **kwargs. Malformed specs must reject the catalogue.
    params, dropped, names = [], [], set()
    for p in spec.get("params") or []:
        param_name = p["name"]
        if param_name in names:
            raise ValueError(f"duplicate parameter name: {param_name!r}")
        names.add(param_name)
        try:
            params.append(
                inspect.Parameter(
                    param_name,
                    inspect.Parameter.KEYWORD_ONLY,
                    annotation=p.get("type") or "Any",
                    default=inspect.Parameter.empty if p.get("required") else ...,
                )
            )
        except ValueError:
            dropped.append(p)
    if dropped:
        overflow = "kwargs"
        while any(p.name == overflow for p in params):
            overflow = f"_{overflow}"
        params.append(inspect.Parameter(overflow, inspect.Parameter.VAR_KEYWORD, annotation="Any"))
        section = "Pass as dict keys: " + ", ".join(f"{p['name']!r}: {p.get('type') or 'Any'}{'' if p.get('required') else ' = ...'}" for p in dropped)
        call.__doc__ = f"{call.__doc__}\n\n{section}" if call.__doc__ else section
    # Duplicate or malformed parameters must fail the rebind, not silently discard the tool's signature.
    call.__signature__ = inspect.Signature(params, return_annotation=spec.get("returns") or "Any")  # type: ignore
    return call


def bound_tools() -> dict:
    """The calling shell's catalogue, or nothing outside a cell."""
    session = _current_session.get()
    return {} if session is None else session.bindings


class ToolsModule(types.ModuleType):
    """`__dsh__.tools` — the bridged tool surface of the CALLING shell.

    Bindings live on the Session and each lookup routes through the current cell, so restrictions and tool changes take effect without replacing the imported module."""

    # A class attribute, not an instance one: normal lookup finds it before `__getattr__` ever runs, and the `__setattr__` guard below cannot touch the class body. `ToolCallError` is a harness-provided exception type the model is told to catch, not a tool binding.
    ToolCallError = ToolCallError

    def __init__(self) -> None:
        super().__init__("__dsh__.tools", "Harness tools, bridged into this session as awaitables.")
        self.__path__ = []  # a package, so `__dsh__.tools.mcp` resolves under it

    def __getattr__(self, name):  # only reached when the attribute is absent
        if name.startswith("__"):
            raise AttributeError(name)  # import/introspection probing — never answer with a tool
        bindings = bound_tools()
        if name in bindings:
            return bindings[name]
        # The shown listing, not the bound one: a typo used to push the whole flat catalogue into
        # the trajectory at the one moment the model is guaranteed to be reading it.
        available = ", ".join(sorted(listed_tools())) or "(none)"
        raise AttributeError(f"no such tool: {name!r}. Available: {available}")

    def __setattr__(self, name, value):
        # A write would shadow the tool invisibly to dir(), which still reports the harness catalogue.
        if not (name.startswith("__") and name.endswith("__")):
            raise AttributeError("__dsh__.tools belongs to the harness — bind your own name instead of writing to it")
        super().__setattr__(name, value)

    def __dir__(self):
        return sorted(listed_tools())

    # NOT `listed_tools()`: `__all__` is what `from __dsh__.tools import *` BINDS, and narrowing it
    # left `mcp__gh__ok` undefined in a cell that used to work. Display is `__dir__`'s job.
    #
    # `ToolCallError` is here and in no listing, for the same reason: it is not a tool, so showing it
    # among them would be noise — but the instructions tell the model to catch it, and a cell that
    # reached for `import *` instead of the block's import line lost the failure path it was told to
    # handle, to a `NameError` raised from inside the `except` clause meant to explain the failure.
    @property
    def __all__(self):
        return sorted([*bound_tools(), "ToolCallError"])

    def __repr__(self) -> str:
        # The cell's trailing expression is echoed back, so ending on `__dsh__.tools` is the
        # cheapest "what do I have" move there is — and it used to re-emit the whole flat catalogue.
        return f"<module '__dsh__.tools': {', '.join(sorted(listed_tools())) or 'no tools bound'}>"


MCP_PREFIX = "mcp__"


def split_mcp(name: str) -> tuple[str, str] | None:
    """`mcp__calendar__list_events` -> `("calendar", "list_events")`.

    dsh names every MCP tool `mcp__<serverName>__<rawName>`, and a raw name may itself contain
    `__` — `split("__")` would tear such a tool apart and file it under a server that does not
    exist, so only the first two separators are ever consumed.

    PRESENTATION ONLY. dsh's own naming contract says the public name "is never parsed to recover"
    the raw one, and it is right: a name that needed normalizing, or that ran past 64 characters,
    becomes `<truncated>_<12 hex of sha256>`, and the cut can land anywhere — including before the
    second `__`. That case returns `None` here and the tool simply stays flat, reachable under its
    full public name, which is the only name dispatch ever uses.
    """
    if not name.startswith(MCP_PREFIX):
        return None
    server, sep, raw = name[len(MCP_PREFIX) :].partition("__")
    return (server, raw) if sep and server and raw else None


def servable(name: str) -> tuple[str, str] | None:
    """`(server, tool)` when `mcp.<server>.<tool>` can actually ANSWER, else `None`.

    Not `split_mcp` alone. Two ways a name splits cleanly and the grouping still cannot serve it:
    `McpModule.__getattr__` refuses a true dunder — import and introspection probing (`__path__`,
    `__all__`, `__spec__`) all wear that shape — and dsh hashes a public name that needed
    normalising, where the cut can land before the second `__` and `split_mcp` returns `None`.

    The one predicate for the whole file, because the listing and the lookup have to agree: hiding
    a flat name on the strength of the split alone left `mcp__gh____weird__` in no listing the
    model ever reads, while `mcp.gh.__weird__` raised `AttributeError`.
    """
    parts = split_mcp(name)
    if parts is None or (parts[1].startswith("__") and parts[1].endswith("__")):
        return None
    return parts


def listed_tools() -> dict:
    """What the model is SHOWN: `dir()`, `repr()`, and the `Available:` list of a failed lookup.

    Not `__all__` — that is the star-import BINDING contract, and narrowing it unbound every flat
    name from `from __dsh__.tools import *`, which is a regression on running code rather than a
    quieter listing.

    Every flat `mcp__server__tool` name stays bound; showing them contradicted the prompt block,
    which stopped printing them. Of 103 entries 86 were flat MCP names, and a model asked to
    introspect its own tools filtered them out by hand. A name the grouping cannot serve stays
    shown — it is then the only name that works.
    """
    return {name: call for name, call in bound_tools().items() if servable(name) is None}


def spellable(raw: str) -> str | None:
    """The name Python can take for `raw`, or `None` when `raw` already is one.

    dsh normalises a tool name over `[A-Za-z0-9_-]`, so `-` survives — and `-` is legal in no Python
    identifier. `API-patch-block-children` was therefore reachable only as
    `getattr(mcp.notion, "API-patch-block-children")`, at every call site, with no signature in the
    prompt block to go with it; it was the single most-dispatched tool of a 20-task benchmark run,
    and 4.0% of all dispatches went to twelve tools shaped like it.

    Only `-` is folded. A keyword (`class`) or a digit-leading name (`123tool`) is unspellable for
    reasons no substitution fixes, and inventing a spelling for those would mean inventing a name.
    """
    folded = raw.replace("-", "_")
    # `isidentifier()` alone is not the host's rule: it accepts keywords, and the block's
    # `isUsableName` refuses them. A raw `-` folds to `_`, a SOFT keyword — the kernel would have
    # bound and listed `mcp.srv._` while the block routed the same tool to `getattr(mcp.srv, "-")`.
    # The two halves have to agree on what is spellable; the suite checks that they do.
    if folded == raw or not folded.isidentifier() or keyword.iskeyword(folded) or keyword.issoftkeyword(folded):
        return None
    return folded


def mcp_servers(bindings: dict) -> dict[str, dict]:
    """Group the flat `mcp__server__tool` bindings into `{server: {tool: call}}`.

    The flat names stay bound too. They are what dsh dispatches on and what an older session may
    already have imported; dropping them to tidy the surface would break a cell mid-conversation.

    A hyphenated raw name is reachable under BOTH spellings: its own, so an existing
    `getattr(mcp.srv, "a-b")` keeps working, and its folded alias, which is what the listings show.
    The alias never displaces a real tool — a server exposing both `a-b` and `a_b` keeps `a_b`
    meaning `a_b`, and `a-b` stays getattr-only rather than quietly answering for its neighbour.
    """
    servers: dict[str, dict] = {}
    for name, call in bindings.items():
        if (parts := split_mcp(name)) is not None:
            servers.setdefault(parts[0], {})[parts[1]] = call
    for tools in servers.values():
        alias(tools)
    alias(servers)
    return servers


def alias(members: dict) -> None:
    """Add each hyphenated key's folded spelling, in place, without displacing a real one.

    `setdefault`, so a name that already exists keeps its own value: a server exposing `a-b` beside
    `a_b` gets no alias for `a-b`, and both stay reachable under their own spellings.
    """
    for raw in list(members):  # a snapshot: `setdefault` below adds the folds mid-loop
        if (fold := spellable(raw)) is not None:
            members.setdefault(fold, members[raw])


def canonical(server: str, servers: dict) -> str:
    """The module name for `server`: its fold, unless another server already owns that spelling.

    Folding unconditionally made `a-b` and `a_b` ONE module — `mcp_server_module` is keyed by name,
    so both root entries resolved to the fold's module and the hyphenated server's tools became
    unreachable, through either spelling. This is the same rule the tool level applies by identity,
    stated directly because a server's value here is a module built on demand, not a shared callable.
    """
    folded = spellable(server)
    return server if folded is None or servers.get(folded) is not servers.get(server) else folded


def listed(members: dict) -> dict:
    """What a listing SHOWS: the folded spelling stands in for the name it was folded from.

    The same split as `bound_tools` / `listed_tools` one level up, for the same reason — showing
    both spellings would report twice as many tools as the server has, and showing only the raw one
    would name something the model cannot type.
    """
    # Identity, not membership: `alias` maps a fold to the SAME callable, so `members[fold] is value`
    # is what distinguishes a name's own alias from a DIFFERENT tool that happens to own that
    # spelling. A server exposing both `a-b` and `a_b` keeps both listed — dropping the hyphenated
    # one there would hide a real tool behind its neighbour.
    return {name: value for name, value in members.items() if (fold := spellable(name)) is None or members.get(fold) is not value}


MCP_MODULE = "__dsh__.tools.mcp"


def mcp_members(module_name: str) -> dict:
    """One level of the `mcp` tree, resolved against the catalogue in force NOW.

    Deliberately not a method: a non-dunder attribute on the class would shadow a tool or a server
    of that name, and a raw MCP name is the server's to choose — `_private` is a legal one.

    Reads the `mcp_servers` tree cached on the Session by `rebind`, so an attribute access does not
    rebuild the whole tree (O(n)) when nothing has changed.
    """
    session = _current_session.get()
    servers = session.mcp_tree if session is not None else {}  # no session → no bound tools → no tree
    if module_name == MCP_MODULE:
        # Keyed by the FOLDED name so a hyphenated server and its fold resolve to one module object,
        # not two: `listed` tells an alias from a real neighbour by identity, and two objects would
        # leave both spellings in `dir(mcp)`. Only the fold reaches `sys.modules`, which is the only
        # spelling `from __dsh__.tools.mcp.<server> import …` could have used anyway.
        return {server: mcp_server_module(canonical(server, servers)) for server in servers}
    # `removeprefix`, not `rpartition`: a raw server name is not guaranteed dot-free, and taking
    # the last segment of one would look up a server that does not exist and resolve it empty.
    return servers.get(module_name.removeprefix(f"{MCP_MODULE}."), {})


class McpModule(types.ModuleType):
    """`__dsh__.tools.mcp`, and one of these per server under it.

    Real modules, so every import form the model might reach for resolves the way it does for
    `__dsh__.tools` itself — including `from __dsh__.tools.mcp.calendar import list_events`, which
    needs a `sys.modules` entry of its own (the shallower forms can be served by `__getattr__`,
    that one cannot).

    Their CONTENTS still come from the ContextVar, because `sys.modules` is process-global while
    the catalogue is per shell — and because a restriction or a reconnecting server moves tools in
    and out between cells. A name pulled OUT with `from ... import` is a snapshot, as it is for any
    Python import; the module itself stays live.
    """

    def __getattr__(self, name):
        # True dunders only. The guard is here to refuse import and introspection probing
        # (`__path__`, `__all__`, `__spec__`, `__deepcopy__`), which always ends in `__` too —
        # and a leading-`__` raw tool name is the server's to choose, so `startswith` alone
        # advertised `mcp.<server>.__weird` in `dir()` and then refused the call.
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        members = mcp_members(self.__name__)
        if name not in members:
            available = ", ".join(sorted(listed(members))) or "(none)"
            raise AttributeError(f"no such tool: {self.__name__.removeprefix('__dsh__.tools.')}.{name}. Available: {available}")
        return members[name]

    def __setattr__(self, name, value):
        # A write would shadow the tool invisibly to dir(), which still reports the harness catalogue.
        if not (name.startswith("__") and name.endswith("__")):
            raise AttributeError(f"{self.__name__.removeprefix('__dsh__.tools.')} belongs to the harness — bind your own name instead of writing to it")
        super().__setattr__(name, value)

    def __dir__(self):
        return sorted(listed(mcp_members(self.__name__)))

    # Star-import reads `__all__` (or `vars()`), never `__getattr__` or `__dir__`, and nothing ever
    # lands in these modules' `__dict__` — so without this `from __dsh__.tools.mcp.x import *`
    # succeeded and bound nothing. `ToolsModule` carries the same property for the same reason.
    @property
    def __all__(self):
        return sorted(listed(mcp_members(self.__name__)))

    def __repr__(self) -> str:
        members = listed(mcp_members(self.__name__))
        return f"<module {self.__name__!r}: {', '.join(sorted(members)) or 'empty'}>"


MCP_ROOT = McpModule(MCP_MODULE, "MCP tools, one module per server.")
MCP_ROOT.__path__ = []  # a package, like `__dsh__` and `__dsh__.tools`, so its server modules resolve
sys.modules[MCP_MODULE] = MCP_ROOT


def mcp_server_module(server: str) -> McpModule:
    """The one module for `server`, made on first ask.

    The single construction site, so a module that went missing — a cell can `del sys.modules[…]`
    — comes back instead of leaving `dir(mcp)` raising `KeyError` for the rest of the session.
    """
    name = f"{MCP_MODULE}.{server}"
    if not isinstance(module := sys.modules.get(name), McpModule):
        module = McpModule(name, f"Tools bridged from the `{server}` MCP server.")
        sys.modules[name] = module
    return module


def install_mcp_modules(servers: dict[str, dict]) -> None:
    """Register a module per visible MCP server.

    Eager, because the deep import form never reaches `mcp_members`: `from __dsh__.tools.mcp.x
    import y` is resolved by the import machinery against `sys.modules`, before any attribute
    lookup happens.

    `sys.modules` only ever gains entries: a server another shell can see costs this one an unused
    module, while removing it would break an import that shell is mid-conversation with. What a
    shell can actually reach is decided by `mcp_members`, not by what is registered.

    Takes the grouped tree from `build_bindings` so `rebind` does not rebuild it a second time.
    """
    for server in servers:
        mcp_server_module(server)


def build_bindings(bridge: Bridge, specs) -> tuple[dict, dict[str, dict]]:
    """Project one agent's visible tools into awaitables for its shell.

    Returns `(bindings, mcp_servers)` so `rebind` can hand the grouped tree to
    `install_mcp_modules` and cache it for `mcp_members` without rebuilding it.
    """
    # A tool named `ToolCallError` would be shadowed by the module's own attributes, and one named `_rebind` used to overwrite a bound method outright. dsh's own SDK renderer refuses `_`-leading tool names for exactly this collision class.
    # `mcp` joins them, and unconditionally: it used to be bound and then overwritten by the namespace, so the tool was uncallable anyway — but only when an MCP server happened to be mounted. A name that means the namespace in one catalogue and a tool in the next is worse than one that always means the same thing.
    reserved = set(vars(ToolsModule)) | set(vars(types.ModuleType)) | {"mcp"}
    flat = {spec["name"]: _make_binding(bridge, spec) for spec in specs if not spec["name"].startswith("_") and spec["name"] not in reserved}
    # `mcp` only when something is under it: an empty namespace in `dir()` reads as a broken mount.
    servers = mcp_servers(flat)
    bindings = {**flat, "mcp": MCP_ROOT} if servers else flat
    return bindings, servers


def install_bridge_modules() -> ToolsModule:
    """Install `__dsh__` — the seam between this interpreter and the JS host.

    A real package in `sys.modules`, so every import form the model might reach for resolves: `from __dsh__.tools import glob, grep`, `import __dsh__.tools`, `from __dsh__ import tools`. Deliberately NOT a bare `tools` global: a dunder-named package reads as harness-owned, survives `%reset`, and leaves the obvious name free for the model's own variables."""
    if isinstance(existing := sys.modules.get("__dsh__.tools"), ToolsModule):
        return existing  # one seam for the whole process; the catalogue is per shell
    package = types.ModuleType("__dsh__", "The seam between this interpreter and the dsh harness.")
    package.__path__ = []  # marks it a package so `__dsh__.tools` resolves
    package.ToolCallError = ToolCallError  # type: ignore
    tools = ToolsModule()
    package.tools = tools  # type: ignore
    package.shared = types.ModuleType("__dsh__.shared", SHARED_DOC)  # type: ignore
    sys.modules["__dsh__.shared"] = package.shared
    sys.modules["__dsh__"] = package
    sys.modules["__dsh__.tools"] = tools
    return tools


# ── the session ──────────────────────────────────────────────────────────────


class StreamProxy(io.TextIOBase):
    """One stable `sys.stdout`/`sys.stderr` for the whole PROCESS.

    Two forces pin this shape. The namespace persists, so `logging.basicConfig()` resolves `sys.stderr` ONCE at handler construction and must keep reaching whatever the live cell is capturing. And shells share the process, so the sink cannot be an attribute here — two concurrent cells would overwrite each other's. Looking it up per task through the ContextVar satisfies both."""

    encoding = "utf-8"

    def __init__(self, which: int) -> None:
        self._which = which  # 0 = stdout, 1 = stderr

    def write(self, s: str) -> int:
        session = _current_session.get()
        target = None if session is None else session.sinks[self._which]
        # Outside any cell — a background task the model detached, or a thread — there is no cell to attribute the write to, so it goes to the process's real stderr where the host keeps it for diagnostics.
        return target.write(s) if target is not None else REAL_STDERR.write(s)

    def writable(self) -> bool:
        return True

    def flush(self) -> None:
        pass


class RoutedDisplayHook:
    """The single process-wide `sys.displayhook`, dispatched per task.

    Each shell owns a separate displayhook object, but a cell's trailing expression reaches the GLOBAL entry point — so with two shells live, one cell's value is filled into the other's `ExecutionResult`. Measured: the two results come back swapped, silently. `InteractiveShell.__init__` also points `sys.displayhook` at its own hook, so every new Session reinstalls this."""

    def __call__(self, value):
        session = _current_session.get()
        if session is not None:
            session.shell.displayhook(value)


ROUTED_DISPLAYHOOK = RoutedDisplayHook()
PROXY_STDOUT, PROXY_STDERR = StreamProxy(0), StreamProxy(1)

SHARED_DOC = """`__dsh__.shared` — a persistent namespace local to this session.

Other sessions, including delegated subagents, have separate interpreters. Pass data through tool arguments, results, or files when delegating work."""


class Capped(io.TextIOBase):
    """Byte-capped StringIO stand-in for one cell's stdout or stderr."""

    def __init__(self, limit: int) -> None:
        self.parts: list[bytes] = []
        self.size = 0
        self.limit = limit
        self.truncated = False

    def write(self, s: str) -> int:
        if not self.truncated:
            chunk = s.encode("utf-8", "replace")
            if self.size + len(chunk) > self.limit:
                room = self.limit - self.size
                if room > 0:
                    # "ignore", not "replace": slicing encoded bytes at the cap can land mid-character, and "replace" would hand the model a U+FFFD. Dropping the partial character is honest.
                    self.parts.append(chunk[:room])
                    self.size += room
                self.truncated = True
            else:
                self.parts.append(chunk)
                self.size += len(chunk)
        return len(s)

    def writable(self) -> bool:
        return True

    def text(self) -> str:
        body = b"".join(self.parts).decode("utf-8", "ignore")
        return f"{body}\n[dsh-py-codeact] output truncated at {self.limit} bytes" if self.truncated else body


class Session:
    """One IPython shell whose namespace persists across cells in a DSH session."""

    def __init__(self, bridge: Bridge, specs, shell_id: str) -> None:
        self.shell_id = shell_id
        self.tasks: set = set()
        self.closing = False
        self.closed = False
        namespace = HintingNamespace()
        # `:memory:` because a bare `InteractiveShell` writes every cell into the USER's own `~/.ipython/profile_default/history.sqlite` — measured at 87 MB / 47k cells here, shared with their interactive ipython, contended by every kernel process at once, and growing with nothing to prune it. Model cell sources have no business in that file; the session log is the audit record. `_ih`, `_` and `Out[n]` all still work, which is what `repr` is built from.
        history = Config()
        history.HistoryAccessor.hist_file = ":memory:"
        self.shell = InteractiveShell(user_ns=namespace, config=history, ipython_dir=os.environ.get("IPYTHONDIR"))
        # No pty means no pexpect (see PTY_AVAILABLE), so `!cmd` gets the pipe runner. An unfenced host keeps `system_piped`, whose pexpect path gives cells colors and interactivity that pipes cannot.
        if not PTY_AVAILABLE:
            self.shell.system = _pipe_system(self.shell)
        # The specs last bound, so an identical catalogue (the common case — a restriction that
        # did not change anything, or the same tools re-sent) skips `rebind` and its per-tool
        # callable + signature rebuild. `None` means "nothing bound yet"; `==` on the parsed
        # structures still catches a catalogue the host re-serialised, which identity would miss.
        self._last_specs: list | None = None
        # The grouped `mcp_servers` tree from the last `rebind`, cached so `mcp_members` reads it
        # (O(1) lookup) instead of rebuilding it on every attribute access.
        self.mcp_tree: dict[str, dict] = {}
        self.rebind(bridge, specs)
        self.sinks: list = [None, None]  # the Capped buffers of the cell in flight
        install_bridge_modules()

        # `InteractiveShell.__init__` points `sys.displayhook` at its OWN hook, so the newest shell would otherwise capture every shell's values.
        sys.stdout, sys.stderr = PROXY_STDOUT, PROXY_STDERR
        sys.displayhook = ROUTED_DISPLAYHOOK
        # IPython wraps every cell in display_trap, temporarily replacing sys.displayhook. Route that hook too so expression results retain their cell ownership.
        #
        # Pointing both ends of the trap at the routed hook makes it a no-op — `set` short-circuits on `is not self.hook`, `unset` restores what was already there — so `sys.displayhook` stays routed and the ContextVar decides, which is the whole point of `RoutedDisplayHook`.
        self.shell.display_trap.hook = ROUTED_DISPLAYHOOK
        self.shell.display_trap.old_hook = ROUTED_DISPLAYHOOK

        # IPython writes tracebacks itself, in color. Send that copy to the real stderr so the cell's captured streams stay clean; the model gets the nocolor re-render from `format_exc` instead.
        #
        # Hook `_showtraceback`, not `showtraceback`: compile-time failures (SyntaxError, IndentationError) never reach `showtraceback` — IPython routes them through `showsyntaxerror`/`showindentationerror`, which print with a bare `print()`, i.e. into the cell's captured STDOUT. All three funnel through `_showtraceback`, so that is the choke point.
        original = self.shell._showtraceback  # noqa: SLF001
        self._rendering_for_model = False

        @wraps(original)
        def wrapper(*args, **kwargs):
            if self._rendering_for_model:
                return original(*args, **kwargs)
            with contextlib.redirect_stdout(REAL_STDERR), contextlib.redirect_stderr(REAL_STDERR):
                return original(*args, **kwargs)

        self.shell._showtraceback = wrapper  # noqa: SLF001

        # Keep the display hook's bookkeeping — it binds `_`/`Out[n]` and fills `result.result`, which is where `repr` comes from — but drop its `Out[1]: …` echo. That echo goes to stdout, so the model would see every returned value twice, once in <stdout> and once in <return>.
        self.shell.displayhook.write_output_prompt = lambda: None
        self.shell.displayhook.write_format_data = lambda *_args, **_kwargs: None
        # The instructions tell the model to end every cell on the value worth seeing, so `Out[n]` pins one live object per cell — at the default 1000 that is the last 1000 dataframes. Still reachable as `_`/`Out[n]`, just bounded.
        self.shell.displayhook.cache_size = 100

    @contextlib.contextmanager
    def _capture(self):
        out, err = Capped(MAX_STREAM_BYTES), Capped(MAX_STREAM_BYTES)
        captured: list = []
        # Save and restore rather than clear: `format_exc` captures while the cell's own capture is still on the stack.
        previous = list(self.sinks)
        self.sinks[:] = [out, err]
        try:
            yield captured
        finally:
            captured[:] = [out.text(), err.text()]
            self.sinks[:] = previous

    def rebind(self, bridge: Bridge, specs) -> None:
        """Swap in a catalogue — a restriction or a reconnecting server moves tools between cells.

        The one place the `sys.modules` registration lives, so `build_bindings` stays the pure
        projection its name promises and no caller can produce bindings the import machinery
        cannot follow.

        Skipped when the specs equal the last bound set: `build_bindings` rebuilds
        every tool callable + `inspect.Signature` per exec, and the common case is a catalogue that
        never changed between cells. `==` on the parsed structures catches a catalogue the host
        re-serialised, which object identity would miss.
        """
        if specs == self._last_specs:
            return
        bindings, servers = build_bindings(bridge, specs)
        # `mcp_members` reads a servable-filtered tree: a true-dunder raw name (e.g. `__odd__`) is
        # reachable via the flat name and the deep import, never via `mcp.<server>.<tool>`, so the
        # server it sits under is absent from `dir(mcp)`. `install_mcp_modules` takes the unfiltered
        # tree so the server module is still registered for the deep import form.
        tree = mcp_servers({name: call for name, call in bindings.items() if servable(name) is not None})
        install_mcp_modules(servers)
        self.bindings, self.mcp_tree = bindings, tree
        # Recorded only once the build above has succeeded: a memo written before a raising spec would make a retry with the same specs early-return and silently serve the stale catalogue.
        self._last_specs = specs

    def format_exc(self) -> str:
        """IPython's own traceback, rendered without ANSI colors."""
        with self._capture() as captured:
            colors = self.shell.colors
            self._rendering_for_model = True
            try:
                self.shell.colors = "nocolor"
                self.shell.showtraceback()
            finally:
                self.shell.colors = colors
                self._rendering_for_model = False
        return "\n".join(part for part in captured if part).strip()

    async def run_cell(self, code: str) -> dict:
        redundant: list = []
        token = _redundant_imports.set(redundant)
        # Everything routed — stdout, the display hook, the tool catalogue — reads this. `run_cell_async` runs in its own task, so the binding follows the cell and concurrent cells in other shells never see it.
        session_token = _current_session.set(self)
        try:  # NOTE: this `finally` must outlive `format_exc()` below — it renders through the same routed streams and needs the binding still set.
            with self._capture() as captured:
                # Mirror IPython's own `run_cell`: a transform failure is the MODEL's syntax error (inconsistent indentation is the common one), so it has to travel as `preprocessing_exc_tuple` and come back as a clean `error_before_exec`. Calling `transform_cell` bare let it raise past `run_cell_async` and be reported as a harness crash, complete with a traceback into this file.
                try:
                    transformed, preprocessing_exc = self.shell.transform_cell(code), None
                except Exception:  # noqa: BLE001 — any transform failure is the model's own syntax error, to be reported as one
                    transformed, preprocessing_exc = code, sys.exc_info()
                result = await self.shell.run_cell_async(
                    code,
                    transformed_cell=transformed,
                    preprocessing_exc_tuple=preprocessing_exc,
                    store_history=True,
                )
            stdout, stderr = captured
            failed = result.error_before_exec or result.error_in_exec
            # `run_cell_async` catches the cancellation and reports it as a failed cell, so the `except CancelledError` around this never sees one. Say plainly what happened instead of handing the model a CancelledError traceback it might read as a bug in its own code. In-flight tool calls are deliberately NOT failed here. The cell's own awaits already unwind on the CancelledError; anything still pending belongs to a task the model detached with `create_task`, which is the whole point of a persistent kernel — interrupting cell 5 must not cancel a task launched in cell 2. Abandoned futures settle when the host replies, and `settle` drops late or duplicate replies safely.
            if isinstance(result.error_in_exec, asyncio.CancelledError):
                error = "InterruptedError: the harness cancelled this cell. State is intact; the cell did not finish."
            else:
                error = self.format_exc() if failed else None

            return {
                "ok": bool(result.success),
                "stdout": stdout,
                "stderr": stderr,
                "error": error,
                "repr": None if result.result is None else safe_render(result.result),
                "note": format_import_hint(redundant),
            }
        finally:
            _redundant_imports.reset(token)
            _current_session.reset(session_token)


# ── kernel loop ──────────────────────────────────────────────────────────────


@dataclass
class SourceStream:
    id: int
    queue: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    parts: list[str] = field(default_factory=list)
    size: int = 0
    closed: bool = False
    error: str | None = None
    started: bool = False
    replied: bool = False


class Kernel:
    def __init__(self) -> None:
        self._out = os.fdopen(PROTOCOL_FD, "wb", buffering=0)
        self._bridge = Bridge(self._send)
        # One frame at a time: `call` frames fire as tasks beside the `done`/`ready` frames this loop awaits, and a sender that yields mid-frame (buffer full) must not let another write into the gap — the host's `readline` would see two spliced frames and drop both.
        self._send_lock = asyncio.Lock()
        # One in-flight task per shell identity supplied by the host.
        self._sessions: dict = {}
        self._tasks: dict = {}
        self._cleanups: set = set()
        self._closing: dict = {}
        self._deferred: dict = {}
        self._streams: dict[str, SourceStream] = {}
        self._last_stream_ids: dict[str, int] = {}

    async def _send(self, frame: dict) -> None:
        # The control descriptor is NON-BLOCKING: `asyncio.connect_read_pipe` sets O_NONBLOCK on it, and Node's `stdio[3]: 'pipe'` is one duplex socketpair, so the read and write ends are the same descriptor. A raw `write()` therefore stops at the socket send buffer (8 KiB on macOS) and reports how far it got — ignoring that return value truncated the frame mid-JSON, silently, and the next frame was concatenated onto the stump. The host then dropped one unparsable blob and the session wedged for good. `default=str` so the natural CodeAct idiom just works: the model globs with `pathlib` and passes the `Path` straight into a tool. Coercing here beats making every call site write `str(p)` — and beats a `TypeError` raised mid-frame, which is what used to happen. Same for `datetime`, `Decimal`, `UUID`, numpy scalars.
        # `errors="replace"` is load-bearing, not tidiness: a lone surrogate — routine from `surrogateescape` decoding, or any `Path` on a non-UTF-8 filename — passes `json.dumps` and then raises `UnicodeEncodeError` here. This send is what answers an exec, so a raise means no `done` frame ever arrives and the turn hangs forever. A U+FFFD in one string beats a wedged session.
        payload = memoryview((json.dumps(frame, ensure_ascii=False, default=str) + "\n").encode("utf-8", errors="replace"))
        loop = asyncio.get_running_loop()
        async with self._send_lock:
            cancelled = False
            while payload:
                try:
                    written = self._out.write(payload)
                except BlockingIOError:
                    written = None
                if written is None:  # the buffer is full; wait for the host to drain it — a bare `sleep(0)` would hot-spin a core until it does
                    drained = loop.create_future()
                    loop.add_writer(PROTOCOL_FD, self._writable, drained)
                    try:
                        await asyncio.shield(drained)
                    except asyncio.CancelledError:
                        # A cancel must not abandon a half-written frame: the next send splices onto the stump, the host drops both lines, and the aborted exec's `done` never arrives — the 5s `hardInterruptMs` backstop then SIGKILLs the whole kernel. Finish this frame first, then let the cancel through; the host answers a `done` once, so the replacement frame `_exec` sends next is ignored, not fatal.
                        cancelled = True
                    finally:
                        loop.remove_writer(PROTOCOL_FD)  # a no-op when the callback already removed it; cancels a queued-but-unrun one
                    continue
                payload = payload[written:]
            if cancelled:
                raise asyncio.CancelledError

    @staticmethod
    def _writable(drained) -> None:
        # Remove INSIDE the callback: a level-triggered selector re-fires a still-registered writer on every poll, and the future's done callbacks are `call_soon`-scheduled — the sender's `finally` above runs two loop batches later, by which time a re-fire would `set_result` on the already-done future.
        asyncio.get_running_loop().remove_writer(PROTOCOL_FD)
        drained.set_result(None)

    @staticmethod
    def _task_factory(loop, coro, **kwargs):
        context = kwargs.get("context")
        session = context.get(_current_session, _current_session.get()) if context is not None else _current_session.get()
        if session is not None and session.closed:
            coro.close()
            raise RuntimeError("Session is closed")
        if context is not None and _current_session not in context and session is not None:
            context = context.copy()
            context.run(_current_session.set, session)
            kwargs["context"] = context
        task = asyncio.Task(coro, loop=loop, **kwargs)
        if session is not None:
            session.tasks.add(task)
            task.add_done_callback(session.tasks.discard)
        return task

    async def _dispose(self, shell, session, tasks) -> None:
        # Finalizers may spawn helpers (gather, wait_for, async resource cleanup). Give those
        # helpers the same deadline instead of cancelling them before they can release resources.
        deadline = asyncio.get_running_loop().time() + 2
        while tasks:
            await asyncio.wait(tasks, timeout=max(0, deadline - asyncio.get_running_loop().time()))
            tasks = {task for task in session.tasks | tasks if not task.done()}
            if asyncio.get_running_loop().time() >= deadline:
                break
        # A timer can retain this session after its last task ends. Only the cleanup window may spawn helpers.
        session.closed = True

        def release(task=None) -> None:
            tasks.discard(task)
            if not tasks and self._sessions.get(shell) is session:
                self._sessions.pop(shell, None)
                self._tasks.pop(shell, None)

        if tasks:
            # The deadline ends the wait, not ownership. Release the namespace when the last remaining task exits.
            for task in tasks:
                task.cancel()
                task.add_done_callback(release)
            print(f"[dsh-py-codeact] session {shell!r} retained {len(tasks)} task(s) after cancellation", file=REAL_STDERR)
        else:
            release()

    async def _after_cleanup(self, shell, cleanup) -> None:
        try:
            await cleanup
            while self._deferred.get(shell):
                cleanup = self._closing.get(shell)
                if cleanup is not None and not cleanup.done():
                    await cleanup
                    continue
                # Leave unprocessed frames visible to cancellation while a ready/done write is blocked.
                await self._handle(self._deferred[shell].pop(0), replay=True)
        finally:
            self._deferred.pop(shell, None)

    async def _cancel_deferred(self, shell, *, dispose=False) -> None:
        frames = self._deferred.get(shell, [])
        if shell in self._deferred:
            self._deferred[shell] = [] if dispose else [frame for frame in frames if frame.get("t") != "exec" and not str(frame.get("t")).startswith("stream_")]
        for frame in frames:
            if frame.get("t") == "stream_start" and isinstance(exec_id := frame.get("id"), int):
                self._last_stream_ids[shell] = max(exec_id, self._last_stream_ids.get(shell, 0))
            if frame.get("t") in ("exec", "stream_start"):
                await self._send(
                    {"t": "done", "id": frame.get("id"), "shell": shell, "ok": False, "stdout": "", "stderr": "", "error": "InterruptedError: deferred cell cancelled", "repr": None, "note": None}
                )

    def _busy(self, shell) -> bool:
        running = self._tasks.get(shell)
        return running is not None and not running.done()

    def _session_for(self, shell, specs=None) -> Session:
        session = self._sessions.get(shell)
        if session is None:
            # An exec before its init still gets a usable shell, just no bindings.
            session = self._sessions[shell] = Session(self._bridge, specs or [], shell)
        elif specs is not None:
            session.rebind(self._bridge, specs)
        return session

    async def _exec(self, exec_id, shell, code: str) -> None:
        session = self._session_for(shell)
        try:
            frame = {"t": "done", "id": exec_id, "shell": shell, **await session.run_cell(code)}
        except asyncio.CancelledError:
            frame = {"t": "done", "id": exec_id, "shell": shell, "ok": False, "stdout": "", "stderr": "", "error": "KeyboardInterrupt: cell interrupted by the harness", "repr": None, "note": None}
        except Exception:  # noqa: BLE001 — the exec MUST be answered whatever went wrong, or the host hangs forever
            # `run_cell` guards the cell's own code, but not `transform_cell` or `render_value` around it. A leak here used to kill this task silently: no `done` frame is ever sent, the host's promise never settles, and the whole turn hangs until the user aborts. Always answer the exec, even when the answer is "the kernel broke".
            frame = {
                "t": "done",
                "id": exec_id,
                "shell": shell,
                "ok": False,
                "stdout": "",
                "stderr": "",
                "error": f"KernelError: the kernel failed while running this cell.\n{traceback.format_exc()}",
                "repr": None,
                "note": None,
            }
        await self._send(frame)

    def _abort_stream(self, shell, message: str) -> None:
        state = self._streams.get(shell)
        if state is None:
            return
        if state.error is not None:
            return  # Repeated abort frames must not cancel an asynchronous finalizer again.
        state.error = message
        state.closed = True
        state.queue.put_nowait(None)
        # Cancelling a task before its first step skips its finally block and the done frame.
        # Let an unstarted owner observe the error itself instead.
        if state.started and self._busy(shell):
            self._tasks[shell].cancel()

    async def _exec_stream(self, exec_id, shell, state: SourceStream) -> None:
        from partial_python import Executor

        state.started = True
        session = self._session_for(shell)
        redundant = []
        session_token = _current_session.set(session)
        hint_token = _redundant_imports.set(redundant)

        async def chunks():
            while True:
                if state.error is not None:
                    raise RuntimeError(state.error)
                delta = await state.queue.get()
                if state.error is not None:
                    raise RuntimeError(state.error)
                if delta is None:
                    return
                yield delta

        try:
            # One owner and capture for the logical cell: parser flushes must not reset
            # task-local tool routing, output, or the lifetime of detached Python tasks.
            error = None
            with session._capture() as captured:  # noqa: SLF001 — the kernel owns the Session capture lifecycle
                try:
                    async with contextlib.aclosing(Executor(session.shell.user_ns).stream(chunks())) as events:
                        async for _ in events:
                            pass
                except BaseException as exc:  # noqa: BLE001 — user code must produce a done frame even for SystemExit
                    error = state.error or (
                        "InterruptedError: the harness cancelled this streaming cell. Earlier effects remain."
                        if isinstance(exc, asyncio.CancelledError)
                        else "".join(traceback.format_exception_only(type(exc), exc)).strip()
                    )
            stdout, stderr = captured
            frame = {"t": "done", "id": exec_id, "shell": shell, "ok": error is None, "stdout": stdout, "stderr": stderr, "repr": None, "error": error, "note": format_import_hint(redundant)}
        finally:
            _redundant_imports.reset(hint_token)
            _current_session.reset(session_token)
            if self._streams.get(shell) is state:
                self._streams.pop(shell, None)
        state.replied = True
        await self._send(frame)

    async def _handle(self, frame: dict, *, replay=False) -> None:
        kind = frame.get("t")
        shell = frame.get("shell") or DEFAULT_SHELL
        if not replay and kind in ("init", "exec", "stream_start", "stream_append", "stream_finish", "stream_abort"):
            cleanup = self._closing.get(shell)
            if shell in self._deferred or (cleanup is not None and not cleanup.done()):
                if kind == "init" and isinstance(specs := frame.get("tools"), list):
                    # Validate before deferring so malformed init still exits through serve's startup failure path.
                    build_bindings(self._bridge, specs)
                # Keep new frames behind the replay even after cleanup finishes.
                # Replay in arrival order after cleanup; the host may send exec immediately
                # after init without waiting for ready. Keep reading finalizers' tool results.
                if shell not in self._deferred:
                    self._deferred[shell] = []
                    pending = asyncio.create_task(self._after_cleanup(shell, cleanup))
                    self._cleanups.add(pending)
                    pending.add_done_callback(self._cleanups.discard)
                self._deferred[shell].append(frame)
                return
        if kind in ("exec", "stream_start"):
            if kind == "stream_start":
                exec_id = frame.get("id")
                if type(exec_id) is not int or exec_id <= self._last_stream_ids.get(shell, 0):
                    return  # Host execution ids increase per shell; retain one replay watermark.
            if self._busy(shell) or (shell in self._sessions and self._sessions[shell].closing):
                # Answer BEFORE rebinding: a rejected exec must not swap the tool table under the cell that is still running, or a binding it captured (`from __dsh__.tools import read`) can change identity — or vanish — between its start and its next await. The check is per shell: another agent's cell running is not a conflict.
                await self._send(
                    {"t": "done", "id": frame.get("id"), "shell": shell, "ok": False, "stdout": "", "stderr": "", "error": "kernel busy: a previous cell is still running", "repr": None, "note": None}
                )
                return
            specs = frame.get("tools")
            try:
                self._session_for(shell, specs if isinstance(specs, list) else None)
            except Exception as error:  # noqa: BLE001 — binding happens before the execution task can answer failures
                if kind == "stream_start":
                    self._last_stream_ids[shell] = frame["id"]  # A rejected source must not replay against the previous catalogue.
                await self._send(
                    {
                        "t": "done",
                        "id": frame.get("id"),
                        "shell": shell,
                        "ok": False,
                        "stdout": "",
                        "stderr": "",
                        "error": f"KernelError: failed to bind tools before execution: {type(error).__name__}: {error}",
                        "repr": None,
                        "note": None,
                    }
                )
                return
            if kind == "exec":
                self._tasks[shell] = asyncio.ensure_future(self._exec(frame.get("id"), shell, frame.get("code") or ""))
            else:
                exec_id = frame.get("id")
                assert isinstance(exec_id, int)  # Validated before the busy/rebind checks.
                state = SourceStream(exec_id)
                self._streams[shell] = state
                self._last_stream_ids[shell] = exec_id
                task = self._tasks[shell] = asyncio.create_task(self._exec_stream(exec_id, shell, state))

                def stream_finished(done, state: SourceStream = state):
                    error = None
                    if done.cancelled() and not state.started:
                        error = "InterruptedError: streaming cell cancelled before execution"
                    elif not done.cancelled() and (exc := done.exception()) is not None:
                        error = f"KernelError: streaming execution failed internally: {type(exc).__name__}: {exc}"
                    if error is not None and not state.replied:
                        state.replied = True
                        if self._streams.get(shell) is state:
                            self._streams.pop(shell, None)
                        reply = asyncio.create_task(self._send({"t": "done", "id": exec_id, "shell": shell, "ok": False, "stdout": "", "stderr": "", "repr": None, "note": None, "error": error}))
                        self._cleanups.add(reply)
                        reply.add_done_callback(self._cleanups.discard)

                task.add_done_callback(stream_finished)
        elif kind in ("stream_append", "stream_finish", "stream_abort"):
            state = self._streams.get(shell)
            if state is None or state.id != frame.get("id"):
                return  # Late frames from a finished/aborted source cannot affect the next cell.
            if kind == "stream_abort":
                self._abort_stream(shell, frame.get("message") or "SourceError: generation did not complete")
            elif state.closed:
                self._abort_stream(shell, "SourceProtocolError: source already closed")
            elif kind == "stream_append":
                text = frame.get("text")
                size = len(text.encode("utf-8", errors="surrogatepass")) if isinstance(text, str) else 0
                if not isinstance(text, str) or state.size + size > 2 << 20:
                    self._abort_stream(shell, "SourceProtocolError: invalid or oversized source delta")
                elif text:
                    state.parts.append(text)
                    state.size += size
                    state.queue.put_nowait(text)
            elif frame.get("source") != "".join(state.parts):
                self._abort_stream(shell, "SourceProtocolError: final source differs from accepted deltas")
            else:
                state.closed = True
                state.queue.put_nowait(None)
        elif kind == "call_state":
            self._bridge.progress(frame.get("id"), frame.get("phase"))
        elif kind == "result":
            self._bridge.settle(frame.get("id"), bool(frame.get("ok")), frame.get("value"), frame.get("tool"), frame.get("message"))
        elif kind == "interrupt":
            await self._cancel_deferred(shell)
            # Disposal already cancelled the old cell; interrupting its replacement must not cancel that finalizer again.
            if shell in self._sessions and self._sessions[shell].closing:
                return
            # A synchronous CPU-bound cell (`while True: pass`) blocks the event loop inside `exec`, so this interrupt frame sits unread and `task.cancel()` can't fire until the next `await` yields back to the loop.
            if shell in self._streams:
                self._abort_stream(shell, "InterruptedError: the harness cancelled this streaming cell. Earlier effects remain.")
            elif self._busy(shell):
                self._tasks[shell].cancel()
        elif kind == "init":
            # Ignore absent catalogues and repeated init during a cell. A supplied catalogue must bind before ready; malformed entries fail startup through serve.
            specs = frame.get("tools")
            if isinstance(specs, list) and not self._busy(shell) and not (shell in self._sessions and self._sessions[shell].closing):
                self._session_for(shell, specs)
            await self._send(
                {
                    "t": "ready",
                    "shell": shell,
                    "env": {
                        "executable": sys.executable,
                        "version": ".".join(str(part) for part in sys.version_info[:3]),
                        "prefix": sys.prefix,
                        "venv": sys.prefix != sys.base_prefix,
                        "cwd": str(Path.cwd()),
                    },
                }
            )
        elif kind == "dispose":
            session = self._sessions.get(shell)
            if session is not None and not session.closing:
                session.closing = True
                # Cancel before yielding: a buffered exec may otherwise run before asynchronous cleanup starts.
                tasks = set(session.tasks)
                if running := self._tasks.get(shell):
                    tasks.add(running)
                for task in tasks:
                    task.cancel()
                # Keep reading result frames while cancellation finalizers await bridged calls.
                cleanup = asyncio.create_task(self._dispose(shell, session, tasks))
                self._closing[shell] = cleanup
                # A replacement may register its cleanup before this task's done callbacks run.
                cleanup.add_done_callback(lambda done: self._closing.pop(shell, None) if self._closing.get(shell) is done else None)
                self._cleanups.add(cleanup)
                cleanup.add_done_callback(self._cleanups.discard)
            await self._cancel_deferred(shell, dispose=True)

    async def serve(self) -> None:
        loop = asyncio.get_running_loop()
        loop.set_task_factory(self._task_factory)
        # The default 64 KiB line limit is far below a real frame: a catalogue of ~40 tools serialises past 80 KB, and a cell carrying a file body is unbounded by nature. Overrunning it raises out of `readline` and takes every shell's namespace with it.
        reader = asyncio.StreamReader(limit=1 << 24)
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader),
            os.fdopen(PROTOCOL_FD, "rb", buffering=0),
        )
        while True:
            try:
                line = await reader.readline()
            except ValueError:
                # a line over the 16 MiB limit overflows the buffer; it is already drained, so skipping is safe — but say so: the host's exec never gets its `done` and the turn hangs, and a silent drop hides why
                print("[dsh-py-codeact] dropped a frame over the 16 MiB line limit", file=REAL_STDERR)
                continue
            if not line:
                return  # host closed the control channel
            try:
                frame = json.loads(line)
            except ValueError:
                continue  # the host is not model-controlled, but never crash on junk
            if not isinstance(frame, dict):
                continue
            if frame.get("t") == "shutdown":
                return
            try:
                await self._handle(frame)
            except Exception:
                # `_handle` runs directly in this loop: an exception here unwinds out of `asyncio.run` and takes the interpreter — and the whole session's state — with it. One malformed frame is not worth that; a `result` whose `id` is unhashable used to do exactly it.
                print(f"[dsh-py-codeact] dropped a frame that raised: {traceback.format_exc()}", file=REAL_STDERR)
                # A failed initialization has no ready frame. Exit so the host rejects startup instead of waiting forever.
                if frame.get("t") == "init":
                    raise


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(Kernel().serve())
