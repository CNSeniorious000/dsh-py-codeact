#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "ipython~=9.17.0",
#     "objprint~=0.3.0",
# ]
# # Checked with `TY_UV=scripts ty check py/kernel.py` — that prefix is what hands ty this script's venv. A `ty.toml` would be found and then silently ignored for PEP 723 scripts (astral-sh/ty#4083), so any ty config has to live here.
# ///

"""Persistent IPython kernel for the dsh CodeAct REPL tool.

One long-lived process per conversation tree, holding one `InteractiveShell` per agent. A namespace survives between cells — that is the whole point, and the reason this cannot be a `CodeRuntime` backend (that seam mandates "no state survives between runs").

Cells run through `InteractiveShell.run_cell_async`, which carries magics, top-level `await`, `store_history` (`_`, `Out[n]`), and IPython's own traceback formatter. Structure and the LLM-specific touches (redundant-import hints, objprint reprs) follow `CNSeniorious000/temporary-mcp-servers:ipython-mcp.py`.

Wire protocol: JSON-lines on fd 3. stdout/stderr stay free for native writes.

Every frame but `result` and `shutdown` carries `shell` — the agent whose shell it addresses, defaulting to "main". One process holds one shell per agent, so a fan-out of subagents shares this interpreter, its event loop and its packages while keeping separate globals.

  host  -> child  {"t":"init","shell":S,"tools":[{"name","doc","returns","params":[...]}]}
                  {"t":"exec","id":N,"shell":S,"code":"...","tools":[...]}
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
import contextlib
import inspect
import io
import json
import select
import sys
import traceback
import types
from contextvars import ContextVar
from dis import get_instructions
from functools import lru_cache, wraps
from inspect import isclass
from pathlib import Path

from IPython.core.interactiveshell import InteractiveShell
from IPython.lib.pretty import pretty
from objprint import ObjPrint
from traitlets.config import Config

PROTOCOL_FD = 3

# Wire default for the `shell` field. The JS host holds its own copy of this literal — the seam is the one place the two languages must agree by hand.
DEFAULT_SHELL = "main"

# Bound BEFORE any `redirect_stderr` can swap `sys.stderr`. IPython writes its traceback out itself; sending that copy here (the process's real stderr, which the host keeps only for crash diagnostics) keeps ANSI escapes and a duplicate traceback out of the cell's captured stderr. The model-facing copy is re-rendered without color by `Session.format_exc`.
REAL_STDERR = sys.stderr

# `uv pip install <pkg>` inside a cell has to know WHICH environment to install into. The harness spawns us with an allowlisted environment that deliberately drops VIRTUAL_ENV, and without it uv refuses outright — while IPython's `!cmd` does not fail on a non-zero exit, so the cell reports success and the import fails a cell later, with nothing connecting the two.
if sys.prefix != sys.base_prefix:
    os.environ.setdefault("VIRTUAL_ENV", sys.prefix)

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
# Several shells share this process — one per agent, so a fan-out of subagents costs no extra interpreters and shares `sys.modules`. But `sys.stdout`, `sys.displayhook` and `sys.modules["__dsh__.tools"]` are all process-wide, so concurrent cells would steal each other's output, values and tool catalogue. Routing each of them through this ContextVar is what keeps them apart: `run_cell_async` runs in its own task, and contextvars follow the task.
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


class Bridge:
    """Outbound tool dispatch: one pending future per in-flight call."""

    def __init__(self, send) -> None:
        self._send = send
        self._pending: dict = {}
        self._next = 0

    def call(self, name: str, args):
        self._next += 1
        call_id = self._next
        future = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future
        # There is ONE Bridge for the whole process, so the frame has to say which shell is calling or the host cannot tell a parent's in-flight call from a subagent's. The ContextVar already routes stdout, the displayhook and `__dsh__.tools` the same way, and `create_task` snapshots it — so a task the model detached keeps naming the shell that created it.
        session = _current_session.get()
        self._send({"t": "call", "id": call_id, "shell": None if session is None else session.shell_id, "name": name, "args": args})
        return future

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

    async def call(**kwargs):
        return await bridge.call(name, kwargs)

    call.__name__ = name if name.isidentifier() else "call"
    call.__qualname__ = f"__dsh__.tools.{name}"
    call.__doc__ = spec.get("doc") or None
    # Per-parameter, not one suppress around the whole thing: a single exotic name (`class`, `file-path` — hyphens are routine for MCP tools) used to discard the ENTIRE signature, so `read?` showed `(**kwargs)` while the prompt showed the full parameter list, with no error either way. Anything unrenderable is folded into `**kwargs` so the picture stays honest.
    params, dropped = [], False
    for p in spec.get("params") or []:
        try:
            params.append(
                inspect.Parameter(
                    p["name"],
                    inspect.Parameter.KEYWORD_ONLY,
                    annotation=p.get("type") or "Any",
                    default=inspect.Parameter.empty if p.get("required") else ...,
                )
            )
        except (ValueError, TypeError):
            dropped = True
    if dropped:
        params.append(inspect.Parameter("kwargs", inspect.Parameter.VAR_KEYWORD))
    with contextlib.suppress(ValueError, TypeError):
        # The return annotation matters as much as the parameters here: it is what `read?` can tell the model that no amount of re-reading the call site can. Same source as the prompt block, so the two never disagree.
        call.__signature__ = inspect.Signature(params, return_annotation=spec.get("returns") or "Any")  # type: ignore
    return call


def bound_tools() -> dict:
    """The calling shell's catalogue, or nothing outside a cell."""
    session = _current_session.get()
    return {} if session is None else session.bindings


