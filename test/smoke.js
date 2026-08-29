/**
 * Standalone smoke test for the kernel + wire protocol — no dsh required. Run: node test/smoke.js
 */

import assert from 'node:assert/strict'
import { PythonKernel } from '../lib/kernel.js'
import { renderToolsSection, needsRestartNotice, specsKey, mcpPayload } from '../lib/index.js'
import { execFileSync } from 'node:child_process'

const calls = []
const kernel = new PythonKernel({
  cwd: process.cwd(),
  onCall: async (name, args) => {
    calls.push({ name, args })
    if (name === 'boom') return { ok: false, message: 'upstream exploded' }
    if (name === 'slow') { await new Promise((r) => setTimeout(r, 1200)); return { ok: true, value: { finished: args.x } } }
    return { ok: true, value: { echoed: args, from: name } }
  },
})

const SPECS = [
  { name: 'read', doc: 'Read a file from the workspace.\nReturns {path, lines}.', params: [
      { name: 'file_path', type: 'str', required: true },
      { name: 'offset', type: 'int', required: false }] },
  { name: 'boom', doc: 'Always fails.', params: [{ name: 'x', type: 'int', required: true }] },
  { name: 'slow', doc: 'Takes a while.', params: [{ name: 'x', type: 'int', required: true }] },
]
await kernel.start(SPECS)
const run = (code) => kernel.exec(code, undefined, SPECS)
let failures = 0
const check = async (label, code, verify, specs, omitSpecs = false) => {
  const result = omitSpecs ? await kernel.exec(code, undefined, undefined)
    : specs === undefined ? await run(code) : await kernel.exec(code, undefined, specs)
  try {
    verify(result)
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}\n       got: ${JSON.stringify(result)}`)
  }
}

console.log('kernel:')

await check('persists state across cells (bind)', 'counter = 40', (r) => {
  assert.equal(r.ok, true)
  assert.equal(r.repr, undefined) // an assignment is not an expression — nothing echoed
})

await check('persists state across cells (read back)', 'counter + 2', (r) => {
  assert.equal(r.ok, true)
  assert.equal(r.repr, '42') // REPL echo of the trailing expression
})

await check('store_history binds `_`', '_', (r) => assert.equal(r.repr, '42'))

await check('captures stdout', 'print("hello"); print("world")', (r) => {
  assert.equal(r.stdout, 'hello\nworld\n')
})

await check('imports survive', 'import json\njson.dumps({"a": 1})', (r) => {
  assert.match(r.repr, /"a": 1/)
})

await check('IPython magics work', '%whos', (r) => {
  assert.equal(r.ok, true)
  assert.match(r.stdout, /counter/) // the magic table lists the session's bindings
})

await check('redundant re-import is flagged', 'import json', (r) => {
  assert.equal(r.ok, true)
  assert.match(r.note, /`json` is already imported/)
})

// The hint only fires when a name is rebound to the object it already holds, so it has to tell an import apart from a coincidental self-assignment — and the disassembly that does so is now cached, which is exactly the kind of change that silently removes a feature while making it fast.
await check('a coincidental rebind is not mistaken for a re-import', 'zz = 1\nzz = zz', (r) => {
  assert.equal(r.ok, true)
  assert.equal(r.note, undefined, 'only imports earn the hint')
})

// Interned values (`None`, `True`, small ints) make every top-level iteration take the hint path. Re-disassembling the whole cell there cost 771ms against 0.1ms for the same work in a function body — for a hint that never fired.
await check('a hot top-level loop does not pay for the hint', 'import time\n_t = time.perf_counter()\nfor _i in [None] * 20000:\n    _j = _i\n(time.perf_counter() - _t) < 0.2', (r) => {
  assert.equal(r.repr, 'True', 'rebinding an interned value 20k times must not re-scan the cell each round')
})

await check('from __dsh__.tools import <name>', 'from __dsh__.tools import read\nawait read(file_path="/etc/hosts")', (r) => {
  assert.equal(r.ok, true)
  assert.match(r.repr, /'from': 'read'/)
  assert.deepEqual(calls.at(-1), { name: 'read', args: { file_path: '/etc/hosts' } })
})

await check('import __dsh__.tools as a module', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
  assert.equal(r.repr, `['boom', 'read', 'slow']`)
})

await check('dsh description becomes the docstring', 'read.__doc__.splitlines()[0]', (r) => {
  assert.equal(r.repr, `'Read a file from the workspace.'`)
})

await check('parameters become a keyword-only signature', 'import inspect\nstr(inspect.signature(read))', (r) => {
  assert.match(r.repr, /file_path/)
  assert.match(r.repr, /\*/) // keyword-only
})

await check('`read?` works in the REPL', 'read?', (r) => {
  assert.equal(r.ok, true)
  assert.match(r.stdout, /Read a file from the workspace/)
})

await check('a tool dropped between cells disappears', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
  assert.equal(r.repr, `['read']`)
}, [SPECS[0]])

await check('and comes back when the host resends it', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
  assert.equal(r.repr, `['boom', 'read', 'slow']`)
})

await check('omitting `tools` leaves the bindings in place', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
  assert.equal(r.repr, `['boom', 'read', 'slow']`)   // the host skips a rebind that would change nothing
}, undefined, true)

await check('tool failure raises a catchable ToolCallError', `
from __dsh__.tools import boom, ToolCallError
try:
    await boom(x=1)
except ToolCallError as e:
    print(f"caught {e.tool_name}: {e}")
`, (r) => {
  assert.equal(r.ok, true)
  assert.equal(r.stdout.trim(), 'caught boom: upstream exploded')
})

await check('concurrent calls via asyncio.gather', `
import asyncio
rs = await asyncio.gather(read(file_path="a"), read(file_path="b"))
[r["echoed"]["file_path"] for r in rs]
`, (r) => assert.equal(r.repr, `['a', 'b']`))

await check('exception returns an IPython traceback, kernel survives', '1 / 0', (r) => {
  assert.equal(r.ok, false)
  assert.match(r.error, /ZeroDivisionError/)
  assert.doesNotMatch(r.error, /\u001b\[/) // rendered without ANSI colors
})

await check('state intact after the exception', 'counter', (r) => assert.equal(r.repr, '40'))

// fd 3 is non-blocking, so a frame past the socket send buffer (8 KiB on macOS) used to be short-written mid-JSON, silently. The next frame concatenated onto the stump, the host dropped one unparsable blob, and the session wedged: no `done` ever arrived and every later cell hung too.
await check('a cell far larger than the pipe buffer round-trips', "print('X' * 300_000)", (r) => {
  assert.equal(r.ok, true)
  assert.equal(r.stdout.length, 300_001)
})

await check('and the kernel is still healthy afterwards', '1 + 1', (r) => assert.equal(r.repr, '2'))

// Bindings are routed per shell rather than written into the module's __dict__, but a tool may still not take a name the module itself owns: `ToolCallError` is the class the prompt tells the model to catch.
await check('a tool cannot shadow the module internals', 'import __dsh__.tools as T\n(T.ToolCallError.__name__, sorted(dir(T)))', (r) => {
  assert.match(r.repr, /'ToolCallError'/)
  assert.doesNotMatch(r.repr, /_rebind/, '`_`-leading tool names must be refused')
}, [...SPECS, { name: '_rebind', doc: 'hostile', params: [] }, { name: 'ToolCallError', doc: 'hostile', params: [] }])

// One unrenderable parameter name used to discard the whole signature, leaving `read?` and the system prompt showing two contradictory pictures.
await check('one exotic parameter name does not discard the whole signature', 'import inspect\nfrom __dsh__.tools import odd\nstr(inspect.signature(odd))', (r) => {
  assert.match(r.repr, /good: /, 'the renderable parameters must survive')
  assert.match(r.repr, /\*\*kwargs/, 'and the rest must be visibly folded in')
}, [...SPECS, { name: 'odd', doc: 'exotic params', params: [
  { name: 'good', type: 'str', required: true },
  { name: 'file-path', type: 'str', required: true },
  { name: 'class', type: 'str', required: false }] }])

// The idiom this whole loop exists for: discover targets in code, feed them straight in. A `Path` is not JSON-serializable, so this used to die with a TypeError raised mid-frame and force `str(p)` at every call site.
await check('discovered Path objects can be passed straight to a tool', `
from pathlib import Path
import asyncio
paths = sorted(Path().glob('*.md'))
rs = await asyncio.gather(*(read(file_path=p) for p in paths))
[r["echoed"]["file_path"] for r in rs]
`, (r) => {
  assert.equal(r.ok, true)
  assert.doesNotMatch(r.repr, /PosixPath/, 'the tool must receive plain strings')
  assert.match(r.repr, /README\.md/, 'and the real paths it globbed')
})

// `uv pip install` refuses without VIRTUAL_ENV, and IPython's `!cmd` does not fail the cell on a non-zero exit — so the install looked fine and the import failed a cell later, with nothing connecting the two. Each kernel gets a throwaway venv inheriting the base one, so a cell's `!uv pip install` cannot leak into the shared PEP 723 environment that every session and every future run resolves to.
await check('the kernel runs in a throwaway venv, not the shared one', 'import sys\n("dsh-py-codeact-" in sys.prefix, "IPython" in sys.modules)', (r) => {
  assert.equal(r.repr, '(True, True)')   // isolated, yet the inherited packages are there
})

await check('the kernel points uv at its own environment', 'import os, sys\n(os.path.realpath(os.environ.get("VIRTUAL_ENV", "")) == os.path.realpath(sys.prefix), sys.prefix != sys.base_prefix)', (r) => {
  assert.equal(r.repr, '(True, True)')
})

await check('unknown tool is a clean ImportError', 'from __dsh__.tools import nope', (r) => {
  assert.equal(r.ok, false)
  assert.match(r.error, /cannot import name 'nope'/)
})

// The value is already delivered as `repr`; IPython's own `Out[n]: …` echo would put it in stdout as well, showing the model everything twice.
await check('a returned value is not echoed into stdout', '40 + 2', (r) => {
  assert.equal(r.repr, '42')
  assert.equal(r.stdout, '')
})

// objprint's cycle guard lives in the `_objstr` we override; without mirroring it, a back-reference recurses until the stack blows — and the traceback used to escape `run_cell`, so no `done` frame was sent and the turn hung forever.
await check('a self-referential object does not blow the stack', `
class Node: pass
n = Node(); n.parent = n; n.label = "root"
n
`, (r) => {
  assert.equal(r.ok, true)
  assert.match(r.repr, /label/)
})

// Compile-time failures reach `showsyntaxerror`, not `showtraceback`, and print with a bare print() — straight into the captured stdout, ANSI and all.
await check('a syntax error does not leak ANSI into stdout', 'def f(:', (r) => {
  assert.equal(r.ok, false)
  assert.match(r.error, /SyntaxError/)
  assert.equal(r.stdout, '', 'the traceback must not be echoed into stdout')
  assert.doesNotMatch(r.error, /\[/)
})

// A logging handler resolves `sys.stderr` once, at construction. With a fresh capture object per cell, every later log line lands in a dead buffer.
await check('logging configured in an earlier cell still reaches stderr', `
import logging
logging.basicConfig(level=logging.INFO, force=True)
logging.info("first")
`, (r) => assert.match(r.stderr, /first/))

await check('...and from the next cell too', 'logging.info("second")', (r) => {
  assert.match(r.stderr, /second/)
})

// Interrupt: a cell blocked on an await must be cancellable.
console.log('interrupt:')
const controller = new AbortController()
const slow = kernel.exec('import asyncio\nawait asyncio.sleep(30)\n"never"', controller.signal)
setTimeout(() => controller.abort(), 300)
const interrupted = await slow
try {
  assert.equal(interrupted.ok, false)
  assert.match(interrupted.error, /cancelled this cell/)
  assert.equal(interrupted.stderr, "") // IPython's colored traceback must not leak into the capture
  console.log('  ok   cancels a cell parked on await')
} catch (error) {
  failures += 1
  console.log(`  FAIL cancels a cell parked on await\n       ${error.message}\n       got: ${JSON.stringify(interrupted)}`)
}

// The persistent kernel's real leverage: a task detached with `create_task` outlives the cell that started it, so the model can fire work off, return, and collect it turns later. Failing every in-flight bridge call on interrupt used to kill a subagent launched three cells earlier.
{
  await run('import asyncio\nfrom __dsh__.tools import slow\nbg = asyncio.create_task(slow(x=7))\nNone')
  const controller = new AbortController()
  const doomed = kernel.exec('await asyncio.sleep(30)', controller.signal, SPECS)
  setTimeout(() => controller.abort(), 200)
  await doomed
  const collected = await run('await bg')
  try {
    assert.equal(collected.ok, true, 'a detached task must survive another cell being interrupted')
    assert.equal(collected.repr, `{'finished': 7}`)
    console.log('  ok   a background task outlives an unrelated interrupt')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a background task outlives an unrelated interrupt\n       ${error.message}\n       got: ${JSON.stringify(collected)}`)
  }
}

