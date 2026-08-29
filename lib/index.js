/**
 * `dsh-py-codeact` — a CodeAct agent loop over a PERSISTENT Python REPL.
 *
 * Relation to dsh's built-in Code Mode (`run_code`): same idea, opposite state model. Code Mode runs one fresh program per call and deliberately keeps no state — `CodeRuntime`'s contract says "no state survives between runs", and its Agent Note records a persistent REPL kernel as rejected-for-MVP because cross-call state would be invisible to the session log.
 *
 * So this is NOT a `CodeRuntime` backend — it could not conform. It is an ordinary tool plugin that owns its own kernel: one IPython process per conversation tree with a shell per agent, globals surviving between calls, the model's action space being Python code and its observation that cell's output.
 *
 * It still emits `tool/code-dispatch-start` / `tool/code-dispatch`, so bridged tool calls render as SUBTOOL rows in the existing trajectory UI with no client change.
 *
 * @module dsh-py-codeact
 */

import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { contentHasImage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, jsonSchemaToPy } from '@deepseek-ai/dsh-tools'
import { KERNEL_PY, PythonKernel } from './kernel.js'

/** Same prompt band as Code Mode's `tools:sdk`: tool guidance is 100–199. */
const SDK_SECTION_ORDER = 150

/**
 * Ahead of the tool-guidance band, for the reason Code Mode orders its own code-only rule there: the model should read WHICH tools it may call before it reads what each one is for. Behind it sit thousands of characters of per-tool guidance ("use the read tool, not cat") that still apply — but by a different route than the one they imply.
 */
const RULE_SECTION_ORDER = 99

const PLUGIN_NAME = 'dsh-py-codeact'

const EXCLUSIVE_RULE = `## Tool access

\`python\` is the ONLY tool you may call directly. Every other capability is a function inside this interpreter, imported from \`__dsh__.tools\` — that virtual module is the seam between your Python session and the harness. Reach for a capability by writing code that calls it, not by emitting a tool call.
`

/**
 * Shown for the rest of the conversation once this agent's interpreter has been replaced — not just in the observation of the cell that noticed.
 *
 * A one-shot prefix is the wrong shape for this fact. Several turns later the transcript still shows the cells that bound those names, and nothing on screen says they are dead; the model reads a `NameError` on a name it can see above as its own mistake and retries. A section is re-read every turn, which is what a standing fact needs.
 */
const RESTART_NOTICE = `## Python session lost

The dsh process restarted, so the interpreter went with it: every variable, import, open handle and background task from the cells above is gone. Their code is still in the transcript; nothing it bound is live.

A \`NameError\` on a name you can see bound above is that, not your mistake. Rebuild what you need.
`

const INSTRUCTIONS = `## Writing code for the \`python\` tool

Your action space is Python. Each call runs one cell in a **persistent IPython session**: names you bind stay bound for the rest of the session, so build state up across calls instead of re-deriving it. Imports, dataframes, open handles, connections all survive — and so does execution history (\`_\`, \`__\`, \`Out[n]\`).

- Top-level \`await\` works. So do IPython magics: \`%whos\` to see what you have bound, \`%timeit\`, \`%run script.py\`, \`%%writefile\`, \`obj?\` / \`obj??\`, \`%cd\`.
- The cell's LAST expression is echoed back to you, like a REPL prompt — that is the return channel, and reaching for it first keeps cells short. A cell that is one tool call needs no \`print\` at all: end it with \`await read(file_path=p)\` and you get the result. Use \`print(...)\` when you want to RESHAPE what comes back — label several values, format a table, show a slice of something large — not to hand over a value the last line would have echoed anyway.
- Mind what the last line evaluates TO. Ending on \`Path(p).write_text(text)\` echoes the byte count; ending on \`d[k] = v\` echoes nothing. Put the thing worth seeing last, or end with an explicit \`None\` when the cell has nothing to report.
- Tools are awaitable functions: \`from __dsh__.tools import read\`, then \`await read(file_path=...)\`. Keyword arguments only. Each returns that tool's canonical JSON value. The import survives, so import once and reuse.
- Compose them with ordinary Python — that is the whole point of this loop. Discover targets in code and feed them straight in rather than naming each one literally: \`for p in Path('src').rglob('*.py'): await read(file_path=p)\`, or \`await asyncio.gather(*(read(file_path=p) for p in paths))\`. Arguments are serialized for you, so \`Path\`, \`datetime\` and friends can be passed as they are.
- You also have DIRECT filesystem access, and for bulk work it is the better tool: \`Path(p).read_text()\` is one syscall, while \`read\` is a full round-trip through the harness plus a row in the trajectory. Walking a tree, counting matches, reading fifty files to keep three — do it with \`pathlib\`/\`re\` and surface only the conclusion. Reach for the bridged \`read\` when you want what it adds on top: \`offset\`/\`limit\` windowing and its truncation budget for a file too big to hold, or \`read_image\`. An image cannot come back through the cell — a tool result carrying one is attached to the conversation AFTER the run, so call it, end the cell, and look at the image on your next step. What the cell itself receives is only the metadata (path, dimensions), which is not something you can read.
- \`!uv pip install <pkg>\` installs into this interpreter's environment and the package imports in the same session. Shell escapes (\`!cmd\`) do not fail the cell on a non-zero exit — check the output, or use \`subprocess.run(..., check=True)\`.
- Delegating? A subagent runs in this same interpreter with its OWN globals, so it cannot see your variables. \`__dsh__.shared\` is the exception: set an attribute on it and every agent here can read that live object — hand over a dataframe or an index by name instead of describing it in the prompt.
- A FAILED tool call raises \`ToolCallError\` (\`.tool_name\`, plus the message); catch it and continue.
- Independent calls may overlap with \`asyncio.gather\`. Sequence dependent work with plain \`await\`.
- ONLY the cell's output and its final expression come back to you. Tool results consumed inside the cell never enter the conversation, so filter and aggregate in code and surface just the conclusion.
- A cell that raises returns the traceback and the session keeps every prior binding — fix it in the next cell rather than starting over.
- Only \`await\` points are interruptible. Prefer async APIs over blocking ones, and avoid unbounded CPU loops: they can only be stopped by killing the interpreter, which loses all state.

The available tools:`