class ToolsModule(types.ModuleType):
    """`__dsh__.tools` — the bridged tool surface of the CALLING shell.

    `sys.modules` is process-global, so there is exactly ONE of these no matter how many shells are live — yet each agent sees a different catalogue (a subagent's `toolFilter` narrows it, and restrictions move tools in and out between cells). So the bindings live on the Session and every lookup routes through the ContextVar; putting them in `__dict__` would hand every shell the last writer's catalogue."""

    def __init__(self) -> None:
        super().__init__("__dsh__.tools", "Harness tools, bridged into this session as awaitables.")
        self.__path__ = []  # marks it a package so `__dsh__.tools.mcp` resolves
        self.ToolCallError = ToolCallError

    def __getattr__(self, name):  # only reached when the attribute is absent
        if name.startswith("__"):
            raise AttributeError(name)  # import/introspection probing — never answer with a tool
        bindings = bound_tools()
        if name in bindings:
            return bindings[name]
        available = ", ".join(sorted(bindings)) or "(none)"
        raise AttributeError(f"no such tool: {name!r}. Available: {available}")

    def __dir__(self):
        return sorted(bound_tools())

    @property
    def __all__(self):
        return sorted(bound_tools())

    def __repr__(self) -> str:
        return f"<module '__dsh__.tools': {', '.join(sorted(bound_tools())) or 'no tools bound'}>"


MCP_PREFIX = "mcp__"


def split_mcp(name: str) -> tuple[str, str] | None:
    """`mcp__calendar__list_events` -> `("calendar", "list_events")`.

    dsh names every MCP tool `mcp__<serverName>__<rawName>`, and a raw name may itself contain
    `__` — `split("__")` would tear such a tool apart and file it under a server that does not
    exist, so only the first two separators are ever consumed.
    """
    if not name.startswith(MCP_PREFIX):
        return None
    server, sep, raw = name[len(MCP_PREFIX) :].partition("__")
    return (server, raw) if sep and server and raw else None


def mcp_servers(bindings: dict) -> dict[str, dict]:
    """Group the flat `mcp__server__tool` bindings into `{server: {tool: call}}`.

    The flat names stay bound too. They are what dsh dispatches on and what an older session may
    already have imported; dropping them to tidy the surface would break a cell mid-conversation.
    """
    servers: dict[str, dict] = {}
    for name, call in bindings.items():
        if (parts := split_mcp(name)) is not None:
            servers.setdefault(parts[0], {})[parts[1]] = call
    return servers


MCP_MODULE = "__dsh__.tools.mcp"


