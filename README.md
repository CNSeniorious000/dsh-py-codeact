# dsh-py-codeact

A CodeAct agent loop for the DeepSeek Harness: the model's action space is a **persistent IPython session**, and harness tools are bridged into it as awaitables.

```python
# one cell
from __dsh__.tools import read, glob
import pandas as pd, io

paths = await glob(pattern="data/*.csv")
frames = [pd.read_csv(io.StringIO(await read(file_path=p))) for p in paths]
df = pd.concat(frames)

# a later cell — `df` is still bound, and so are `read`, `_`, `Out[1]`, everything
df.groupby("region").revenue.sum().nlargest(3)
```

`python` is the only tool the model can call directly. Everything else lives in `__dsh__.tools`, so the action space really is one tool — the CodeAct shape.

Cells run through `InteractiveShell.run_cell_async`, so magics, `transform_cell`, top-level `await`, execution history, and IPython's traceback formatter all come for free. The shell setup and the LLM-specific touches below follow [`CNSeniorious000/temporary-mcp-servers:ipython-mcp.py`](https://github.com/CNSeniorious000/temporary-mcp-servers/blob/main/ipython-mcp.py).

## How it differs from dsh's built-in Code Mode

Same idea, opposite state model.

| | Code Mode (`run_code`) | this plugin (`python`) |
|---|---|---|
| Language | TypeScript (or Python via a backend) | Python, in IPython |
| State between calls | none — one fresh worker per run | **persists** for the session |
| Layer | a `CodeRuntime` seam provider | an ordinary tool plugin |
| Tool surface | a generated `tools` global | the `__dsh__.tools` module |
| Exclusivity | `tools.mode: code`, enforced by the registry | `mode: code`, via prompt assembly + a guard |
| Result | program logs + return value | tagged stdout / return / traceback / note |

**It is deliberately not a `CodeRuntime` backend.** That seam's contract states *"no state survives between runs"*, and Code Mode's own Agent Note records a persistent REPL kernel as rejected-for-MVP, because cross-call state would be invisible to the session log. A persistent kernel cannot conform — so it owns its own process instead of implementing that interface.

That tradeoff is real and inherited: the interpreter's live state cannot be reconstructed from a session replay. What IS in the log is every cell's source and every bridged tool call, which is enough to audit what happened.

## `__dsh__` — the seam

`__dsh__` is a real package in `sys.modules`, so every import form resolves:

```python
from __dsh__.tools import glob, grep  # the usual one
import __dsh__.tools as T  # T.read(...)
from __dsh__ import tools  # tools.read(...)
```

A dunder-named package reads as harness-owned, survives `%reset`, and leaves the obvious name `tools` free for the model's own variables.

**Each tool is a real `async def`.** dsh's description becomes its `__doc__` and its parameters become a keyword-only signature, so the REPL's own introspection does the explaining:

```
In [1]: read?
Signature: read(*, file_path: 'str', offset: 'int' = ..., limit: 'int' = ...) -> 'str'
Docstring: Read a file from the workspace. Results include line numbers…
```

That is why the prompt block carries signatures only — the descriptions are one `?` away instead of resident in every request. Annotations are rendered host-side by dsh's own exported renderers, so there is no second JSON-Schema mapper to drift.

The **return** type comes from the tool's own `output` schema, by way of `ctx.tools.sdkSchemas(scope)` — the projection that carries it. It is the one annotation the model cannot recover by reading harder: a wrong argument fails loudly at the call, while an unknown return shape is only discoverable by calling once and printing the result, which costs a whole turn per tool. A tool that declares no output schema still renders `Any`; claiming a type nobody declared would be worse than admitting ignorance.

Every object in that schema is declared as a named `TypedDict` above the signatures, and an output that is a choice of shapes becomes a union of named branches. For a bridged MCP tool the schema described here is the payload, not the transport wrapper — see below; `dict[str, Any]` would say a dict arrives without saying which keys, which is the one thing a return annotation exists to say.

```python
class BashOutput1(TypedDict):
    kind: Literal["background"]
    jobId: str

class BashOutput2Stdout(TypedDict):
    text: str
    truncated: bool

class BashOutput2(TypedDict):
    kind: Literal["foreground"]
    exitCode: int | None
    stdout: BashOutput2Stdout

async def bash(*, command: str, run_in_background: bool = ...) -> BashOutput1 | BashOutput2: ...
```