/**
 * The wrapper dsh's MCP client puts around every result: `{ content, structuredContent? }`, with
 * `content` the protocol's block array and `structuredContent` the server's own payload. Detected
 * by shape rather than by an `mcp__` name, because the shape IS the declared contract — the client
 * builds exactly this schema, `additionalProperties: false` and all.
 *
 * @returns the payload's schema when the server declares one, `null` when this is not an envelope,
 *   and `undefined` for an envelope carrying only text.
 */
function mcpPayloadSchema(schema) {
  if (schema?.type !== 'object' || schema.additionalProperties !== false) return null
  const keys = Object.keys(schema.properties ?? {})
  if (keys.length !== 2 || !keys.includes('content') || !keys.includes('structuredContent')) return null
  if (schema.properties.content?.type !== 'array') return null
  return (schema.required ?? []).includes('structuredContent') ? schema.properties.structuredContent : undefined
}

/** @internal exported for the suite. The same wrapper at run time. A value is only unwrapped when it carries nothing but the wrapper's own keys. */
export function mcpPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (!keys.includes('content') || !Array.isArray(value.content)) return undefined
  if (keys.some((k) => k !== 'content' && k !== 'structuredContent')) return undefined
  return 'structuredContent' in value ? { value: value.structuredContent } : { value: contentText(value.content) }
}

/**
 * Project one tool schema onto the wire spec the kernel builds a binding from: dsh's description becomes the function's docstring, its parameters become a keyword-only signature. Annotations are rendered here with dsh's own `jsonSchemaToPy`, so the kernel needs no second JSON-Schema mapper.
 *
 * The return type comes from the tool's own `output` schema — the shape of the canonical value the call actually resolves to. It is the one annotation a model cannot recover by reading harder: a parameter it gets wrong fails loudly at the call, while an unknown return shape is only discoverable by calling once and printing the result, which is a whole extra turn per tool.
 */
function toolSpec(schema, declarations) {
  const parameters = schema.parameters ?? {}
  const properties = parameters.properties ?? {}
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  return {
    name: schema.name,
    doc: schema.description,
    // `output` is absent only if the caller passed a `schemas()` projection; `sdkSchemas()` always carries it.
    // An MCP tool is annotated by what the CELL receives, which is the payload the bridge unwraps
    // to — never the transport wrapper. Describing the wrapper is accurate and useless: the model
    // then hand-writes `r["structuredContent"]["result"]`, and calls once just to learn that.
    returns: schema.output === undefined ? 'Any' : mcpReturn(schema, declarations),
    params: Object.entries(properties).map(([name, node]) => ({
      name,
      type: jsonSchemaToPy(node),
      required: required.has(name),
    })),
  }
}

/**
 * Every visible tool's spec, plus the `TypedDict` bodies their return annotations name.
 *
 * Both consumers go through here so they cannot disagree: the prompt block declares the classes,
 * and the kernel sends the same `returns` text on to `inspect.Signature`, so `read?` shows the
 * name the block above it defines. It also keeps `toolSpec` off `.map`, where the callback's
 * second argument is the INDEX — a number, so a default parameter never fires and the accumulator
 * is silently a `0`.
 */
function toolSpecs(schemas) {
  const declarations = new Map()
  // The kernel reserves `mcp` for the namespace, so a tool of that name is never bound. Dropped
  // here rather than at the render, which is downstream of the declarations: one with an object
  // output still had its `TypedDict` emitted, referenced by nothing.
  const sorted = [...schemas].filter((schema) => schema.name !== 'mcp').sort(byName)
  // Which tools DECLARE the wrapper. Unwrapping keys off this rather than the returned value:
  // a tool whose own payload happens to be `{content: [...]}` is not wrapping anything, and
  // replacing its value with the joined text would change what it returns with nothing to say so.
  const envelopes = new Set(sorted.filter((schema) => mcpPayloadSchema(schema.output) !== null).map((schema) => schema.name))
  return { specs: sorted.map((schema) => toolSpec(schema, declarations)), declarations, envelopes }
}