def mcp_members(module_name: str) -> dict:
    """One level of the `mcp` tree, resolved against the catalogue in force NOW.

    Deliberately not a method: a non-dunder attribute on the class would shadow a tool or a server
    of that name, and a raw MCP name is the server's to choose — `_private` is a legal one.
    """
    servers = mcp_servers(bound_tools())
    if module_name == MCP_MODULE:
        return {server: sys.modules[f"{MCP_MODULE}.{server}"] for server in servers}
    return servers.get(module_name.rpartition(".")[2], {})


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
        # Dunders only, as in `ToolsModule`.
        if name.startswith("__"):
            raise AttributeError(name)
        members = mcp_members(self.__name__)
        if name not in members:
            available = ", ".join(sorted(members)) or "(none)"
            raise AttributeError(f"no such tool: {self.__name__.removeprefix('__dsh__.tools.')}.{name}. Available: {available}")
        return members[name]

    def __dir__(self):
        return sorted(mcp_members(self.__name__))

    def __repr__(self) -> str:
        members = mcp_members(self.__name__)
        return f"<module {self.__name__!r}: {', '.join(sorted(members)) or 'empty'}>"


def install_mcp_modules(bindings: dict) -> list[str]:
    """Register `__dsh__.tools.mcp` and one module per visible server; return the server names.

    `sys.modules` is where the import machinery looks for `__dsh__.tools.mcp.<server>`, and it
    only ever gains entries: a server another shell can see costs this one an unused module, while
    removing it would break an import that shell is mid-conversation with. What a shell can
    actually reach is decided by `mcp_members`, not by what is registered.

    Idempotent, and it does not assume `install_bridge_modules` has run: a Session builds its
    bindings before installing the seam.
    """
    if MCP_MODULE not in sys.modules:
        root = McpModule(MCP_MODULE, "MCP tools, one module per server.")
        root.__path__ = []  # marks it a package so its server modules resolve
        sys.modules[MCP_MODULE] = root
    servers = list(mcp_servers(bindings))
    for server in servers:
        name = f"{MCP_MODULE}.{server}"
        if name not in sys.modules:
            sys.modules[name] = McpModule(name, f"Tools bridged from the `{server}` MCP server.")
    return servers


def build_bindings(bridge: Bridge, specs) -> dict:
    """Project one agent's visible tools into awaitables for its shell."""
    # A tool named `ToolCallError` would be shadowed by the module's own attributes, and one named `_rebind` used to overwrite a bound method outright. dsh's own SDK renderer refuses `_`-leading tool names for exactly this collision class.
    # `mcp` joins them, and unconditionally: it used to be bound and then overwritten by the namespace, so the tool was uncallable anyway — but only when an MCP server happened to be mounted. A name that means the namespace in one catalogue and a tool in the next is worse than one that always means the same thing.
    reserved = set(vars(ToolsModule)) | set(vars(types.ModuleType)) | {"ToolCallError", "mcp"}
    flat = {spec["name"]: _make_binding(bridge, spec) for spec in specs if not spec["name"].startswith("_") and spec["name"] not in reserved}
    # `mcp` only when something is under it: an empty namespace in `dir()` reads as a broken mount.
    return {**flat, "mcp": sys.modules[MCP_MODULE]} if install_mcp_modules(flat) else flat


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
    # `__dsh__.tools` is a package now, so `__dsh__.tools.mcp` resolves under it even in a shell
    # whose catalogue has no MCP server — `dir()` on it is then simply empty.
    install_mcp_modules({})
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

SHARED_DOC = """`__dsh__.shared` — a namespace every agent in this process can reach.

Shells are isolated: a subagent cannot see the parent's variables, and two subagents cannot see each other's. This module is the deliberate exception — one module object in the process-global `sys.modules`, so anything set on it is visible to all of them as a live Python object, with no serialization and no token cost. Set an attribute to publish, read one to consume."""