`jsonSchemaToPy` cannot do this and says so — it is context-free, and naming a `TypedDict` needs the render context `renderToolsSdkPy` supplies. With nowhere to hang a declaration it degrades every object to `dict[str, Any]`, which on a stock catalogue is the return type of every tool but one. `renderType`, the context-carrying core, is not exported, so the context is borrowed instead: `renderToolsSdkPy` is called with the parameters stripped — the one input it renders without allocating a class, which makes every class it emits an output class — and the block it returns is read back for the declarations and each tool's return text. The `Literal`s, the nested classes, the collision suffixes and the Unicode identifier rules are then dsh's own rather than a second mapper drifting alongside them. The binding set is resent with every cell, because restrictions and mid-conversation tool changes can move a tool in or out between calls.

### The MCP wrapper does not reach the cell

dsh's MCP client resolves a call to `{ content, structuredContent? }` — the protocol's block array plus the server's own payload — and declares exactly that as the tool's output. That wrapper is transport, not API: `content`'s text duplicates the payload, and an image inside it is re-attached to the conversation separately, so a cell can do nothing with it. Handed the wrapper, a model writes `r["structuredContent"]["result"]` — and spends a call discovering it has to.

So the bridge unwraps, and the signature describes what the cell actually receives:

```python
async def mcp__review__search(*, q: str) -> McpReviewSearchOutput: ...   # the payload, not the wrapper
async def mcp__email__ping() -> str: ...                                 # no declared payload: the text blocks, joined
```

A server that declares no output schema is the common case in the wild, and its result really is just text — one text block, in every one of the 4142 MCP results measured across six trials, which is why this is a `str` and not a `list[str]` that would cost an `r[0]` at every call site to preserve a boundary that never appears. A result carrying no text block at all resolves to the empty string: an image there is re-attached to the conversation and read on the next step, so there was never anything for the cell to receive. One divergence is possible and belongs to the server: a tool that declares an output schema but omits `structuredContent` on some call resolves to that call's text, where the signature promised the payload type.

Unwrapping keys off the tool's declared output schema, not off the value that comes back: a tool whose own payload happens to be `{content: [...]}` is not wrapping anything, and replacing its value with joined text would change what that tool returns with nothing to say so. This deliberately differs from Code Mode, which hands the whole envelope to `tools.name(args)`.

### MCP tools work, with nothing special

MCP servers register into the same `ctx.tools` registry as everything else, so they arrive in `__dsh__.tools` like any other binding and dispatch through the same pipeline. They are *presented* grouped, under one `mcp`:

```python
from __dsh__.tools import mcp

data = await mcp.gh.github_graphql(query="{ viewer { login } }")
```

dsh names them `mcp__<server>__<rawName>`, and with a hundred mounted that import line was most of the prompt block while every call site respelled its server. The flat names stay bound — `mcp` is how they are shown, not what they are — so a cell written before this still runs, `import *` still binds them, and only the listings drop them. A name the grouping cannot serve is still shown: dsh hashes a public name that needed normalising and the cut can land before the second `__`, and a raw name that is a true dunder is refused by `__getattr__`; either way the flat name is the only one that works. They are kept out of `dir(__dsh__.tools)` for the same reason the block stopped printing them; a name the grouping cannot reach (dsh hashes a public name that needed normalising, and the cut can land before the second `__`) stays listed, because `mcp` is not another way to say it. The block lists them one module per section — `# __dsh__.tools`, then `# __dsh__.tools.mcp.<server>` — because that is what they are. It used to declare `Protocol` stubs with `self`-taking methods, copied from dsh's own SDK renderer; that renderer describes a singleton object (`tools: Tools`), while this grouping is a real package, so the stub claimed a binding that never happens. `mcp.exa.web_search?` answers `(*, query: str) -> str`, and the block now says the same thing.

It is a real package, so a server can be imported as a module — which reads better than `mcp.` at every call site when a cell leans on one server:

```python
from __dsh__.tools.mcp.calendar import list_events, create_event
from __dsh__.tools.mcp import calendar          # or the server itself
```

The deep form is why each server gets a `sys.modules` entry of its own: `__getattr__` can serve `from __dsh__.tools.mcp import calendar`, but not `from __dsh__.tools.mcp.calendar import list_events` — the import machinery looks that one up as a module. No meta path finder is needed; registration is enough.