/** The annotation for one tool's output: an MCP payload if it is an envelope, else the schema as declared. */
function mcpReturn(schema, declarations) {
  const payload = mcpPayloadSchema(schema.output)
  if (payload === null) return declareType(schema.output, `${pascal(schema.name)}Output`, declarations)
  // An envelope with no declared payload resolves to the text blocks joined, so it really is a `str`.
  return payload === undefined ? 'str' : declareType(payload, `${pascal(schema.name)}Output`, declarations)
}

/**
 * `mcp__calendar__list_events` -> `{ server: 'calendar', tool: 'list_events' }`, matching the
 * kernel's own split. Only the first two separators are consumed: dsh's name is
 * `mcp__<serverName>__<rawName>` and a raw name may itself contain `__`.
 */
function splitMcp(name) {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice(5)
  const at = rest.indexOf('__')
  if (at <= 0 || at + 2 >= rest.length) return null
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) }
}

/** Deterministic (lexicographic) order, so an unchanged tool set renders byte-identically. */
const by = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
const byName = by((spec) => spec.name)

/** The kernel's own wording for a shell whose previous cell has not finished. Matched, not parsed: it is the one failure that leaves the bindings uninstalled. */
const KERNEL_BUSY = 'kernel busy: a previous cell is still running'

/** Identity of one binding set, for skipping a rebind that would change nothing. Over the whole spec, not just the names: a tool can keep its name and change its description or its parameters — an MCP server reconnecting with a revised schema is the ordinary case — and hashing names alone left the kernel serving the old signature while the prompt, re-rendered from live schemas every turn, showed the new one. */
export const specsKey = (specs) => JSON.stringify(specs)

/**
 * The live interpreter's own account of itself, captured from the `ready` frame.
 *
 * Dynamic on purpose, the way `ipython-mcp.py` renders its instructions: which Python, and which environment `uv pip install` lands in, are facts the model cannot see for itself and that change what code it should write. The host cannot state them either — on the default PEP 723 route it does not know the interpreter until `uv` has resolved one. Undefined until the first kernel of this plugin instance comes up; they share a configuration, so one answer holds for all of them.
 */
let pythonEnv

function renderEnvironment() {
  if (pythonEnv === undefined) return 'The session runs in its own Python interpreter, with `uv pip install <pkg>` available in a cell.'
  const where = pythonEnv.venv ? `in the environment at \`${pythonEnv.prefix}\`` : `at \`${pythonEnv.executable}\``
  const head = `Python ${pythonEnv.version} ${where}, working directory \`${pythonEnv.cwd}\`. ` + '`!uv pip install <pkg>` installs there and imports immediately. '
  // Only true on the throwaway-venv route. Under `config.python` the interpreter is one the user pointed at — often their own project venv — and every clause of the sentence below is false there, while the prompt still invites the model to install into it.
  return pythonEnv.disposable
    ? `${head}That environment is this session's alone — it inherits the base packages, nothing you install escapes to the project or to another session, and it is discarded when the session ends.`
    : `${head}This interpreter is NOT disposable: it was configured for this agent and an install persists in it, visible to everything else that uses it. Install only what the task needs.`
}

/**
 * Does this conversation have cells whose interpreter is gone, and has it not already been told?
 *
 * Read from the durable history because that is the only thing that outlives the event it has to detect: `kernels` is in memory, so a harness restart erases the evidence along with the interpreter, while the session log is replayed intact. This is also why `kernelFor`'s `restarted` flag cannot answer it — that one compares against a `previous` entry, and after a harness restart there is no `previous` at all. A restart is by far the more common case, too: restarting `dsh web` is routine, a cell refusing to yield is not.
 *
 * The "not already been told" half is what keeps repeated restarts quiet. The notice is committed to the log, so a plain "did we restart" test would append another one every time the session is reopened, however many times in a row, with nothing in between them. Comparing positions answers the question that actually matters: has anything run in the dead interpreter SINCE the last notice? If not, the standing notice still says everything true.
 */
export function needsRestartNotice(session, toolName, plugin) {
  const messages = session?.deriveMessages?.()
  if (messages === undefined) return false
  let lastCell = -1
  let lastNotice = -1
  messages.forEach((message, index) => {
    if ((message.content ?? []).some((block) => block?.type === 'tool-call' && block.name === toolName)) lastCell = index
    if (message.source?.kind === 'plugin' && message.source.plugin === plugin) lastNotice = index
  })
  return lastCell > lastNotice
}

/** `keyword.kwlist + keyword.softkwlist` for the `requires-python = ">=3.12"` the kernel pins. */
const PY_KEYWORDS = new Set(['False', 'None', 'True', '_', 'and', 'as', 'assert', 'async', 'await', 'break', 'case', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'type', 'while', 'with', 'yield'])

/** A name this block can put in an `import`, a `def`, or a `TypedDict` field. */
const isUsableName = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PY_KEYWORDS.has(name)