await check('kernel still usable after an interrupt', 'counter * 2', (r) => assert.equal(r.repr, '80'))

// A signal aborted BEFORE dispatch never fires its listener. The cell used to run to completion — side effects and all — and report success.
try {
  const already = new AbortController()
  already.abort()
  await assert.rejects(kernel.exec('side_effect = "should never bind"', already.signal, SPECS))
  const check2 = await run('"side_effect" in dir()')
  assert.equal(check2.repr, 'False', 'the cancelled cell must not have run')
  console.log('  ok   an already-cancelled cell is never dispatched')
} catch (error) {
  failures += 1
  console.log(`  FAIL an already-cancelled cell is never dispatched\n       ${error.message}`)
}

// The interpreter must be the process we hold, with nothing in between: a wrapper (`uv run --script`) exits first, the interpreter is reparented to init, our handle reports an exit, and a live kernel looks dead — respawning and silently losing the session's state.
{
  const pid = await run('import os\nos.getpid()')
  const again = await run('import os\nos.getpid()')
  const ppid = await run('import os\nos.getppid()')
  try {
    assert.equal(pid.repr, again.repr, 'the same interpreter must serve every cell')
    assert.equal(Number(pid.repr), kernel.proc.pid, 'the spawned process IS the interpreter, not a wrapper')
    assert.equal(Number(ppid.repr), process.pid, 'the interpreter is our direct child')
    assert.equal(kernel.alive, true)
    console.log('  ok   one persistent interpreter, directly owned')
  } catch (error) {
    failures += 1
    console.log(`  FAIL one persistent interpreter, directly owned\n       ${error.message}`)
  }
}