`mcp` and its server modules are live views of the catalogue, not snapshots of the cell they were imported in: a restriction or a reconnecting server moves tools in and out between calls, and unlike a single tool the model has no reason to ever import the namespace twice. (A name pulled OUT with `from ... import` is a snapshot, as it is for any Python import.) The name is reserved — a native tool called `mcp` is not bound, nor is one called `ToolCallError`, nor any whose name starts with `_`. The prompt block mirrors all three, because a block that imports a name the kernel never binds is an `ImportError` on the first line the model copies.

dsh's MCP client is explicitly aware of this route — its canonical value "retains the complete JSON MCP blocks and optional structured content for programmatic and Code Mode callers" — and the sub-call logs a `SUBTOOL` row like any other.

Worth contrasting: Anthropic's server-side [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling) is *not* compatible with MCP tools. Owning the bridge host-side is what buys this.

(A tool whose name is not a valid Python identifier cannot be `import`ed, but is still reachable with `getattr` — `getattr(__dsh__.tools, "odd-name")`, or one level deeper for an MCP tool, `getattr(mcp.notion, "API-patch-block-children")`. A raw MCP name is a routine place to find a hyphen.)

## Exclusive mode

`mode: code` (the default) makes `python` the only directly callable tool:

- a `system-prompt/assemble` waterfall listener filters `assembly.tools` down to `python`, so the other schemas never enter the request;
- a `ctx.tools.guard()` denies a model-direct call to anything else and names the route back (`from __dsh__.tools import <name>`) — presentation alone is not enforcement, and a bare rejection reads as a broken deployment. Sub-dispatches carry a `parent` token and are exempt.

`ctx.tools.restrict()` cannot do the first job: it masks *global* tools only, and in a preset composition the tools are scope-local — "scoped registrations remain visible". The assemble waterfall is the layer that owns the model-facing list.

The rule ships as its own prompt section at order 99, ahead of the 100–199 tool-guidance band, for the reason Code Mode orders its own code-only rule there: the model should read which tools it may call before it reads what each one is for. (Measured: moving it out of the band took it from character 4129 to 170.)

Set `mode: both` to keep the native schemas alongside — useful while debugging a composition, not the CodeAct shape.

## The `CodeAct` card

The browser half registers `tool.call.toolview` under `key: 'python'`, giving the call its own card:

```
CodeAct · count the markdown files at the root
┌ python                                  copy ┐
│ from __dsh__.tools import glob                │
│ print(len(await glob(pattern="*.md")))        │
└───────────────────────────────────────────────┘
   Glob · *.md          ← native SUBTOOL row, untouched
```

The code body is the shipped `CodeBlock` primitive with `lang: "python"`, so the highlighting, the language label, and the copy button are dsh's own.

**A client half is required, because nothing host-side can affect this row.** `toolRowModel` ignores the `presentCall` view entirely and derives everything from the tool NAME plus raw args:

```js
title   = TOOL_TITLES[toolName] ?? VARIANT_TITLES[classifyTool(toolName)]  // unknown → "Tool call"
summary = variant === 'others' ? `${toolName} · ${base}` : base
body    = deriveBody(variant, argsRaw)                                     // unknown → raw args JSON
```