/** `mcp__calendar__list_events` -> `McpCalendarListEvents`, for naming that tool's declarations. */
const pascal = (name) => name.split(/[_\-]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join('')

/** `dict[str, Any] | dict[str, Any]` is what a `oneOf` of two objects collapses to once both branches degrade to the same text. Rendering the duplicate says there is a choice to make where there is none. */
const dedupeUnion = (expr) => [...new Set(expr.split(' | '))].join(' | ')

/**
 * Render one output schema, declaring a named `TypedDict` for every object shape it contains.
 *
 * `jsonSchemaToPy` alone cannot do this and says so: it is context-free, and "naming a `TypedDict` requires the render context that `renderToolsSdkPy` supplies" — with nowhere to put a class declaration it degrades every object to `dict[str, Any]`. That erases the one thing an MCP return needs to say. dsh's MCP client resolves a call to the ENVELOPE, `{ content, structuredContent }`, and declares exactly that as the tool's `output`; flattened to `dict[str, Any]` the model is not told the envelope exists, so it reaches for the payload directly, gets nothing, and spends a turn printing the result to find the wrapper — the very cost the return annotation is here to remove.
 *
 * Only the object and array branches are handled here; every leaf still goes through `jsonSchemaToPy`, so there is no second JSON-Schema mapper, only a place to hang the names. A field name Python cannot take degrades that one class back to `dict[str, Any]` rather than emitting a class body that will not parse.
 */
function declareType(schema, baseName, declarations) {
  if (schema === null || typeof schema !== 'object') return jsonSchemaToPy(schema)
  if (schema.type === 'array' && schema.items !== null && typeof schema.items === 'object') {
    return `list[${declareType(schema.items, `${baseName}Item`, declarations)}]`
  }
  const properties = schema.type === 'object' ? (schema.properties ?? {}) : {}
  const names = Object.keys(properties)
  // `baseName` too, not just the fields: a tool name may start with a digit or carry a character
  // `pascal` does not split on, and `123toolOutput` is a SyntaxError that takes the WHOLE block
  // with it — including the tools that were fine. It bites hardest for a tool that is not even
  // importable, whose class nothing would have referenced.
  if (names.length === 0 || !isUsableName(baseName) || !names.every(isUsableName)) return dedupeUnion(jsonSchemaToPy(schema))
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const body = names.map((name) => {
    const type = declareType(properties[name], `${baseName}${pascal(name)}`, declarations)
    return `    ${name}: ${required.has(name) ? type : `NotRequired[${type}]`}`
  })
  // Two tools whose names differ only in separators pascal-case to the same string; keep the first and let the second carry a suffix rather than silently serving one tool the other's shape. Keyed by name, valued by body, so an identical shape reuses the class instead of declaring it twice.
  const declared = body.join('\n')
  let name = baseName
  for (let n = 2; declarations.has(name) && declarations.get(name) !== declared; n++) name = `${baseName}${n}`
  declarations.set(name, declared)
  return name
}

/**
 * The prompt block. Signatures only, with the description carried as a real docstring the model can read with `read?` instead — so the resident prompt stays small and the detail is fetched on demand.
 */
export function renderToolsSection(schemas) {
  const { specs, declarations } = toolSpecs(schemas)
  // MCP tools are named `mcp__<server>__<rawName>` over a `[A-Za-z0-9_-]` alphabet, so hyphens are routine — and legal nowhere in `import` or `def`. One such tool used to make the ENTIRE block a SyntaxError, so not a single line in it could be copied, with nothing saying why.
  //
  // A keyword is the same failure wearing a legal shape: `class` and `None` match the identifier pattern and then break `import` and `def` just as hard. `_` and the soft keywords (`match`, `case`, `type`) are in the list because they are legal identifiers everywhere EXCEPT where this block puts them.
  // MCP tools are grouped under one `mcp` binding instead of being listed individually. With a
  // hundred of them the import line was most of this block, and `mcp__calendar__list_events`
  // carried its server in the name at every call site; `mcp.calendar.list_events` says the same
  // thing once. The flat names stay bound — this is how they are PRESENTED, not what they are.
  const grouped = new Map()
  const plain = []
  for (const spec of specs) {
    const parts = splitMcp(spec.name)
    if (parts === null) { plain.push(spec); continue }
    if (!grouped.has(parts.server)) grouped.set(parts.server, [])
    grouped.get(parts.server).push({ ...spec, tool: parts.tool, server: parts.server })
  }
  const importable = plain.filter((spec) => isUsableName(spec.name))
  const awkward = plain.filter((spec) => !isUsableName(spec.name))
  // A server or tool whose name Python cannot take keeps its `getattr` route, one level deeper.
  const servers = [...grouped].filter(([server]) => isUsableName(server)).sort(by(([server]) => server))
  const oddMcp = [...grouped].flatMap(([server, tools]) =>
    (isUsableName(server) ? tools.filter((t) => !isUsableName(t.tool)) : tools).map((t) => ({ server, tool: t.tool, usableServer: isUsableName(server) })))
  // `self` is a parameter here rather than a splice into the finished line, because a Protocol
  // method needs it in front of BOTH shapes below — and `async def f(*, ) -> T` is a SyntaxError:
  // a `*` needs at least one name after it, and a parameterless tool takes no keywords at all.
  // `head` has NO default, so this can never be handed to `.map` — whose second argument is the
  // index, which a default would silently accept and which is not iterable.
  const signature = (spec, head) => {
    // The same rule applies one level down, and used to not be applied at all: `file-path` is routine for MCP tools, and one such PARAMETER made every other tool's signature unusable too. The binding still takes it — the kernel folds unnameable parameters into `**kwargs` — so the tool stays importable and only its signature goes vague; `name?` still shows the real one.
    if (!spec.params.every((p) => isUsableName(p.name))) return `async def ${spec.name}(${[...head, '**kwargs: Any'].join(', ')}) -> ${spec.returns}: ...  # parameter names are not all valid Python; see ${spec.name}?`
    const fields = spec.params.map((p) => (p.required ? `${p.name}: ${p.type}` : `${p.name}: ${p.type} = ...`))
    return `async def ${spec.name}(${[...head, ...(fields.length === 0 ? [] : [`*, ${fields.join(', ')}`])].join(', ')}) -> ${spec.returns}: ...`
  }
  // `ToolCallError` leads the import because the instructions tell the model to catch it; without it here the natural `except ToolCallError` NameErrors on the failure path, masking the tool failure it was meant to handle. It also keeps the line valid when no tool is importable.
  // The declarations are stubs, not runtime objects — nothing constructs them — so the import line
  // lists exactly what the render used. `Any` has always been reachable from a signature
  // (`**kwargs: Any`, and any degraded annotation) and was never imported at all.
  const signatures = importable.map((spec) => signature(spec, []))
  // A Protocol, not a class of `staticmethod`s: `mcp` is an INSTANCE, so `mcp.calendar.list_events(...)`
  // binds `self` on its own and the stub says exactly what the call site does. It is also the shape
  // dsh's own SDK renderer uses for the same problem.
  const method = (spec) => `    ${signature({ ...spec, name: spec.tool }, ['self'])}`
  const protocols = servers.flatMap(([server, tools]) => {
    const body = tools.filter((t) => isUsableName(t.tool)).sort(by((t) => t.tool)).map(method)
    // A server whose every tool name Python refuses would otherwise emit a class with an empty
    // body — a SyntaxError that takes the whole block with it. The attribute still has to exist:
    // the `getattr` line below reaches its tools through it.
    return ['', `class _Mcp${pascal(server)}(Protocol):`, ...(body.length === 0 ? ['    ...'] : body)]
  })
  const mcpBlock = servers.length === 0 ? [] : [
    ...protocols,
    '',
    'class _Mcp(Protocol):',
    ...servers.map(([server]) => `    ${server}: _Mcp${pascal(server)}`),
    '',
    'mcp: _Mcp',
  ]
  const classes = [...declarations].flatMap(([name, body]) => ['', `class ${name}(TypedDict):`, ...body.split('\n')])
  const typing = [
    // Whole identifiers: `AnyReportOutput` is a class name, not a use of `Any`, and a bare
    // `includes` imports a symbol a tool can spell into existence without ever needing it.
    signatures.concat(classes, mcpBlock).some((line) => /\bAny\b/.test(line)) && 'Any',
    classes.some((line) => line.includes('NotRequired[')) && 'NotRequired',
    declarations.size > 0 && 'TypedDict',
  ].filter(Boolean)
  const protocolImport = servers.length === 0 ? [] : ['Protocol']
  const lines = [
    INSTRUCTIONS,
    '',
    renderEnvironment(),
    '',
    '```python',
    ...(typing.concat(protocolImport).length === 0 ? [] : [`from typing import ${typing.concat(protocolImport).sort().join(', ')}`]),
    // `grouped`, not `servers`: a server whose own name Python refuses has no Protocol stub, but its
    // tools are still reached through `mcp` — the `getattr` line below names it. Keyed on the stubs,
    // a catalogue of nothing but such servers advertised `getattr(getattr(mcp, …))` without ever
    // importing `mcp`. The kernel binds it whenever an MCP tool exists, which is this condition.
    `from __dsh__.tools import ToolCallError${grouped.size === 0 ? '' : ', mcp'}${importable.map((spec) => `, ${spec.name}`).join('')}`,
    ...classes,
    ...mcpBlock,
    '',
    ...signatures,
    '```',
  ]
  if (oddMcp.length > 0) {
    lines.push('', `Under \`mcp\`, but not valid Python identifiers — reach these with \`getattr\`: ${oddMcp.map(({ server, tool, usableServer }) => (usableServer ? `\`getattr(mcp.${server}, ${JSON.stringify(tool)})\`` : `\`getattr(getattr(mcp, ${JSON.stringify(server)}), ${JSON.stringify(tool)})\``)).join(', ')}.`)
  }
  if (awkward.length > 0) {
    lines.push('', `Not valid Python identifiers — reach these with \`getattr\`: ${awkward.map((spec) => `\`getattr(__dsh__.tools, ${JSON.stringify(spec.name)})\``).join(', ')}.`)
  }
  // The grouping is a real package, so a server can also be imported as a module — which reads
  // better than `mcp.` at every call site when a cell leans on one server. The example is built
  // from a server that HAS an importable tool, not just the first one: a server whose every tool
  // name Python refuses would have put `import ...` in the line, handing the model a SyntaxError
  // as its example. If no server has one, the `getattr` route above is the only honest advice.
  const example = servers.flatMap(([server, tools]) => tools.filter((t) => isUsableName(t.tool)).map((t) => [server, t.tool])).at(0)
  if (example !== undefined) {
    lines.push('', `Each server is also a module: \`from __dsh__.tools.mcp.${example[0]} import ${example[1]}\` binds its tools directly.`)
  }
  lines.push('', 'Each is a real function: `name?` shows its full description, `dir(__dsh__.tools)` lists them.')
  return lines.join('\n')
}