// A CPU-bound cell never reaches the signal handler; the escalation must kill it rather than hang the turn forever. State is lost — the caller respawns.
const hot = new PythonKernel({ cwd: process.cwd(), hardInterruptMs: 500, onCall: async () => ({ ok: true, value: null }) })
await hot.start([])
const hotController = new AbortController()
const spin = hot.exec('while True: pass', hotController.signal)
setTimeout(() => hotController.abort(), 200)
try {
  await spin
  failures += 1
  console.log('  FAIL escalates on a CPU-bound cell\n       expected the kernel to be killed')
} catch (error) {
  assert.equal(error.name, 'KernelDeadError')
  assert.equal(hot.alive, false)
  console.log('  ok   escalates to SIGKILL on a CPU-bound cell')
}

// A spawn that fails emits 'error' and never 'exit'. Without marking the kernel dead there, `alive` stays true forever and every later cell is handed the corpse; the unhandled stream error took down the whole harness process first.
{
  const broken = new PythonKernel({ cwd: process.cwd(), command: ['/nonexistent/python', 'x'], onCall: async () => ({ ok: true, value: null }) })
  try {
    await assert.rejects(broken.start([]), { name: 'KernelDeadError' })
    assert.equal(broken.alive, false, 'a kernel that never started is not alive')
    await assert.rejects(broken.exec('1', undefined, []), { name: 'KernelDeadError' })
    console.log('  ok   a failed spawn is dead, not silently alive')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a failed spawn is dead, not silently alive\n       ${error.message}`)
  }
}

// Each of these used to be unrecoverable — a wedged turn, a dead interpreter, a discarded observation — and each is reachable from ordinary model code.
console.log('survivable cell content:')
for (const [label, code, check] of [
  // `json.dumps` accepts a lone surrogate and `.encode('utf-8')` then raises, in the send that answers the exec. No `done` frame ever arrived and the turn hung forever; measured at the 15s timeout below.
  ['a lone surrogate does not wedge the turn', String.raw`print(b'x\xff'.decode('utf-8','surrogateescape')); 'survived'`, (r) => r.ok && r.repr.includes('survived')],
  // asyncio's default 64 KiB line limit is below a realistic frame — a large cell, or an `init` carrying ~40 tool schemas. Overrunning it raised out of `readline` and took every shell in the tree with it.
  ['a cell larger than the 64 KiB line limit runs', `x = "${'A'.repeat(200_000)}"; len(x)`, (r) => r.ok && r.repr === '200000'],
  // A raising `__repr__` escaped into the blanket handler, whose frame hardcodes empty streams: the cell's real output was thrown away and a successful run was reported as a kernel fault.
  ['a raising __repr__ keeps the rest of the observation', 'class Bad:\n    def __repr__(self): raise ValueError("boom")\nprint("stdout survives")\nBad()', (r) => r.ok && r.stdout.includes('stdout survives') && r.repr.includes('__repr__ raised')],
]) {
  try {
    const result = await Promise.race([
      kernel.exec(code, undefined, undefined, 'survivable'),
      new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('no `done` frame within 15s')), 15_000).unref()),
    ])
    assert.ok(check(result), `${label} — got ${JSON.stringify(result).slice(0, 160)}`)
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

// The interpreter must still be there afterwards — each failure above used to kill it or the harness.
try {
  const alive = await kernel.exec('x[:3] + "|alive"', undefined, undefined, 'survivable')
  assert.equal(alive.repr, "'AAA|alive'", 'the shell keeps its state through all of the above')
  console.log('  ok   the interpreter survives all three')
} catch (error) {
  failures += 1
  console.log(`  FAIL the interpreter survives all three\n       ${error.message}`)
}

// Model cell sources used to land in the USER's own ~/.ipython history.sqlite (87 MB / 47k cells here), shared with their interactive ipython and contended by every kernel at once.
console.log('kernel hygiene:')
try {
  const hist = await kernel.exec('get_ipython().history_manager.hist_file', undefined, undefined, 'survivable')
  assert.equal(hist.repr, "':memory:'", 'history must not touch the user\'s profile')
  const cache = await kernel.exec('get_ipython().displayhook.cache_size', undefined, undefined, 'survivable')
  assert.ok(Number(cache.repr) <= 100, 'Out[n] retention must be bounded — the default 1000 pins 1000 live values')
  console.log('  ok   history stays in memory and Out[n] retention is bounded')
} catch (error) {
  failures += 1
  console.log(`  FAIL history stays in memory and Out[n] retention is bounded\n       ${error.message}`)
}

// The host skips a rebind whenever this key is unchanged, so anything the kernel would render differently has to move it. The shell-level tests below cannot cover this: they drive `kernel.exec` directly, past the layer that makes the decision.
console.log('rebind identity:')
try {
  const base = [{ name: 'read', doc: 'original', params: [{ name: 'p', type: 'str', required: true }] }]
  const sameNames = (specs) => specsKey(base) === specsKey(specs)
  assert.ok(sameNames(structuredClone(base)), 'an identical catalogue must not force a rebind')
  assert.ok(!sameNames([{ ...base[0], doc: 'revised' }]), 'a changed description must force one — it is the docstring `read?` prints')
  assert.ok(!sameNames([{ ...base[0], params: [...base[0].params, { name: 'limit', type: 'int', required: false }] }]), 'a new parameter must force one')
  assert.ok(!sameNames([{ ...base[0], params: [{ name: 'p', type: 'str', required: false }] }]), 'a parameter that stops being required must force one')
  console.log('  ok   the key moves for anything the kernel would render differently')
} catch (error) {
  failures += 1
  console.log(`  FAIL the key moves for anything the kernel would render differently\n       ${error.message}`)
}

// The prompt block is Python the model copies from. One tool it cannot render used to invalidate the WHOLE block, so no line in it could be used.
console.log('prompt:')
{
  const pythonBlock = (text) => text.split('```python\n')[1]?.split('```')[0] ?? ''
  const parses = (code) => {
    try {
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: code, stdio: ['pipe', 'ignore', 'pipe'] })
      return true
    } catch { return false }
  }
  const cases = [
    ['a hyphenated MCP tool name', [{ name: 'mcp__srv__do-thing', parameters: { properties: { q: { type: 'string' } }, required: ['q'] } }, { name: 'read', parameters: { properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]],
    ['a tool with no parameters', [{ name: 'list_todos', parameters: {} }]],
    ['no tools at all', []],
    // Both of these match the identifier pattern and then break `import`/`def` anyway. Every case above varies the tool NAME only; the parameter axis went unchecked even though the kernel's own fixture below uses `file-path` and `class` as parameter names, i.e. the repo already asserts they arrive.
    ['a tool named after a Python keyword', [{ name: 'class', parameters: { properties: { q: { type: 'string' } }, required: ['q'] } }, { name: 'read', parameters: {} }]],
    ['parameter names that are not valid Python', [{ name: 'odd', parameters: { properties: { 'good': { type: 'string' }, 'file-path': { type: 'string' }, 'class': { type: 'string' } }, required: ['good'] } }, { name: 'read', parameters: {} }]],
  ]
  for (const [label, schemas] of cases) {
    try {
      const rendered = renderToolsSection(schemas)
      assert.ok(parses(pythonBlock(rendered)), `the rendered block must be valid Python`)
      assert.match(rendered, /import ToolCallError/, 'the class the prompt says to catch must be importable')
      console.log(`  ok   renders valid Python for ${label}`)
    } catch (error) {
      failures += 1
      console.log(`  FAIL renders valid Python for ${label}\n       ${error.message}`)
    }
  }
  try {
    // An MCP tool is reached through `mcp.<server>`, so its `getattr` route is one level deeper —
    // `mcp__notion__API-patch-block-children` is a real name from a real server, hyphens and all.
    const rendered = renderToolsSection([{ name: 'mcp__srv__do-thing', parameters: {} }])
    assert.match(rendered, /getattr\(mcp\.srv, "do-thing"\)/, 'an unimportable MCP tool is reachable under its server')
    assert.ok(!rendered.includes('mcp__srv__do-thing'), 'and is not also offered under the flat name the block no longer shows')
    // A server whose OWN name Python refuses needs both levels spelled out.
    const oddOnly = renderToolsSection([{ name: 'mcp__odd-srv__thing', parameters: {} }])
    assert.match(oddOnly, /getattr\(getattr\(mcp, "odd-srv"\), "thing"\)/, 'so does a server Python cannot name')
    // Such a server gets no Protocol stub, but that line still reaches its tools through `mcp` — a
    // catalogue of nothing else used to name `mcp` there without importing it.
    assert.match(oddOnly, /import ToolCallError, mcp\n/, 'and `mcp` is imported even when no server has a nameable name')
    assert.match(renderToolsSection([{ name: 'class', parameters: {} }]), /getattr\(__dsh__\.tools, "class"\)/, 'a keyword-named native tool keeps the top-level route')
    // `mcp` is the namespace's name. A native tool wearing it used to be rendered too, so the
    // import line named `mcp` twice and a signature promised a call the kernel never binds.
    const collide = renderToolsSection([{ name: 'mcp__srv__thing', parameters: {} }, { name: 'mcp', parameters: {}, output: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } }])
    assert.match(collide, /import ToolCallError, mcp\n/, 'the reserved name is imported once, as the namespace')
    assert.ok(!collide.includes('async def mcp('), 'and no signature offers it as a tool')
    // Dropped where the specs are normalised, not at the render: downstream of the declarations,
    // its output schema still became a `TypedDict` that nothing referenced.
    assert.ok(!collide.includes('McpOutput'), 'and its output schema declares nothing')
    console.log('  ok   points at getattr for names that are not identifiers')
  } catch (error) {
    failures += 1
    console.log(`  FAIL points at getattr for names that are not identifiers\n       ${error.message}`)
  }
  // The return type is the one thing a model cannot recover by reading harder: an unknown return shape costs a whole turn per tool — call once, print, then write the cell that uses it.
  try {
    const rendered = renderToolsSection([
      { name: 'read', parameters: { properties: { file_path: { type: 'string' } }, required: ['file_path'] }, output: { type: 'string' } },
      { name: 'glob', parameters: { properties: { pattern: { type: 'string' } }, required: ['pattern'] }, output: { type: 'array', items: { type: 'string' } } },
    ])
    assert.match(rendered, /async def read\(\*, file_path: str\) -> str: \.\.\./, "a tool's declared output type must reach the signature")
    assert.match(rendered, /async def glob\(\*, pattern: str\) -> list\[str\]: \.\.\./, 'including container types')
    // `schemas()` has no `output`; only `sdkSchemas()` carries it. Rendering `Any` there is right — asserting a wrong type would be worse than admitting ignorance.
    assert.match(renderToolsSection([{ name: 'read', parameters: {} }]), /async def read\(\) -> Any: \.\.\./, 'a schema with no output falls back to Any')
    // The Protocol stubs are rendered Python too, and reach `Any` by the same routes a top-level
    // signature does — the import used to be derived from the signatures alone.
    const stubAny = renderToolsSection([{ name: 'mcp__cal__list', parameters: {} }])
    assert.match(stubAny, /async def list\(self\) -> Any: \.\.\./, 'including inside a server stub')
    assert.match(stubAny, /from typing import Any, Protocol\n/, 'which has to import `Any` like any other use of it')
    console.log('  ok   renders each tool\'s real return type')
  } catch (error) {
    failures += 1
    console.log(`  FAIL renders each tool's real return type\n       ${error.message}`)
  }
  // dsh's MCP client wraps every result as `{ content, structuredContent? }`. That wrapper is
  // transport, not API: `content`'s text duplicates the payload and an image in it is re-attached
  // to the conversation separately, so a cell that receives the wrapper can only hand-write
  // `r["structuredContent"]["result"]` — and spend a call learning it has to. The bridge unwraps,
  // and the annotation describes what the cell actually receives.
  try {
    const envelope = (inner) => ({
      type: 'object',
      properties: { content: { type: 'array', items: {} }, structuredContent: inner ?? {} },
      required: inner === undefined ? ['content'] : ['content', 'structuredContent'],
      additionalProperties: false,
    })
    const payload = { type: 'object', properties: { merchants: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' } }, required: ['merchants'] }
    const rendered = renderToolsSection([
      { name: 'mcp__review__search', parameters: { properties: { q: { type: 'string' } }, required: ['q'] }, output: envelope(payload) },
      { name: 'mcp__email__ping', parameters: { properties: {} }, output: envelope(undefined) },
    ])
    assert.match(rendered, /class _McpReview\(Protocol\):\n {4}async def search\(self, \*, q: str\) -> McpReviewSearchOutput: \.\.\./, 'a declared payload names its own type')
    assert.match(rendered, /class McpReviewSearchOutput\(TypedDict\):\n {4}merchants: list\[str\]\n {4}total: NotRequired\[int\]/, 'and that type is the payload, not the wrapper')
    assert.ok(!rendered.includes('structuredContent'), 'the wrapper is never named — the cell does not receive it')
    // No declared payload means the client has only the text blocks to hand over, so `str` is the
    // whole truth. Not every server declares an output schema; this is the common case in the wild.
    assert.match(rendered, /async def ping\(self\) -> str: \.\.\./, 'an envelope with no payload resolves to its text')
    console.log('  ok   an MCP envelope is unwrapped, in the annotation and at run time')
  } catch (error) {
    failures += 1
    console.log(`  FAIL an MCP envelope is unwrapped, in the annotation and at run time\n       ${error.message}`)
  }
  // The run-time half of the same rule. It keys off the value's own shape, so a tool that merely
  // returns something similar keeps its value: unwrapping a payload nobody wrapped would be a
  // silent, unannounced change to what that tool returns.
  try {
    assert.deepEqual(mcpPayload({ content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } }), { value: { a: 1 } }, 'a declared payload is handed over bare')
    assert.deepEqual(mcpPayload({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), { value: 'one\ntwo' }, 'no payload means the text blocks, joined')
    assert.deepEqual(mcpPayload({ content: [] }), { value: '' }, 'an empty envelope is an empty string, not a crash')
    // A payload that IS `null` is the server's answer. Reported as a wrapper carrying null, so the
    // caller cannot confuse it with "not a wrapper" and fall back to handing over the wrapper itself.
    assert.deepEqual(mcpPayload({ content: [], structuredContent: null }), { value: null }, 'a null payload stays null')
    assert.equal(mcpPayload({ content: [], structuredContent: {}, extra: 1 }), undefined, 'an extra key means this is not the wrapper')
    assert.equal(mcpPayload({ paths: ['a'], root: '.' }), undefined, "a plain tool's value is untouched")
    assert.equal(mcpPayload({ content: 'not-an-array' }), undefined, 'so is a value whose `content` is not the block array')
    assert.equal(mcpPayload('a string'), undefined, 'and a scalar')
    assert.equal(mcpPayload(null), undefined, 'and null')
    console.log('  ok   only the wrapper is unwrapped, and only when it is one')
  } catch (error) {
    failures += 1
    console.log(`  FAIL only the wrapper is unwrapped, and only when it is one\n       ${error.message}`)
  }
  // The class NAME can be unusable too, and that one is not local damage: `class 123toolOutput`
  // is a SyntaxError that takes the whole block with it, including every tool that was fine —
  // and it happens for a tool that is not even importable, whose class nothing would reference.
  try {
    const output = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const rendered = renderToolsSection([{ name: '123tool', parameters: { properties: {} }, output }, { name: 'ok', parameters: { properties: {} }, output }])
    // The name itself SHOULD still appear — in the `getattr` line, which is how such a tool is reached.
    assert.ok(!/class 123tool/.test(rendered), 'no class is declared under a name Python cannot take')
    assert.match(rendered, /getattr\(__dsh__\.tools, "123tool"\)/, 'the tool is still reachable, only its annotation goes vague')
    assert.match(rendered, /class OkOutput\(TypedDict\):\n {4}a: str/, 'the tools that were fine still get theirs')
    assert.match(rendered, /async def ok\(\) -> OkOutput: \.\.\./, 'and still reference it')
    console.log('  ok   a tool name Python cannot take costs its class, not the block')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a tool name Python cannot take costs its class, not the block\n       ${error.message}`)
  }
  // The import line has to name what the render USED. A tool can otherwise spell a typing symbol
  // into existence — `any_report` renders `AnyReportOutput` — and import it with no `Any` in sight.
  try {
    const object = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const named = renderToolsSection([{ name: 'any_report', parameters: { properties: {} }, output: object }])
    assert.ok(!/from typing import[^\n]*Any/.test(named), 'a class named after the symbol is not a use of it')
    assert.match(named, /from typing import TypedDict\n/, 'the symbols it does use are still there')
    const degraded = renderToolsSection([{ name: 'odd', parameters: { properties: {} }, output: { type: 'object', properties: { 'not-a-name': { type: 'string' } }, required: ['not-a-name'] } }])
    assert.match(degraded, /from typing import Any\n/, 'and a real `dict[str, Any]` still imports it')
    console.log('  ok   the typing import names what the render used')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a tool name Python cannot take costs its class, not the block\n       ${error.message}`)
  }
  // Vague beats absent: a tool whose parameters cannot be named must stay importable and callable, since the kernel folds them into `**kwargs`.
  try {
    const rendered = renderToolsSection([{ name: 'odd', parameters: { properties: { 'file-path': { type: 'string' } }, required: ['file-path'] } }])
    assert.match(rendered, /import ToolCallError, odd/, 'it is still importable — only its signature is imprecise')
    assert.match(rendered, /async def odd\(\*\*kwargs: Any\)/, 'the signature falls back rather than emitting an unparsable one')
    console.log('  ok   an unnameable parameter costs the signature, not the tool')
  } catch (error) {
    failures += 1
    console.log(`  FAIL an unnameable parameter costs the signature, not the tool\n       ${error.message}`)
  }
}

// `mcp.<server>.<tool>` is a PRESENTATION of the same flat bindings — the host still dispatches on
// `mcp__server__tool`, so the grouping must not change what reaches it, and the flat name has to
// keep working for a cell written before the catalogue was re-rendered.
console.log('mcp namespace:')
{
  const seen = []
  const ns = new PythonKernel({ cwd: process.cwd(), onCall: async (name, args) => { seen.push(name); return { ok: true, value: { from: name, args } } } })
  const MCP = [
    { name: 'mcp__calendar__list_events', doc: 'List events.', params: [{ name: 'calendar_id', type: 'str', required: true }] },
    { name: 'mcp__calendar__create_event', doc: 'Create one.', params: [{ name: 'title', type: 'str', required: true }] },
    { name: 'mcp__notion__API-patch-block-children', doc: 'Hyphens are real.', params: [{ name: 'block_id', type: 'str', required: true }] },
    { name: 'read', doc: 'A native tool.', params: [{ name: 'file_path', type: 'str', required: true }] },
  ]
  await ns.start(MCP)
  const cell = (code, specs = MCP) => ns.exec(code, undefined, specs)
  const t = async (label, code, assertion, specs) => {
    try { assertion(await cell(code, specs)); console.log(`  ok   ${label}`) }
    catch (error) { failures += 1; console.log(`  FAIL ${label}\n       ${error.message}`) }
  }
  await t('one import reaches every server', 'from __dsh__.tools import mcp\nawait mcp.calendar.list_events(calendar_id="c")', (r) => {
    assert.equal(r.ok, true, r.error)
    assert.equal(seen.at(-1), 'mcp__calendar__list_events', 'the host still sees the flat name it dispatches on')
  })
  await t('a name Python refuses is reachable under its server', 'from __dsh__.tools import mcp\nawait getattr(mcp.notion, "API-patch-block-children")(block_id="b")', (r) => {
    assert.equal(r.ok, true, r.error)
    assert.equal(seen.at(-1), 'mcp__notion__API-patch-block-children')
  })
  await t('the flat name still works', 'from __dsh__.tools import mcp__calendar__create_event as f\nawait f(title="x")', (r) => {
    assert.equal(r.ok, true, r.error)
    assert.equal(seen.at(-1), 'mcp__calendar__create_event')
  })
  await t('dir() walks the grouping', 'from __dsh__.tools import mcp\n(sorted(dir(mcp)), sorted(dir(mcp.calendar)))', (r) => {
    assert.equal(r.repr, "(['calendar', 'notion'], ['create_event', 'list_events'])")
  })
  await t('a missing tool names what is there', 'from __dsh__.tools import mcp\nmcp.calendar.nope', (r) => {
    assert.equal(r.ok, false)
    assert.match(r.error, /no such tool: mcp\.calendar\.nope/)
    assert.match(r.error, /create_event, list_events/, 'and lists the ones that are')
  })
  await t('a native tool is not swept under it', 'from __dsh__.tools import mcp\nhasattr(mcp, "read")', (r) => {
    assert.equal(r.repr, 'False')
  })
  // Every other binding is re-imported the moment the model wants a different tool. `mcp` is the
  // one it has no reason to import twice — it reads as a namespace, not as this cell's tool list —
  // so a reference kept from an earlier cell has to resolve against the catalogue in force NOW.
  const MOVED = [{ name: 'mcp__drive__list_files', doc: 'A server that arrived later.', params: [] }, MCP[2]]
  await t('a kept reference survives the catalogue moving under it', 'from __dsh__.tools import mcp\nkept = mcp\nsorted(dir(kept))', (r) => {
    assert.equal(r.repr, "['calendar', 'notion']")
  })
  await t('and follows it rather than freezing the cell it came from', '(sorted(dir(kept)), (await kept.drive.list_files())["from"])', (r) => {
    assert.equal(r.repr, `(['drive', 'notion'], 'mcp__drive__list_files')`, 'a snapshot would still hold calendar and know nothing of drive')
  }, MOVED)
  // `mcp` is a package, not just an object: every import form has to resolve, and the deep one is
  // the reason `sys.modules` carries a module per server — `__getattr__` alone cannot serve it.
  await t('the deep import form binds a tool directly', 'from __dsh__.tools.mcp.calendar import list_events\n(await list_events(calendar_id="c"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__calendar__list_events'", r.error)
  })
  await t('the server module can be imported from the grouping', 'from __dsh__.tools.mcp import calendar\n(await calendar.create_event(title="x"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__calendar__create_event'", r.error)
  })
  await t('and as a dotted module', 'import __dsh__.tools.mcp.notion as N\nsorted(dir(N))', (r) => {
    assert.equal(r.repr, "['API-patch-block-children']", r.error)
  })
  // NOT `drive`: the catalogue above mounted one, and `sys.modules` only ever gains entries — a
  // name any earlier cell saw would make this assertion pass for the wrong reason.
  await t('a server nobody mounted fails as a missing module, not as a tool', 'import __dsh__.tools.mcp.dropbox', (r) => {
    assert.equal(r.ok, false)
    assert.match(r.error, /ModuleNotFoundError.*__dsh__\.tools\.mcp\.dropbox/)
  })
  // Same liveness rule as the `mcp` object: `sys.modules` is process-global, the catalogue is not.
  await t('a kept server module follows the catalogue', 'kept_cal = calendar\n(sorted(dir(kept_cal)), hasattr(kept_cal, "create_event"))', (r) => {
    // Both halves: an empty `dir()` only proves the LISTING moved. Reaching for a tool the old
    // catalogue had is the thing that must also stop working.
    assert.equal(r.repr, "([], False)", 'calendar is gone from this catalogue, and the module neither lists nor serves its tools')
  }, MOVED)
  // The raw name is the server's to choose, and a leading underscore is legal in it. The block
  // renders `mcp.cal._private()` for one — which the namespace has to be able to answer.
  const UNDERSCORED = [{ name: 'mcp__cal___private', doc: 'A leading underscore is legal.', params: [] }]
  await t('a tool whose raw name starts with an underscore is still reachable', 'from __dsh__.tools import mcp\n(await mcp.cal._private())["from"]', (r) => {
    assert.equal(r.repr, "'mcp__cal___private'", r.error)
  }, UNDERSCORED)
  // `sys.modules` is process-global and only ever gains entries, so a server ANOTHER shell mounted
  // stays importable here. Pinned rather than left to chance: what leaks is the module's existence,
  // not a tool — it resolves empty, and the grouping still lists only this shell's servers.
  await ns.start([{ name: 'mcp__vault__unlock', doc: 'Only this shell has it.', params: [] }], 'other')
  await ns.exec('from __dsh__.tools.mcp.vault import unlock', undefined, [{ name: 'mcp__vault__unlock', doc: 'x', params: [] }], 'other')
  await t('a server only another shell mounted imports here, but is empty', 'import __dsh__.tools.mcp.vault as v\n(dir(v), hasattr(v, "unlock"), "vault" in dir(mcp))', (r) => {
    assert.equal(r.repr, "([], False, False)", r.error)
  })
  ns.dispose()
}