class Capped(io.TextIOBase):
    """Byte-capped StringIO stand-in for one cell's stdout or stderr."""

    def __init__(self, limit: int) -> None:
        self.parts: list = []
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
                    self.parts.append(chunk[:room].decode("utf-8", "ignore"))
                    self.size += room
                self.truncated = True
            else:
                self.parts.append(s)
                self.size += len(chunk)
        return len(s)

    def writable(self) -> bool:
        return True

    def text(self) -> str:
        body = "".join(self.parts)
        return f"{body}\n[dsh-py-codeact] output truncated at {self.limit} bytes" if self.truncated else body


class Session:
    """One IPython shell whose namespace persists across cells.

    One of these per agent. They share the process — and therefore `sys.modules`, the event loop and the installed packages — but not their globals."""

    def __init__(self, bridge: Bridge, specs, shell_id: str) -> None:
        self.shell_id = shell_id
        namespace = HintingNamespace()
        # `:memory:` because a bare `InteractiveShell` writes every cell into the USER's own `~/.ipython/profile_default/history.sqlite` — measured at 87 MB / 47k cells here, shared with their interactive ipython, contended by every kernel process at once, and growing with nothing to prune it. Model cell sources have no business in that file; the session log is the audit record. `_ih`, `_` and `Out[n]` all still work, which is what `repr` is built from.
        history = Config()
        history.HistoryAccessor.hist_file = ":memory:"
        self.shell = InteractiveShell(user_ns=namespace, config=history)
        self.bindings = build_bindings(bridge, specs)
        self.sinks: list = [None, None]  # the Capped buffers of the cell in flight
        install_bridge_modules()

        # `InteractiveShell.__init__` points `sys.displayhook` at its OWN hook, so the newest shell would otherwise capture every shell's values.
        sys.stdout, sys.stderr = PROXY_STDOUT, PROXY_STDERR
        sys.displayhook = ROUTED_DISPLAYHOOK
        # Installing the routed hook is not enough on its own: IPython wraps every cell in `display_trap`, which swaps `sys.displayhook` for THIS shell's own hook for the duration. Two cells in flight interleave those swaps, and a trailing expression evaluated while a sibling's trap is the active one is filled into the SIBLING's `ExecutionResult` — the value is then overwritten by that sibling's own, and the first cell reports no return value at all. Measured: with a bridged `await` in both cells, the parent's repr came back empty every time while the child's was fine, and a cell run alone was unaffected.
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

        self.shell._showtraceback = wrapper  # noqa: SLF001  # ty: ignore[invalid-assignment]

        # Keep the display hook's bookkeeping — it binds `_`/`Out[n]` and fills `result.result`, which is where `repr` comes from — but drop its `Out[1]: …` echo. That echo goes to stdout, so the model would see every returned value twice, once in <stdout> and once in <return>.
        self.shell.displayhook.write_output_prompt = lambda: None  # ty: ignore[invalid-assignment]
        self.shell.displayhook.write_format_data = lambda *_args, **_kwargs: None  # ty: ignore[invalid-assignment]
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
        self.bindings = build_bindings(bridge, specs)

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
            # `run_cell_async` catches the cancellation and reports it as a failed cell, so the `except CancelledError` around this never sees one. Say plainly what happened instead of handing the model a CancelledError traceback it might read as a bug in its own code. In-flight tool calls are deliberately NOT failed here. The cell's own awaits already unwind on the CancelledError; anything still pending belongs to a task the model detached with `create_task`, which is the whole point of a persistent kernel — interrupting cell 5 must not kill a subagent launched in cell 2. Abandoned futures settle when the host replies, and `settle` drops late or duplicate replies safely.
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