and `classifyTool` reads a hardcoded map in which `run_code: 'code'` is the only entry that reaches the syntax-highlighted branch (with `lang: "typescript"` also hardcoded). `run_code` is a reserved name a plugin may not take. Upstream fix proposed in [discussion #4724](https://github.com/deepseek-ai/deepseek-harness/discussions/4724): let the call view carry `kind: 'execute'` plus a language.

**SUBTOOL nesting survives by construction.** `ToolCallBranch` renders `block.subCalls` as *siblings* of the slot occupant:

```js
children: [renderSlot('tool.call.toolview', owner, { entryKey: toolName, fallback }), children]
```

so a registered toolview replaces the card body only. The slot contract says the same: "registering is additive for your own tool".

The card is hand-written in the client module system's factory form (a classic script registering a CJS factory) rather than bundled — this package has no build step, and the card needs only React plus one shipped primitive.

The key is the literal name `python`; a custom `toolName` falls back to the generic row.

## SUBTOOL rows come free

Each bridged call appends the same two session events Code Mode uses:

```js
session.append('tool/code-dispatch-start', { rootCallId, parentCallId, subCallId, name, arguments })
session.append('tool/code-dispatch',       { ...same, isError, content })
```

They pair by `subCallId` (`<parent>:py:<n>`), and the settle event carries `tool/result`'s own vocabulary (`content` + `isError`) — so the trajectory UI renders them through the exact code path it uses for native calls, as `SUBTOOL` rows under the `python` call. No client change.

Both types are in `KNOWN_SESSION_EVENT_TYPES`, so reusing them is supported. Note that an out-of-repo plugin cannot invent a *new* event type: the persistence read path refuses a log containing a type outside that set unless the event is marked `ignorable`, and a registration surface for downstream events is explicitly deferred upstream.

Sub-dispatches carry the outer execution's `parent` token, so they re-enter the complete `pre-execute → guards → execute → post-execute → result` pipeline. The sandbox and approval stack still gate every tool call made from inside a cell.

## What the model gets

- **Magics.** `%whos` to recall what it has bound, `%timeit`, `%run script.py`, `%%writefile`, `obj?` / `obj??`, `%cd`. Cheap self-orientation in a session it has partly forgotten.
- **History.** `store_history=True`, so `_`, `__`, `_i3`, `Out[n]` all work.
- **Redundant-import hints.** When an `import` rebinds a name to the object it already held, the result carries `` `json` is already imported in this session — no need to re-import it. `` A model driving a persistent REPL re-imports constantly; telling it is cheaper than letting it burn a line every cell. (Implemented with a `dict` subclass that watches top-level `STORE_NAME` and checks the preceding opcode was `IMPORT_NAME`/`IMPORT_FROM`, so `x = x` does not trip it.)
- **Readable reprs.** `objprint` + IPython's `pretty` for objects whose own `__repr__` is `object.__repr__` — an agent reading values needs structure, not `<Foo object at 0x…>`.
- **Tagged observations.** `<stdout>`, `<stderr>`, `<return>`, `<traceback>`, `<note>` — with four things possibly present at once, the model needs to know which is which. A plain successful value stays bare.
- **Introspection over prompt text.** `read?` for one tool's full description, `dir(__dsh__.tools)` for the list — `mcp` rather than the hundred flat names under it, matching what the block printed — then `dir(mcp)` and `dir(mcp.<server>)` for those, and `%whos` for its own bindings. `__all__` is left alone: it is what `import *` binds, not what the model is shown — so it carries every flat name the listings drop, and `ToolCallError`, which no listing shows because it is not a tool but which `except ToolCallError` needs after an `import *`. What it introspects matches what the block showed it: the listing carries `mcp` rather than the hundred flat names under it, and an optional parameter renders `= ...` there as it does here — `inspect.signature` uses `repr`, and `repr(...)` is `Ellipsis`, which is what `read?` used to say.

## Cancellation

An aborted turn sends an in-band `interrupt` frame, cancelling the running cell at any `await` point. `run_cell_async` catches the `CancelledError` itself, so the model is told plainly (`InterruptedError: the harness cancelled this cell. State is intact; the cell did not finish.`) rather than handed a raw traceback it might read as a bug in its own code. The session and every binding survive.

A pure CPU loop (`while True: pass`) never reaches an await point. After `hardInterruptMs` (default 5s) the interpreter is SIGKILLed and the next call respawns it; that observation is prefixed with `[the interpreter was restarted; every earlier binding is gone]` so the model does not keep referring to variables that no longer exist.

## Known limitations

- **Native writes are not captured.** stdout/stderr are captured at the Python level, so `print` is captured but a subprocess writing to fd 1 is not. Use `subprocess.run(..., capture_output=True)`, or `%run`. (Anything that does reach fd 1/2 — including IPython's own colored traceback, deliberately routed there — is retained only for the crash message.)
- **Scope is not optional.** The visible tool set comes from `ctx.tools.sdkSchemas(scope)` — the scope being the agent. Omitting it yields the *global* view, which in a preset composition holds only host-registered tools; the preset's own `read`/`bash`/`edit` live in the agent scope and vanish. The prompt section reads `assembly.scope`, and the kernel's name list is resent with every cell (restrictions and mid-conversation tool changes can move a tool in or out between calls).
- **Pick a `toolName` nothing else answers to.** With an MCP IPython server also mounted, a model told to "use the python tool" reaches for `mcp__py__ipython_execute_code` — which has no `tools` binding — and then reports that your tool does not exist.
- **A shape Python cannot name stays vague.** A field whose key is not a valid identifier degrades its own class back to `dict[str, Any]` rather than emitting a body that will not parse — the tool stays callable and only that one annotation goes quiet. A parameter named `self` is now just a parameter: every tool renders as a module-level function, so no enclosing signature has spent that name. A tool name Python refuses gets a class under one it accepts (`123tool` → `Tool123toolOutput`), rather than the `class 123toolOutput` that would be a SyntaxError taking the whole block with it; that tool has no `async def` line, but it is still bound, and `123tool?` names the same class. A schema with no declared properties still renders `Any`; claiming a type nobody declared would be worse.
- **Cold start.** The PEP 723 environment is resolved on first use (`uv python find --script`). Warm afterwards; pass `python` to skip it.

  The interpreter is then spawned **directly**, never behind `uv run --script`. A wrapper stays in the process tree as the interpreter's parent: when it exits first, the interpreter is reparented to init, the handle the host holds reports an exit, and a perfectly live kernel looks dead — so the next cell respawns and the session's state vanishes with an `[the interpreter was restarted]` notice nothing actually caused. `alive` is likewise tracked from the exit event rather than read off `proc.killed`, which Node sets on any `kill()` call, including a signal the process survived.
- **Containment, not a security boundary.** A separate process with a curated environment, but model code can `import os`. Treat a session on this preset as shell access.
- **One interpreter per conversation tree, one shell per agent.** A subagent reuses the parent's process — sharing its event loop, `sys.modules`, installed packages and `__dsh__.shared` — but gets its own globals and its own tool catalogue. Costs an `init` frame, not another interpreter.
- **`__dsh__.shared`** is the one deliberate crack in that isolation: a module every agent in the process can read and write, for handing live objects across a fan-out with no serialization and no tokens.
- Shells close with their session; the process goes when the last agent pointing at it does.

## Environment

By default the kernel gets an allowlist — `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TERM` — not the empty environment the worker-thread runtime uses. CPython running IPython needs a profile dir and a `PATH` for shell escapes; the point is excluding ambient credentials, which an allowlist does just as well. `inheritEnv: true` passes the whole harness environment.

`COLUMNS`/`LINES` are pinned inside the kernel: with no TTY, `get_terminal_size()` falls back to 80×24 and wraps tracebacks and pretty output far narrower than the harness renders at.

## Install

```sh
dsh plugin --profile <name> add dsh-py-codeact
```

Then add the row from `example/agent.cordis.yml` to a preset you own.

The kernel provisions its own Python from the PEP 723 header in `py/kernel.py`, so `uv` is the only prerequisite beyond dsh itself; the first cell pays for that resolve and later ones are warm.

**For the card, also list the package in the profile's `dsh.profile.bundles`** (`~/.dsh/profiles/<name>/package.json`). The browser bundle is served only for packages named by an *enabled Loader entry*, and a preset's rows are per-session — they are not in the profile's entry list at boot, so a preset-only mount never gets its card. This package's own `cordis.patch.yml` therefore inserts one profile-level row carrying `uiOnly: true`, which makes the host half a no-op there: mounting it at profile level would register `python` globally and apply exclusive mode's guard to every preset. Never edit a shipped preset — copy it first (`ctx.agentPresets.copy('standard', 'py-codeact')`) and mount-validate the result with `standingKeyFor('py-codeact')`.

## Verified end to end

Against `Macaron V1 Venti` on a real dsh session. Given a plain task — "read this CSV and tell me which region earned most", with no mention of Python or the module — the model imported from `__dsh__.tools`, ran the cell, and answered with a table. The request carried exactly one tool schema (`python`); all 33 others were reachable only from inside the cell, and the bridged `read` appears as a `SUBTOOL` row under the `python` call in the trajectory tab. A `headless` run completes and exits in ~11s.

## Test

```sh
node test/smoke.js
```

Drives the kernel and wire protocol directly, with no harness: state persistence, `store_history`, magics, redundant-import hints, top-level await, the tool bridge, `ToolCallError`, `asyncio.gather`, traceback recovery (and that ANSI never leaks into the captured stderr), in-band interrupt, and the SIGKILL escalation.