// One process per conversation tree, one shell per agent. This is what makes a fan-out of subagents cheap — and what keeps their globals apart.
console.log('shells:')
{
  const shells = new PythonKernel({ cwd: process.cwd(), onCall: async (name) => ({ ok: true, value: { from: name } }) })
  const parentTools = [{ name: 'read', doc: 'r', params: [{ name: 'x', type: 'str', required: true }] }]
  const childTools = [{ name: 'write', doc: 'w', params: [{ name: 'x', type: 'str', required: true }] }]
  await shells.start(parentTools, 'parent')
  await shells.start(childTools, 'child')
  const cell = (code, shell) => shells.exec(code, undefined, undefined, shell)
  const checkShell = async (label, verify) => {
    try { await verify(); console.log(`  ok   ${label}`) }
    catch (error) { failures += 1; console.log(`  FAIL ${label}\n       ${error.message}`) }
  }

  await checkShell('a second shell reuses the interpreter instead of spawning one', async () => {
    const [a, b] = [await cell('import os; os.getpid()', 'parent'), await cell('import os; os.getpid()', 'child')]
    assert.equal(a.repr, b.repr)
    assert.equal(Number(a.repr), shells.proc.pid)
  })

  await checkShell('globals are not shared between shells', async () => {
    await cell('secret = "parent-only"', 'parent')
    assert.equal((await cell('"secret" in dir()', 'child')).repr, 'False')
  })

  await checkShell('each shell sees only its own tool catalogue', async () => {
    assert.equal((await cell('import __dsh__.tools as T; sorted(dir(T))', 'parent')).repr, `['read']`)
    assert.equal((await cell('import __dsh__.tools as T; sorted(dir(T))', 'child')).repr, `['write']`)
  })

  await checkShell('`__dsh__.shared` is the deliberate exception', async () => {
    await cell('import __dsh__.shared as S; S.payload = {"n": 42}', 'parent')
    assert.equal((await cell('import __dsh__.shared as S; S.payload', 'child')).repr, `{'n': 42}`)
  })

  // sys.stdout and sys.displayhook are process-global; without per-task routing one cell's output lands in the other's buffer and the RESULTS come back swapped.
  await checkShell('concurrent cells in different shells do not cross', async () => {
    const [a, b] = await Promise.all([
      cell('import asyncio\nfor i in range(3):\n    print(f"P{i}"); await asyncio.sleep(0.05)\n"P-done"', 'parent'),
      cell('import asyncio\nprint("C0"); await asyncio.sleep(0.01)\n"C-done"', 'child'),
    ])
    assert.equal(a.stdout.trim(), 'P0\nP1\nP2')
    assert.equal(b.stdout.trim(), 'C0')
    assert.equal(a.repr, `'P-done'`)   // not the other shell's value
    assert.equal(b.repr, `'C-done'`)
  })

  // The case above interleaves, but its trailing expressions happen to land outside each other's window. This one is built so the parent's lands INSIDE the child's: IPython's `display_trap` swaps `sys.displayhook` for the running shell's own hook, so without neutralising it the parent's value is filled into the CHILD's ExecutionResult, overwritten there by the child's own, and the parent reports no return value at all.
  await checkShell('a trailing expression evaluated inside another shell\'s window still lands home', async () => {
    const parent = cell('import asyncio\nawait asyncio.sleep(0.1)\n"P-inner"', 'parent')
    await new Promise((resume) => setTimeout(resume, 50).unref())   // the child starts while the parent is suspended...
    const child = cell('import asyncio\nawait asyncio.sleep(0.4)\n"C-outer"', 'child')  // ...and outlives it, so the parent finishes inside the child's window
    const [a, b] = await Promise.all([parent, child])
    assert.equal(a.repr, `'P-inner'`, 'the parent must not lose its value to the shell that happened to be running')
    assert.equal(b.repr, `'C-outer'`)
  })

  // A tool can keep its name and change everything else — an MCP server reconnecting with a revised schema is the ordinary case. Keying the rebind-skip on names alone left the kernel serving the old signature while the prompt showed the new one.
  await checkShell('a same-named tool with a changed schema is rebound', async () => {
    const v2 = [{ name: 'read', doc: 'REVISED', params: [{ name: 'file-path', type: 'str', required: true }, { name: 'limit', type: 'int', required: false }] }]
    await shells.exec('1', undefined, v2, 'parent')
    assert.equal((await cell('import __dsh__.tools as T; T.read.__doc__', 'parent')).repr, `'REVISED'`)
    assert.equal((await cell('import inspect; sorted(inspect.signature(T.read).parameters)', 'parent')).repr, `['kwargs', 'limit']`)
  })

  // The host skips a rebind it believes already landed, and a busy kernel answers with an ordinary `ok: false` frame — so `exec` RESOLVES and the outcome has to be read. This pins the exact wording that decision keys on: change it here and the host silently starts trusting a rebind that never happened.
  await checkShell('a busy shell is refused with the wording the host keys on', async () => {
    const running = cell('import asyncio\nawait asyncio.sleep(0.5)', 'parent')
    await new Promise((resume) => setTimeout(resume, 80).unref())
    const refused = await cell('1', 'parent')
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'kernel busy: a previous cell is still running')
    await running
  })

  await checkShell('closing one shell leaves the others running', async () => {
    shells.closeShell('child')
    assert.equal((await cell('secret', 'parent')).repr, `'parent-only'`)
  })
  shells.dispose()
}