class Kernel:
    def __init__(self) -> None:
        self._out = os.fdopen(PROTOCOL_FD, "wb", buffering=0)
        self._bridge = Bridge(self._send)
        # One Session per agent, one in-flight task per Session. Keyed by the shell id the host assigns; a fan-out of subagents lands here as N entries sharing this process, its event loop and its packages.
        self._sessions: dict = {}
        self._tasks: dict = {}

    def _send(self, frame: dict) -> None:
        # fd 3 is NON-BLOCKING: `asyncio.connect_read_pipe` sets O_NONBLOCK on it, and Node's `stdio[3]: 'pipe'` is one duplex socketpair, so the read and write ends are the same descriptor. A raw `write()` therefore stops at the socket send buffer (8 KiB on macOS) and reports how far it got — ignoring that return value truncated the frame mid-JSON, silently, and the next frame was concatenated onto the stump. The host then dropped one unparsable blob and the session wedged for good. `default=str` so the natural CodeAct idiom just works: the model globs with `pathlib` and passes the `Path` straight into a tool. Coercing here beats making every call site write `str(p)` — and beats a `TypeError` raised mid-frame, which is what used to happen. Same for `datetime`, `Decimal`, `UUID`, numpy scalars.
        # `errors="replace"` is load-bearing, not tidiness: a lone surrogate — routine from `surrogateescape` decoding, or any `Path` on a non-UTF-8 filename — passes `json.dumps` and then raises `UnicodeEncodeError` here. This send is what answers an exec, so a raise means no `done` frame ever arrives and the turn hangs forever. A U+FFFD in one string beats a wedged session.
        payload = memoryview((json.dumps(frame, ensure_ascii=False, default=str) + "\n").encode("utf-8", errors="replace"))
        while payload:
            try:
                written = self._out.write(payload)
            except BlockingIOError:
                written = None
            if written is None:  # the buffer is full; wait for the host to drain it
                select.select([], [PROTOCOL_FD], [])
                continue
            payload = payload[written:]

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
        self._send(frame)

    def _handle(self, frame: dict) -> None:
        kind = frame.get("t")
        shell = frame.get("shell") or DEFAULT_SHELL
        if kind == "exec":
            running = self._tasks.get(shell)
            if running is not None and not running.done():
                # Answer BEFORE rebinding: a rejected exec must not swap the tool table under the cell that is still running, or a binding it captured (`from __dsh__.tools import read`) can change identity — or vanish — between its start and its next await. The check is per shell: another agent's cell running is not a conflict.
                self._send(
                    {"t": "done", "id": frame.get("id"), "shell": shell, "ok": False, "stdout": "", "stderr": "", "error": "kernel busy: a previous cell is still running", "repr": None, "note": None}
                )
                return
            specs = frame.get("tools")
            self._session_for(shell, specs if isinstance(specs, list) else None)
            self._tasks[shell] = asyncio.ensure_future(self._exec(frame.get("id"), shell, frame.get("code") or ""))
        elif kind == "result":
            self._bridge.settle(frame.get("id"), bool(frame.get("ok")), frame.get("value"), frame.get("tool"), frame.get("message"))
        elif kind == "interrupt":
            running = self._tasks.get(shell)
            if running is not None and not running.done():
                running.cancel()
        elif kind == "init":
            self._session_for(shell, frame.get("tools") or [])
            self._send(
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
            # The agent is gone; drop its shell so its globals can be collected.
            self._tasks.pop(shell, None)
            self._sessions.pop(shell, None)

    async def serve(self) -> None:
        loop = asyncio.get_running_loop()
        # The default 64 KiB line limit is far below a real frame: a catalogue of ~40 tools serialises past 80 KB, and a cell carrying a file body is unbounded by nature. Overrunning it raises out of `readline` and takes every shell's namespace with it.
        reader = asyncio.StreamReader(limit=1 << 24)
        await loop.connect_read_pipe(
            lambda: asyncio.StreamReaderProtocol(reader),
            os.fdopen(PROTOCOL_FD, "rb", buffering=0),
        )
        while True:
            line = await reader.readline()
            if not line:
                return  # host closed fd 3
            try:
                frame = json.loads(line)
            except ValueError:
                continue  # the host is not model-controlled, but never crash on junk
            if not isinstance(frame, dict):
                continue
            if frame.get("t") == "shutdown":
                return
            try:
                self._handle(frame)
            except Exception:  # noqa: BLE001 — one malformed frame must not take the interpreter down
                # `_handle` runs directly in this loop: an exception here unwinds out of `asyncio.run` and takes the interpreter — and the whole session's state — with it. One malformed frame is not worth that; a `result` whose `id` is unhashable used to do exactly it.
                print(f"[dsh-py-codeact] dropped a frame that raised: {traceback.format_exc()}", file=REAL_STDERR)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(Kernel().serve())