/** Flatten model-facing content blocks to the text a program-visible error carries. */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
}

/**
 * Shape one finished cell into the model's observation.
 *
 * Tagged sections rather than one blob: with stdout, stderr, a return value and a traceback all possible at once, the model needs to know which is which. A bare successful value stays bare — the common case should not be noisy.
 *
 * Deliberately UNBOUNDED. `dsh-spill-policy` is a `tools/post-execute` waterfall over every tool, and at its configured `maxInlineBytes` it saves the full result to `ctx.spillStore` and hands the model a head/tail preview plus the path to `read` or `grep`. Eliding here would run FIRST and lose those bytes for good: the spill artifact holds what the tool returned, not what it had.
 */
function renderCell(result) {
  const sections = []
  const add = (tag, value) => {
    const text = (value ?? '').trim()
    if (text.length > 0) sections.push(`<${tag}>${text.includes('\n') ? `\n${text}\n` : text}</${tag}>`)
  }
  if (result.ok && !result.stdout.trim() && !result.stderr.trim() && !result.note) {
    return result.repr ?? '[[ execution successful, no output ]]'
  }
  add('stdout', result.stdout)
  add('stderr', result.stderr)
  if (result.ok) add('return', result.repr)
  else add('traceback', result.error ?? 'cell failed')
  add('note', result.note)
  return sections.join('\n') || '[[ execution successful, no output ]]'
}