// A harness restart wipes the in-memory kernel map but NOT the session log, so the durable history is the only signal that survives the event it has to detect.
console.log('restart detection:')
{
  const cell = () => ({ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'python', arguments: '{}' }] })
  const other = () => ({ role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'bash', arguments: '{}' }] })
  const notice = () => ({ role: 'user', content: [{ type: 'text', text: '…' }], source: { kind: 'plugin', plugin: 'dsh-py-codeact', form: 'notice', summary: 'x' } })
  const said = () => ({ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  const session = (...messages) => ({ deriveMessages: () => messages })
  const cases = [
    ['a session that ran cells is told', session(said(), cell()), true],
    ['one that only used other tools is not', session(said(), other()), false],
    ['a brand-new session is not', session(), false],
    ['a missing session does not throw', undefined, false],
    // The notice is committed to the log, so reopening N times must not append N copies.
    ['reopening again after a notice stays quiet', session(cell(), notice()), false],
    ['…but a cell run after the notice earns a new one', session(cell(), notice(), cell()), true],
    ['another plugin\'s notice does not count as ours', session(cell(), { ...notice(), source: { kind: 'plugin', plugin: 'other' } }), true],
  ]
  for (const [label, s, expected] of cases) {
    try {
      assert.equal(needsRestartNotice(s, 'python', 'dsh-py-codeact'), expected)
      console.log(`  ok   ${label}`)
    } catch (error) {
      failures += 1
      console.log(`  FAIL ${label}\n       ${error.message}`)
    }
  }
}

kernel.dispose()
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