export const name = PLUGIN_NAME
export const inject = ['tools', 'systemPrompt']

/**
 * The tool name the browser card registers for.
 *
 * Client bundles are composed once per package into a static boot graph — there is no per-session config channel — so the slot key cannot follow a configured `toolName`. Renaming the tool is supported; it just falls back to the generic row, and saying so beats letting the card vanish silently.
 */
const CARD_TOOL_NAME = 'python'

export function apply(ctx, config = {}) {
  // The profile-level row exists only so this package's browser half is scanned and served (see cordis.patch.yml). Registering the tool there would make it global; the agent preset row is what actually mounts the host half.
  if (config.uiOnly === true) return

  const toolName = config.toolName ?? 'python'
  // 'code' (default): `python` is the only directly callable tool — full CodeAct. 'both': the native schemas stay too, which is handy while debugging a composition.
  const exclusive = (config.mode ?? 'code') === 'code'
  if (toolName !== CARD_TOOL_NAME) {
    console.warn(`[dsh-py-codeact] toolName is ${JSON.stringify(toolName)}; the CodeAct card only renders for ${JSON.stringify(CARD_TOOL_NAME)}, so this tool falls back to the generic row`)
  }
  let warnedNoSession = false
  /** @type {Map<string, {kernel: PythonKernel, current: Map<string, unknown>, calls: number, sent: Map<string, string>, started: Promise<unknown> | undefined}>} */
  const kernels = new Map()

  ctx.on('dispose', () => {
    for (const entry of kernels.values()) entry.kernel.dispose()
    kernels.clear()
  })

  // Without this a kernel outlives its session: ~60-100MB of resident CPython per conversation tree that ever ran a cell, held until the harness exits.
  ctx.on('session/disposed', (session) => {
    const entry = kernels.get(session.id)
    if (entry === undefined) return
    kernels.delete(session.id)
    entry.kernel.closeShell(session.id)
    // The process belongs to the tree, not to any one agent: only tear it down once no agent still points at it.
    if (![...kernels.values()].includes(entry)) entry.kernel.dispose()
  })

  /**
   * The tools ONE agent can see. The scope argument is not optional in practice: omitting it yields the global view, which in a preset composition holds only host-registered tools — the preset's own `read`/`bash`/etc. live in the agent scope and would silently go missing.
   */
  // `sdkSchemas`, not `schemas`: the latter is the native-function-calling projection and drops `output`, which left every signature returning `Any`. Code Mode uses this same projection for the same reason.
  const visibleSchemas = (scope) => ctx.tools.sdkSchemas(scope).filter((schema) => schema.name !== toolName)

  ctx.systemPrompt.section({
    name: 'py-codeact:sdk',
    order: SDK_SECTION_ORDER,
    text: (assembly) => renderToolsSection(visibleSchemas(assembly.scope)),
  })

  // Injected at the seam rather than carried as a prompt section, because the position IS the information: everything above the notice ran in an interpreter that no longer exists, everything below runs in the new one. A section states the fact but cannot say where the boundary fell — and the model reads the transcript in order.
  ctx.on('agent/session-start', ({ agent }) => {
    // `session-start` also fires for `compact` and `clear`, where the interpreter is very much alive — and a resume inside the SAME process finds its kernel still running. Only an actually-absent interpreter means the bindings died.
    if (kernels.get(agent.id)?.kernel.alive === true) return
    if (!needsRestartNotice(agent.session, toolName, PLUGIN_NAME)) return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: RESTART_NOTICE }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME, form: 'notice', summary: 'dsh restarted — the Python session is gone' },
    }))
  })

  if (exclusive) {
    ctx.systemPrompt.section({ name: 'py-codeact:code-only', order: RULE_SECTION_ORDER, text: EXCLUSIVE_RULE })

    // Drop every other schema from the request. `ctx.tools.restrict()` cannot do this — it masks GLOBAL tools only, and in a preset the tools are scope-local ("scoped registrations remain visible"). The assemble waterfall is the layer that owns the model-facing list.
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      result.tools = result.tools.filter((schema) => schema.name === toolName)
      return result
    })

    // Presentation alone is not enforcement: a model that recalls a tool from earlier context can still emit a direct call. Deny it and name the route back, the way Code Mode's own denial does — a bare rejection reads as a broken deployment. Sub-dispatches carry `parent` and are exempt.
    ctx.effect(() => ctx.tools.guard((execution) => {
      if (execution.parent !== undefined || execution.name === toolName) return undefined
      return `only \`${toolName}\` is callable directly — call \`${execution.name}\` from inside a \`${toolName}\` cell instead: \`from __dsh__.tools import ${execution.name}\``
    }))
  }

  /**
   * Dispatch one bridged call under the cell running in the SHELL that made it. The kernel outlives any single execution, so the parent token, root id, and signal are read from the live slot rather than captured at kernel construction.
   *
   * Keyed by shell, not one slot per kernel: one entry backs every shell in the conversation tree, so a single slot meant a subagent's cell overwrote the parent's while the parent was still awaiting a tool. The parent's pending call then dispatched under the CHILD's callId, agent and signal — logged against the wrong agent, cancelled by the wrong turn — and when the child's cell ended it cleared the slot, so the parent's still-running cell was told no cell was running.
   */
  async function dispatch(entry, name, args, from) {
    const exec = entry.current.get(from)
    // Reachable two ways: a task the model detached with `create_task` calling a tool after its cell returned, and a genuinely unknown shell. Both are the same answer — there is no turn to attribute the call to, and no signal to cancel it with.
    if (exec === undefined) return { ok: false, message: `no cell is running in this shell — a tool call has to happen while a cell is on the stack, so a task detached with create_task cannot make one after its cell returned. Await it inside a cell instead.` }
    const subCallId = `${exec.callId}:py:${++entry.calls}`
    // `agent.session` is the same handle Code Mode's bridge logs through. Not optional-chained into silence: without it the sub-call still runs but leaves no SUBTOOL row, and a trace that quietly stops appearing is worse than a noisy one.
    const session = exec.agent?.session
    if (session === undefined && !warnedNoSession) {
      warnedNoSession = true
      console.warn(`[dsh-py-codeact] no agent on execution ${exec.callId}: sub-calls will run but not appear as SUBTOOL rows`)
    }
    const trace = { rootCallId: exec.rootCallId, parentCallId: exec.callId, subCallId, name, arguments: args }
    session?.append('tool/code-dispatch-start', trace)

    // Every outcome has to emit the terminal event, throws included: if `ctx.tools.execute` rejects rather than returning `{isError:true}` (an abort, a policy wrapper throwing), the Python side is still answered, but the SUBTOOL row would sit in the trajectory as "running" forever.
    try {
      const outcome = await ctx.tools.execute({
        callId: CallId(subCallId),
        rootCallId: exec.rootCallId,
        name,
        arguments: args,
        agent: exec.agent,
        parent: exec.token, // marks this as a transport sub-dispatch, not a model-direct call
        signal: exec.signal,
      })

      session?.append('tool/code-dispatch', { ...trace, isError: outcome.isError, content: outcome.content })
      // Pixels cannot travel through the bridge: `value` is JSON, so a `read_image` result reaches the cell as width/height/attachmentId and NOTHING to look at. Re-attach the blocks the way Code Mode does, and the image lands in the conversation right after this cell — the model sees it on its next step. Without this the model believes the call succeeded, gets metadata, and cannot tell why it still cannot see anything.
      if (!outcome.isError && contentHasImage(outcome.content ?? [])) {
        exec.deferContext(createUserMessage({ content: outcome.content, source: { kind: 'plugin', plugin: 'dsh-py-codeact' } }))
      }
      for (const context of outcome.additionalContexts ?? []) exec.deferContext(context)
      // `=== undefined` rather than `??`: a payload that IS `null` is the server's answer, and
      // falling back to the wrapper there would hand the cell the one shape it was promised not to see.
      const unwrapped = entry.envelopes.get(from)?.has(name) ? mcpPayload(outcome.value) : undefined
      return outcome.isError
        ? { ok: false, message: contentText(outcome.content) || 'tool call failed' }
        : { ok: true, value: unwrapped === undefined ? outcome.value : unwrapped.value }
    } catch (error) {
      session?.append('tool/code-dispatch', { ...trace, isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] })
      throw error
    }
  }

  /**
   * The kernel serving one agent, and the shell within it.
   *
   * ONE process per conversation tree, one shell per agent inside it. A subagent therefore costs an `init` frame rather than another interpreter: it shares the event loop, `sys.modules`, the installed packages and `__dsh__.shared`, while its globals stay its own.
   *
   * The tree is found without any session lookup — a parent necessarily runs a cell before it can delegate, so by the time a child executes, its `parentSession` is already a key here.
   */

  async function kernelFor(exec, specs) {
    const shell = exec.agent?.id ?? 'main'
    const parent = exec.agent?.session?.header?.parentSession
    const previous = kernels.get(shell) ?? (parent === undefined ? undefined : kernels.get(parent))
    if (previous !== undefined) {
      try {
        await previous.started
        if (previous.kernel.alive) {
          kernels.set(shell, previous)
          await previous.kernel.start(specs, shell) // no-op once this shell exists
          return { entry: previous, shell, restarted: false }
        }
      } catch { /* it never came up — fall through and replace it */ }
    }
    // One entry backs every shell in the conversation tree, so `sent` is keyed BY SHELL. `calls` is the exception: it only has to make `subCallId` unique, so process-wide is right.
    const entry = { kernel: undefined, current: new Map(), calls: 0, sent: new Map(), envelopes: new Map(), started: undefined }
    entry.kernel = new PythonKernel({
      command: config.command ?? (config.python === undefined ? undefined : [config.python, KERNEL_PY]),
      cwd: exec.agent?.session?.header?.cwd ?? process.cwd(),
      env: config.inheritEnv === true ? process.env : undefined,
      ephemeralEnv: config.ephemeralEnv !== false,
      hardInterruptMs: config.hardInterruptMs,
      onCall: (name, args, from) => dispatch(entry, name, args, from),
    })
    entry.started = entry.kernel.start(specs, shell)
    kernels.set(shell, entry)
    await entry.started
    pythonEnv = entry.kernel.pythonEnv ?? pythonEnv
    // A kernel replaced mid-conversation (an unyielding cell got killed) is the one case `agent/session-start` cannot cover: no session began, so nothing fires. The observation prefix carries it instead, at the exact cell that noticed.
    return { entry, shell, restarted: previous !== undefined }
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description:
      'Run one cell in a persistent IPython session. State (imports, variables, open handles) survives between calls. Top-level `await` works and a trailing expression is echoed. Every other harness tool is an awaitable in the `__dsh__.tools` module — `from __dsh__.tools import read`, then `await read(...)`. Only the cell output and its final expression return to you. A successful tool result containing an image is attached after the run so you can inspect it on the next step.',
    parameters: {
      code: { type: 'string', required: true, description: 'Python source for this cell.' },
      // Required, like `run_code`'s: it IS the card title, so an optional one leaves the UI showing the first line of code as a header.
      description: { type: 'string', required: true, description: 'Short summary of what this cell does.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    // No `isConcurrencySafe`: cells mutate the shell's namespace, so this agent's cells must stay exclusive ordering barriers. That is a per-AGENT constraint, not a per-process one — the kernel tracks one in-flight task per shell, so a subagent's cell runs alongside its parent's just fine.
    async execute(args, exec) {
      const { specs, envelopes } = toolSpecs(visibleSchemas(exec.agent))
      const { entry, shell, restarted: wasRestarted } = await kernelFor(exec, specs)
      entry.current.set(shell, exec)
      entry.envelopes.set(shell, envelopes)
      try {
        // Only resend the bindings when the visible set actually moved — an unchanged catalogue is the norm, and it is 30+ schemas on the wire.
        const key = specsKey(specs)
        const rebind = key === entry.sent.get(shell) ? undefined : specs
        const result = await entry.kernel.exec(args.code, exec.signal, rebind, shell)
        const observation = renderCell(result)
        // Only once the kernel has actually taken them: a cell that never dispatched (an already-cancelled turn) would otherwise leave us believing the bindings landed, and the next cell would skip the rebind and run against a stale tool table. A busy kernel answers the same way — an ordinary `ok: false` frame, so this resolves rather than throwing — and it rebinds NOTHING before doing so, which is why the outcome has to be inspected and not just awaited.
        if (result.ok || result.error !== KERNEL_BUSY) entry.sent.set(shell, key)
        return wasRestarted
          ? `[the interpreter was restarted; every earlier binding is gone]\n${observation}`
          : observation
      } catch (error) {
        // The kernel dying mid-cell is not this cell's fault and usually not its doing: `hardInterruptMs` escalates to SIGKILL on the PROCESS, but the interrupt it backstops is per-shell, so a sibling's runaway loop takes this shell's namespace with it. Surfacing the raw `KernelDeadError` read as a harness fault for a cancellation this agent had no part in. State really is gone either way — say that, in the same words the restart notice uses, and let the model rebuild.
        if (error?.name !== 'KernelDeadError') throw error
        entry.sent.delete(shell)
        return `[the interpreter is gone; every earlier binding with it. This can happen without anything wrong in this cell — one process backs every agent in the conversation tree, so a sibling's cell that would not yield to an interrupt is killed outright and takes the process with it. Rebuild what you need.]\n<error>\n${error.message}\n</error>`
      } finally {
        entry.current.delete(shell)
      }
    },
    // Same shape `run_code` uses. NOTE: it will not render as the syntax- highlighted "Code" card — `dsh-client-ui-tool` keys that variant off a hardcoded `TOOL_VARIANTS` map (`run_code: 'code'`, `lang: 'typescript'`), not off the call view, and `run_code` is a reserved name. A terminal card was worse: it rendered the cell's first line as if it were a shell command. No `presentResult` — the raw result content is what a code card shows, and the tagged sections already read well.
    presentCall: (args) => ({
      card: 'generic',
      title: args.description,
      kind: 'execute',
      rawInput: args.code,
    }),
  })))
}

export default { name, inject, apply }
