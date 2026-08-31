/**
 * Standalone smoke test for the kernel + wire protocol — no dsh required. Run: node test/smoke.js
 */

import assert from 'node:assert/strict'
import { PythonKernel } from '../lib/kernel.js'
import { renderToolsSection, needsRestartNotice, specsKey, mcpPayload, toolSpecs } from '../lib/index.js'
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
  assert.ok(!sameNames([{ ...base[0], params: [{ ...base[0].params[0], doc: 'what p means' }] }]), 'a parameter that gains a description must force one — it is prose only `read?` carries')
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
    // A hyphen is the ONE unspellable shape with a spelling: the kernel binds the fold alongside the
    // raw name, so the block shows a callable signature instead of pointing at `getattr`.
    const rendered = renderToolsSection([{ name: 'mcp__srv__do-thing', parameters: {} }])
    assert.match(rendered, /# mcp\.srv\.do_thing\(\) -> Any/, 'a hyphenated tool is shown under a spelling Python takes')
    assert.ok(!rendered.includes('getattr'), 'and needs no getattr route at all')
    assert.ok(!rendered.includes('mcp__srv__do-thing'), 'and is not also offered under the flat name the block no longer shows')
    // ...unless another server already owns the folded spelling, in which case neither is renamed.
    const collided = renderToolsSection([{ name: 'mcp__a-b__from_hyphen', parameters: {} }, { name: 'mcp__a_b__from_underscore', parameters: {} }])
    assert.equal(collided.split('# __dsh__.tools.mcp.a_b').length - 1, 1, 'the fold does not emit two sections under one name')
    assert.match(collided, /getattr\(getattr\(mcp, "a-b"\), "from_hyphen"\)/, 'and the server it could not rename keeps the two-level getattr route')
    // A server whose own name carries one folds the same way, at both levels.
    const oddOnly = renderToolsSection([{ name: 'mcp__odd-srv__thing', parameters: {} }])
    assert.match(oddOnly, /# __dsh__\.tools\.mcp\.odd_srv\n# mcp\.odd_srv\.thing\(\) -> Any/, 'so does a server whose own name has one')
    assert.match(oddOnly, /import ToolCallError, mcp\n/, 'and `mcp` is imported even when every server name had to be folded')
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
    assert.match(rendered, /async def read\(\n {4}\*,\n {4}file_path: str,\n\) -> str:\n {4}\.\.\./, "a tool's declared output type must reach the signature")
    assert.match(rendered, /async def glob\(\n {4}\*,\n {4}pattern: str,\n\) -> list\[str\]:/, 'including container types')
    // `schemas()` has no `output`; only `sdkSchemas()` carries it. Rendering `Any` there is right — asserting a wrong type would be worse than admitting ignorance.
    assert.match(renderToolsSection([{ name: 'read', parameters: {} }]), /async def read\(\) -> Any:\n {4}\.\.\./, 'a schema with no output falls back to Any')
    // The Protocol stubs are rendered Python too, and reach `Any` by the same routes a top-level
    // signature does — the import used to be derived from the signatures alone.
    const stubAny = renderToolsSection([{ name: 'mcp__cal__list', parameters: {} }])
    assert.match(stubAny, /# __dsh__\.tools\.mcp\.cal\n# mcp\.cal\.list\(\) -> Any/, 'including under a server module')
    assert.match(stubAny, /from typing import Any\n/, 'which has to import `Any` like any other use of it')
    console.log('  ok   renders each tool\'s real return type')
  } catch (error) {
    failures += 1
    console.log(`  FAIL renders each tool's real return type\n       ${error.message}`)
  }
  // `self` is a legal identifier, so every "is this nameable" guard passes it — and then
  // `async def list(self, *, self: str)` is a SyntaxError that takes the whole fenced block with it,
  // every sibling stub and every native signature below included. The guard has to be positional.
  try {
    const rendered = renderToolsSection([
      { name: 'mcp__srv__list', parameters: { properties: { self: { type: 'string' } }, required: ['self'] } },
      { name: 'mcp__srv__other', parameters: { properties: { q: { type: 'string' } }, required: ['q'] } },
      { name: 'read', parameters: { properties: { self: { type: 'string' } }, required: ['self'] } },
    ])
    // Nothing spends the name any more: every tool is a module-level function, so `self` is an
    // ordinary keyword parameter everywhere and the collision this once guarded cannot occur.
    assert.match(rendered, /# mcp\.srv\.list\(\n# {5}\*,\n# {5}self: str,\n# \) -> Any/, 'a `self` parameter renders as itself')
    assert.match(rendered, /# mcp\.srv\.other\(\n# {5}\*,\n# {5}q: str,\n# \) -> Any/, 'and its siblings are unaffected')
    assert.match(rendered, /async def read\(\n {4}\*,\n {4}self: str,\n\) -> Any:/, 'at the top level too')
    console.log('  ok   a parameter named `self` is just a parameter now')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a parameter named \`self\` is just a parameter now\n       ${error.message}`)
  }
  // The kernel refuses to bind four families of name; this side used to mirror one. The block then
  // wrote an import line for names nothing binds — an `ImportError` on `_private`, and a duplicate
  // `ToolCallError` resolving to the exception class the instructions tell the model to catch.
  try {
    const rendered = renderToolsSection([{ name: 'ToolCallError', parameters: {} }, { name: '_private', parameters: {} }, { name: 'mcp', parameters: {} }, { name: 'read', parameters: {} }])
    assert.match(rendered, /from __dsh__\.tools import ToolCallError, read\n/, 'only what the kernel actually binds reaches the import line')
    assert.ok(!/async def (ToolCallError|_private|mcp)\(/.test(rendered), 'and no signature is offered for a name that is never bound')
    console.log('  ok   the block advertises exactly what the kernel binds')
  } catch (error) {
    failures += 1
    console.log(`  FAIL the block advertises exactly what the kernel binds\n       ${error.message}`)
  }
  // An object output is the case the annotation exists FOR, and the one a context-free render cannot
  // carry: `dict[str, Any]` says a dict comes back and nothing else, so the model calls once and
  // prints the result to learn the keys. On a stock catalogue that was every tool but one.
  try {
    const output = { oneOf: [
      { type: 'object', properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' } }, required: ['kind', 'jobId'] },
      { type: 'object', properties: { kind: { type: 'string', const: 'foreground' }, exitCode: { type: 'integer' }, stdout: { type: 'object', properties: { text: { type: 'string' }, truncated: { type: 'boolean' } }, required: ['text', 'truncated'] } }, required: ['kind', 'exitCode', 'stdout'] },
    ] }
    const rendered = renderToolsSection([{ name: 'bash', parameters: { properties: { command: { type: 'string' } }, required: ['command'] }, output }])
    assert.match(rendered, /async def bash\(\n {4}\*,\n {4}command: str,\n\) -> BashOutput1 \| BashOutput2:/, 'a choice of shapes is a union of NAMED branches, not two identical dicts')
    assert.match(rendered, /class BashOutput1\(TypedDict\):\n {4}kind: Literal\["background"\]\n {4}jobId: str/, 'each branch declares its own fields')
    // The discriminator is the whole point of the union: without the literal the model cannot tell
    // which branch it is holding, and a named union is no better than a dict.
    assert.match(rendered, /kind: Literal\["foreground"\]/, 'including the literal that tells them apart')
    assert.match(rendered, /class BashOutput2Stdout\(TypedDict\):\n {4}text: str/, 'a nested object gets a class too')
    assert.match(rendered, /class BashOutput2\(TypedDict\):[\s\S]*\n {4}stdout: BashOutput2Stdout/, 'and the parent references it by name')
    console.log('  ok   an object output is a named class, not an opaque dict')
  } catch (error) {
    failures += 1
    console.log(`  FAIL an object output is a named class, not an opaque dict\n       ${error.message}`)
  }
  // A `Literal` reaches the block by a route no per-symbol condition predicted — an `enum` PARAMETER,
  // with no output class in sight — and shipped with no import, making the block a `NameError` for
  // anything that copied it. The import is derived from the lines instead of enumerated alongside them.
  try {
    const rendered = renderToolsSection([{ name: 'edit', parameters: { properties: { mode: { type: 'string', enum: ['a', 'b'] } }, required: ['mode'] } }])
    assert.match(rendered, /async def edit\(\n {4}\*,\n {4}mode: Literal\["a", "b"\],\n\) -> Any:/, 'an enum parameter renders a literal')
    assert.match(rendered, /from typing import Any, Literal\n/, 'which the import line has to name')
    console.log('  ok   the import line follows the render, not a list of expected symbols')
  } catch (error) {
    failures += 1
    console.log(`  FAIL the import line follows the render, not a list of expected symbols\n       ${error.message}`)
  }
  // dsh validates a schema whole-tree and rejects totally, so ONE keyword outside its subset costs the
  // whole annotation — and `minLength`/`format`/`minimum`/`anyOf` are exactly what Pydantic and FastMCP
  // emit. On the live catalogue that was five parameters, including a REQUIRED search query, arriving as
  // `Any`: worse than no annotation, because it looks like one. The keywords carry nothing a Python
  // annotation could say, so dropping them loses nothing; `anyOf` is the one that does, and is a union.
  try {
    const constrained = renderToolsSection([{ name: 'search', parameters: { properties: {
      query: { type: 'string', minLength: 1 },
      budget: { type: 'number', minimum: 1, maximum: 9, format: 'double' },
      session: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      window: { anyOf: [{ maximum: 100, type: 'number' }, { type: 'null' }] },
    }, required: ['query'] } }])
    // Per parameter rather than as one signature line: what is asserted is the TYPE each keyword used to eat, and binding that to the layout makes this fail for a render change it does not care about.
    for (const spelling of ['query: str', 'budget: float', 'session: str | None', 'window: float | None']) {
      assert.ok(constrained.includes(spelling), `a validation keyword no longer eats the type in \`${spelling}\``)
    }
    // The positive spellings are prefixes, so this is what actually rules out a degraded render.
    assert.doesNotMatch(constrained, /: Any\b/, 'and nothing in the signature fell back')
    console.log('  ok   a constraint keyword costs a parameter nothing, and `anyOf` is a union')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a constraint keyword costs a parameter nothing, and \`anyOf\` is a union\n       ${error.message}`)
  }
  // Rejection is whole-TREE, so an unrecognised keyword on a leaf takes the root down with it, and a
  // root `$schema` — which most generated schemas carry — takes down everything below. Both halves go
  // through the same gate: an output degraded this way loses its named class, not just one field.
  try {
    const nested = renderToolsSection([{ name: 'fetch', output: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
      pages: { type: 'array', items: { type: 'object', properties: { url: { type: 'string', format: 'uri' } }, required: ['url'] } },
    }, required: ['pages'] } }])
    assert.match(nested, /class FetchOutput\(TypedDict\):\n {4}pages: list\[FetchOutputPages\]/, 'a deep constraint no longer collapses the root')
    assert.match(nested, /async def fetch\(\) -> FetchOutput:/, 'so the return is the class, not `Any`')
    console.log('  ok   one leaf keyword no longer collapses the whole tree, on either half')
  } catch (error) {
    failures += 1
    console.log(`  FAIL one leaf keyword no longer collapses the whole tree, on either half\n       ${error.message}`)
  }
  // The narrowing may only ever REMOVE a reason to reject. Anything it changed about a schema dsh
  // already accepts would be this plugin quietly growing the second JSON-Schema mapper it has twice
  // declined to grow — so the shapes that render today must render identically.
  try {
    const accepted = { name: 'keep', parameters: { properties: {
      mode: { type: 'string', enum: ['a', 'b'], description: 'd', title: 't', default: 'a' },
      pick: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      rows: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false } },
      tag: { type: 'string', const: 'x' },
    }, required: ['mode'] } }
    assert.deepEqual(toolSpecs([accepted]).specs[0].params, toolSpecs([structuredClone(accepted)]).specs[0].params, 'stable')
    const kept = renderToolsSection([accepted])
    for (const spelling of ['mode: Literal["a", "b"]', 'pick: int | None = ...', 'rows: list[dict[str, Any]] = ...', 'tag: Literal["x"] = ...']) {
      assert.ok(kept.includes(spelling), `an accepted schema still renders ${spelling}`)
    }
    console.log('  ok   narrowing only removes a reason to reject, never rewrites an accepted schema')
  } catch (error) {
    failures += 1
    console.log(`  FAIL narrowing only removes a reason to reject, never rewrites an accepted schema\n       ${error.message}`)
  }
  // Two shapes a name-only rule gets wrong, both raised in review. `additionalProperties` IS in the
  // subset, but dsh takes it only as a boolean — so the schema-valued form Pydantic emits for
  // `dict[str, str]` is rejected however clean its child is, and narrowing that child repairs nothing
  // while dropping it renders. And where a `oneOf` is already declared, substituting `anyOf`'s branches
  // for it would be deciding a type rather than removing a reason to reject, so the rewrite stands down.
  try {
    const shapes = renderToolsSection([{ name: 'store', parameters: { properties: {
      bag: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
      pick: { anyOf: [{ type: 'string' }, { type: 'null' }], oneOf: [{ type: 'string' }, { type: 'number' }] },
    }, required: ['bag'] } }])
    assert.ok(shapes.includes('bag: dict[str, Any]'), 'a schema-valued additionalProperties is dropped, not narrowed')
    assert.ok(shapes.includes('pick: str | float'), 'and the declared oneOf wins over anyOf')
    console.log('  ok   a schema-valued `additionalProperties` is dropped, and a declared `oneOf` wins')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a schema-valued \`additionalProperties\` is dropped, and a declared \`oneOf\` wins\n       ${error.message}`)
  }
  // The mirror of #16 on the other half. `jsonSchemaToPy` is context-free — it has nowhere to hang a
  // declaration — so left to itself it degrades every parameter OBJECT to `dict[str, Any]`: the
  // annotation says a dict arrives and nothing about which keys, which is the whole reason to have one.
  // The names come from dsh's own render, read back the same way the return types are. `$schema` is in
  // the fixture because a real MCP catalogue carries one, and it makes dsh collapse the WHOLE args type
  // to `Any` — one key, taking every sibling parameter's annotation down with it.
  try {
    const named = renderToolsSection([{ name: 'store', parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {
      window: { type: 'object', properties: { offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['offset'] },
      rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    }, required: [] } }])
    assert.ok(named.includes('window: StoreArgsWindow'), `a parameter object is a named TypedDict, got: ${/window: .*/.exec(named)?.[0]}`)
    assert.ok(named.includes('rows: list[StoreArgsRows]'), `and so is the item type of an array of them, got: ${/rows: .*/.exec(named)?.[0]}`)
    assert.match(named, /^class StoreArgsWindow\(TypedDict\):$/m, 'the class it names is declared')
    // `<Tool>Args` is dsh's calling convention, not this block's: parameters are spelled out here, so
    // emitting the wrapper they were read out of would declare a class nothing references.
    assert.doesNotMatch(named, /^class StoreArgs\(TypedDict\):$/m, 'but the wrapper it was read out of is not')
    console.log('  ok   a parameter object is named, and the wrapper it came from is dropped')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a parameter object is named, and the wrapper it came from is dropped\n       ${error.message}`)
  }
  // Only `mcp` is bound at the top level, so a server's tools are shown the way the call site spells
  // them — as comments. Rendered as bare `async def`s they claimed a top-level name they do not have
  // AND took it: a native `read` plus two servers exposing a raw `read` left the last stub shadowing
  // the imported function, so running the block broke the tool its first section had just declared.
  try {
    const rendered = renderToolsSection([
      { name: 'read', parameters: { properties: { file_path: { type: 'string' } }, required: ['file_path'] }, output: { type: 'string' } },
      { name: 'mcp__alpha__read', parameters: { properties: { a: { type: 'string' } }, required: ['a'] }, output: { type: 'string' } },
      { name: 'mcp__beta__read', parameters: { properties: { b: { type: 'integer' } }, required: ['b'] }, output: { type: 'string' } },
    ])
    assert.match(rendered, /^async def read\(\n {4}\*,\n {4}file_path: str,\n\) -> str:$/m, 'the one name that IS bound is the only definition')
    assert.match(rendered, /^# mcp\.alpha\.read\(\n# {5}\*,\n# {5}a: str,\n# \) -> str:$/m, 'a server tool is spelled the way it is called')
    assert.match(rendered, /^# mcp\.beta\.read\(\n# {5}\*,\n# {5}b: int,\n# \) -> str:$/m, 'and a second server sharing the raw name keeps its own')
    assert.equal(rendered.split('\n').filter((l) => /^async def read\(/.test(l)).length, 1, 'exactly one definition binds that name')
    console.log('  ok   a raw MCP name never shadows the tool it collides with')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a raw MCP name never shadows the tool it collides with\n       ${error.message}`)
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
    assert.match(rendered, /# __dsh__\.tools\.mcp\.review\n# mcp\.review\.search\(\n# {5}\*,\n# {5}q: str,\n# \) -> McpReviewSearchOutput/, 'a declared payload names its own type')
    assert.match(rendered, /class McpReviewSearchOutput\(TypedDict\):\n {4}merchants: list\[str\]\n {4}total: NotRequired\[int\]/, 'and that type is the payload, not the wrapper')
    assert.ok(!rendered.includes('structuredContent'), 'the wrapper is never named — the cell does not receive it')
    // No declared payload means the client has only the text blocks to hand over, so `str` is the
    // whole truth. Not every server declares an output schema; this is the common case in the wild.
    assert.match(rendered, /# mcp\.email\.ping\(\) -> str/, 'an envelope with no payload resolves to its text')
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
    assert.deepEqual(mcpPayload({ content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }), { value: 'one\n\ntwo' }, 'no payload means the text blocks, joined')
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
  // is a SyntaxError that takes the whole block with it, including every tool that was fine.
  // Such a tool gets no `async def` line — only a `getattr` mention — but it is still bound, and
  // `123tool?` shows the same `returns` text this block declares, so the class is not orphaned.
  try {
    const output = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
    const rendered = renderToolsSection([{ name: '123tool', parameters: { properties: {} }, output }, { name: 'ok', parameters: { properties: {} }, output }])
    // The name itself SHOULD still appear — in the `getattr` line, which is how such a tool is reached.
    assert.ok(!/class 123tool/.test(rendered), 'no class is declared under a name Python cannot take')
    assert.match(rendered, /class Tool123toolOutput\(TypedDict\):/, 'it is carried under one Python can, rather than dropped')
    assert.match(rendered, /getattr\(__dsh__\.tools, "123tool"\)/, 'the tool is still reachable, only its annotation goes vague')
    assert.match(rendered, /class OkOutput\(TypedDict\):\n {4}a: str/, 'the tools that were fine still get theirs')
    assert.match(rendered, /async def ok\(\) -> OkOutput:/, 'and still reference it')
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
  // A hyphen is routine one level up, so it is routine here — and it used to cost the tool its WHOLE signature. Now it is renamed the way the tool name above it is, and only a name no normalisation reaches goes to `**kwargs`, with the raw key named rather than left to be guessed.
  try {
    const rendered = renderToolsSection([{ name: 'odd', parameters: { properties: { 'file-path': { type: 'string' }, from: { type: 'string' }, type: { type: 'string' }, 'a b': { type: 'string' } }, required: ['file-path'] } }])
    assert.match(rendered, /import ToolCallError, odd/, 'it is still importable')
    assert.match(rendered, /\n {4}file_path: str,\n/, 'a hyphen folds, as it does in a tool name')
    assert.match(rendered, /\n {4}from_: str = \.\.\.,\n/, 'a hard keyword takes the trailing underscore Python programmers already write')
    assert.match(rendered, /\n {4}type: str = \.\.\.,\n/, 'a SOFT keyword needs nothing — `def f(*, type: str)` compiles')
    assert.match(rendered, /\n {4}\*\*kwargs: Any {2}# spell as dict keys: "a b"\n/, 'and only what is left over goes to `**kwargs`, named')
    // Only reachable once the overflow SHARES a signature with named parameters, which is new here: the old
    // fallback replaced them all, so nothing could collide with it. A duplicate argument is a `SyntaxError`
    // that takes the whole fenced block down, for every tool in it.
    const own = renderToolsSection([{ name: 'edit', parameters: { properties: { kwargs: { type: 'string' }, _kwargs: { type: 'string' }, 'a b': { type: 'string' } }, required: [] } }])
    assert.match(own, /\n {4}kwargs: str = \.\.\.,\n {4}_kwargs: str = \.\.\.,\n {4}\*\*__kwargs: Any {2}# spell as dict keys: "a b"\n/, 'a tool that owns the overflow name makes it step aside')
    console.log('  ok   a parameter name is normalised, and only the rest costs the signature')
  } catch (error) {
    failures += 1
    console.log(`  FAIL a parameter name is normalised, and only the rest costs the signature\n       ${error.message}`)
  }
}

// Renaming a parameter is not like renaming a tool: the name travels to the tool as a JSON key, so
// every rename needs a way back. Get this wrong and every call silently sends a key the tool does not
// know — the failure would look like the tool being broken, not the binding.
console.log('a renamed parameter still dispatches under its raw key:')
{
  const sent = []
  const wire = new PythonKernel({ cwd: process.cwd(), onCall: async (name, args) => { sent.push(args); return { ok: true, value: null } } })
  const specs = toolSpecs([{ name: 'odd', parameters: { properties: {
    'file-path': { type: 'string' }, from: { type: 'string' }, 'a b': { type: 'string' },
  }, required: ['file-path'] } }]).specs
  await wire.start(specs)
  const checkWire = async (label, verify) => {
    try { await verify(); console.log(`  ok   ${label}`) }
    catch (error) { failures += 1; console.log(`  FAIL ${label}\n       ${error.message}`) }
  }

  await checkWire('the spelling the block shows maps back to the key the tool declared', async () => {
    sent.length = 0
    const ran = await wire.exec('from __dsh__.tools import odd\nawait odd(file_path="p", from_="f")', undefined, undefined)
    assert.equal(ran.ok, true, ran.error)
    assert.deepEqual(sent[0], { 'file-path': 'p', from: 'f' })
  })
  // A cell written before the rename, or one that read the raw name off the block's `**kwargs` line.
  await checkWire('and a raw key passed straight through is left alone', async () => {
    sent.length = 0
    const ran = await wire.exec('await odd(**{"file-path": "p", "a b": 1})', undefined, undefined)
    assert.equal(ran.ok, true, ran.error)
    assert.deepEqual(sent[0], { 'file-path': 'p', 'a b': 1 })
  })
  wire.dispose()

  // The lesson from folding MCP names one level up: an alias must never take a name something real answers to.
  await checkWire('a fold never displaces the sibling that already owns the name', async () => {
    const both = toolSpecs([{ name: 'clash', parameters: { properties: { 'file-path': { type: 'string' }, file_path: { type: 'integer' } }, required: [] } }]).specs[0]
    assert.deepEqual(both.params.map((p) => [p.name, p.raw]), [['file-path', undefined], ['file_path', undefined]], 'neither is renamed, so neither can steal the other')
    const rendered = renderToolsSection([{ name: 'clash', parameters: { properties: { 'file-path': { type: 'string' }, file_path: { type: 'integer' } }, required: [] } }])
    assert.match(rendered, /\n {4}file_path: int = \.\.\.,\n {4}\*\*kwargs: Any {2}# spell as dict keys: "file-path"\n/, 'the real one keeps its name; the hyphenated one stays a dict key')
  })
}

// `mcp.<server>.<tool>` is a PRESENTATION of the same flat bindings — the host still dispatches on
// `mcp__server__tool`, so the grouping must not change what reaches it, and the flat name has to
// keep working for a cell written before the catalogue was re-rendered.
// A parameter's TYPE is not what it means: `queries` is `list[str]` either way, and only the prose
// says 1–4 of them. The block deliberately does not carry it — ~6.8 KB across a real catalogue, re-sent
// every turn for the one parameter a cell touches — so `name?` is the only place it can be, and the
// block says so. Both halves are asserted here: that it arrives, and that it stays off the prompt.
console.log('a parameter carries its prose to `name?`, not to the prompt:')
{
  const documented = [
    { name: 'read', doc: 'Read a file.', returns: 'Any', params: [
      { name: 'file_path', type: 'str', required: true, doc: 'Path to read, resolved by the filesystem backend.' },
      { name: 'offset', type: 'int', required: false, doc: 'Line to start at.\nOne-based.' }] },
    { name: 'bare', doc: 'No parameter prose anywhere.', returns: 'Any', params: [{ name: 'x', type: 'str', required: true }] },
  ]
  const docs = new PythonKernel({ cwd: process.cwd(), onCall: async () => ({ ok: true, value: null }) })
  await docs.start(documented)
  const doc = async (name) => (await docs.exec(`from __dsh__.tools import ${name}; print(${name}.__doc__)`, undefined, undefined)).stdout
  const checkDoc = async (label, verify) => {
    try { await verify(); console.log(`  ok   ${label}`) }
    catch (error) { failures += 1; console.log(`  FAIL ${label}\n       ${error.message}`) }
  }

  await checkDoc('each description lands under the parameter it belongs to', async () => {
    const text = await doc('read')
    assert.match(text, /^Read a file\.$/m, 'the tool docstring stays first and intact')
    assert.match(text, /^Parameters:\n {4}file_path: Path to read, resolved by the filesystem backend\.$/m)
    // Indented continuation, or a description carrying newlines reads as the next parameter's.
    assert.match(text, /^ {4}offset: Line to start at\.\n {8}One-based\.$/m)
  })
  await checkDoc('the host is what puts it there, straight off the schema', async () => {
    const { specs } = toolSpecs([{ name: 'read', description: 'Read a file.', parameters: { properties: {
      file_path: { type: 'string', description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'integer' },
    }, required: ['file_path'] } }])
    assert.equal(specs[0].params[0].doc, 'Path to read, resolved by the filesystem backend.')
    // Absent, not empty: `JSON.stringify` drops `undefined`, so a parameter with no prose costs neither the wire nor `specsKey`.
    assert.ok(!Object.hasOwn(JSON.parse(JSON.stringify(specs[0].params[1])), 'doc'), 'a parameter with no description must not grow a key')
  })
  await checkDoc('a tool with no parameter prose gets no section at all', async () => {
    assert.equal((await doc('bare')).trim(), 'No parameter prose anywhere.')
  })
  await checkDoc('and the block carries it too, beside the parameter and as the docstring', async () => {
    const block = renderToolsSection([{ name: 'read', description: 'Read a file.\nSecond line.', parameters: { properties: {
      file_path: { type: 'string', description: 'Path to read, resolved by the filesystem backend.' },
      // A `#` comment cannot span lines: emitted as-is, the second line parses as code and the block stops being a program.
      offset: { type: 'integer', description: 'Line to start at.\nOne-based.' },
    }, required: ['file_path'] } }])
    assert.match(block, /async def read\(\n {4}\*,\n {4}file_path: str,  # Path to read, resolved by the filesystem backend\.\n {4}offset: int = \.\.\.,  # Line to start at\. One-based\.\n\) -> Any:\n {4}"""\n {4}Read a file\.\n {4}Second line\.\n {4}"""/, 'both halves, in the shape a Python reader expects')
  })
  docs.dispose()
}

// The block is Python the model copies from, and now it carries PROSE — so a description is no longer
// only content, it is syntax. One carrying a `"""` or ending in a backslash would close its own
// docstring and take every tool below it down, which is the failure class #12 was: one tool invalidating
// the whole block. Neither shape appears in a live catalogue, and a future MCP server is not bound by that.
console.log('a description cannot break the block it is embedded in:')
try {
  const hostile = renderToolsSection([
    { name: 'quoted', description: 'Ends a docstring early: """ and continues.', parameters: {} },
    { name: 'slashed', description: 'Ends with a backslash \\\\', parameters: {} },
    { name: 'after', description: 'Must still be here.', parameters: {} },
  ])
  const fence = hostile.slice(hostile.indexOf('```python') + 10, hostile.lastIndexOf('```'))
  execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<block>", "exec")'], { input: fence })
  assert.match(fence, /async def after\(\) -> Any:/, 'the tool after the hostile ones still renders')
  console.log('  ok   a triple quote or trailing backslash costs fidelity, never the block')
} catch (error) {
  failures += 1
  console.log(`  FAIL a triple quote or trailing backslash costs fidelity, never the block\n       ${error.message}`)
}

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
  // What the model READS and what it INTROSPECTS have to agree. The block stopped listing the flat
  // names; `dir()` did not, so 86 of 103 entries were the thing the block had just dropped, and a
  // model asked to enumerate its own tools filtered them out by hand.
  await t('the listing shows the grouping, not a hundred flat names', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
    assert.equal(r.repr, "['mcp', 'read']", r.error ?? 'unexpected listing')
  })
  await t('…while the flat name is still bound, and still dispatches', 'from __dsh__.tools import mcp__calendar__list_events as f\n(await f(calendar_id="c"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__calendar__list_events'", r.error ?? 'hidden from dir(), never unbound')
  })
  // dsh hashes a public name that needed normalising, and the cut can land before the second `__`.
  // Such a tool is under no server, so hiding it from the listing would leave it with no name at all.
  await t('a name the grouping cannot reach stays listed', 'import __dsh__.tools as T\nsorted(dir(T))', (r) => {
    assert.equal(r.repr, "['mcp', 'mcp__trunc_9f8e7d6c5b4a']", r.error ?? 'a hashed name has no server to hide under')
  }, [{ name: 'mcp__trunc_9f8e7d6c5b4a', doc: 'Normalised past recovery.', params: [] }, MCP[0]])
  // `__all__` is the star-import BINDING contract, not a listing. Narrowing it alongside `__dir__`
  // left a flat name undefined in a cell that used to work — a regression, not a quieter surface.
  await t('`import *` still binds every flat name the listing dropped', 'from __dsh__.tools import *\n(await mcp__calendar__list_events(calendar_id="c"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__calendar__list_events'", r.error ?? 'dir() hides them; `import *` must still bind them')
  })
  // The three places the model is SHOWN a listing have to agree. `repr` is the trailing-expression
  // echo — the block's own return channel — and the `Available:` list is what a typo earns.
  await t('every shown listing tells the same story', 'import __dsh__.tools as T\nsorted(dir(T)) == sorted(repr(T).split(": ", 1)[1].rstrip(">").split(", "))', (r) => {
    assert.equal(r.repr, 'True', r.error ?? '`repr` still enumerated the flat names `dir` had dropped')
  })
  // Hidden must mean reachable-elsewhere. A raw name that is a true dunder splits cleanly, so the
  // old `split_mcp is None` test hid it — while `McpModule.__getattr__` refuses exactly that shape,
  // leaving it in no listing at all.
  await t('a name the grouping cannot serve keeps its flat name', 'import __dsh__.tools as T\nfrom __dsh__.tools import mcp\n("mcp__und____odd__" in dir(T), "und" in dir(mcp), (await getattr(T, "mcp__und____odd__")())["from"])', (r) => {
    // The server drops out of the grouping entirely rather than appearing empty: every tool it has
    // is one `mcp.<server>.<tool>` cannot answer, so `mcp.und` would be a mount that never works.
    assert.equal(r.repr, "(True, False, 'mcp__und____odd__')", r.error ?? 'shown where it works, not where it does not')
  }, [{ name: 'mcp__und____odd__', doc: 'A true dunder raw name.', params: [] }, MCP[0]])
  // The ternary's required arm: making every parameter optional used to leave the suite green.
  await t('a required parameter carries no default', 'import inspect\nfrom __dsh__.tools import mcp\nstr(inspect.signature(mcp.calendar.list_events))', (r) => {
    assert.equal(r.repr, `'(*, calendar_id: 'str', limit: 'int' = Ellipsis) -> 'Any''`, r.error ?? 'required must not render a default')
  }, [{ name: 'mcp__calendar__list_events', doc: 'x', params: [{ name: 'calendar_id', type: 'str', required: true }, { name: 'limit', type: 'int', required: false }] }])
  // Every other binding is re-imported the moment the model wants a different tool. `mcp` is the
  // one it has no reason to import twice — it reads as a namespace, not as this cell's tool list —
  // so a reference kept from an earlier cell has to resolve against the catalogue in force NOW.
  const MOVED = [{ name: 'mcp__drive__list_files', doc: 'A server that arrived later.', params: [] }, MCP[2]]
  await t('a kept reference survives the catalogue moving under it', 'from __dsh__.tools import mcp\nkept = mcp\nsorted(dir(kept))', (r) => {
    assert.equal(r.repr, "['calendar', 'notion']", r.error ?? 'unexpected result')
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
    // The listing shows the spelling Python accepts, not the one dsh happens to register: `-` is
    // legal in a raw MCP name and in no identifier, so this tool was reachable only through
    // `getattr` — at every call site, and with no signature in the prompt block to go with it.
    assert.equal(r.repr, "['API_patch_block_children']", r.error)
  })
  await t('a folded name calls the tool it was folded from', 'from __dsh__.tools import mcp\n(await mcp.notion.API_patch_block_children(block_id="b"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__notion__API-patch-block-children'", r.error ?? 'dispatch still uses the raw name')
  })
  await t('and the raw spelling keeps working for a cell that already used it', 'from __dsh__.tools import mcp\n(await getattr(mcp.notion, "API-patch-block-children")(block_id="b"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__notion__API-patch-block-children'", r.error ?? 'the alias adds a name, it does not move one')
  })
  await t('the deep import form takes the folded name too', 'from __dsh__.tools.mcp.notion import API_patch_block_children\n(await API_patch_block_children(block_id="b"))["from"]', (r) => {
    assert.equal(r.repr, "'mcp__notion__API-patch-block-children'", r.error)
  })
  // An alias must never answer for a tool that already owns that spelling.
  await t('a real name is never displaced by a fold', 'from __dsh__.tools import mcp\n[(await getattr(mcp.srv, "a-b")())["from"], (await mcp.srv.a_b())["from"], sorted(dir(mcp.srv))]', (r) => {
    assert.equal(r.repr, `['mcp__srv__a-b', 'mcp__srv__a_b', ['a-b', 'a_b']]`, r.error ?? 'the collision keeps both, and shows both')
  }, [{ name: 'mcp__srv__a-b', doc: 'hyphen', params: [] }, { name: 'mcp__srv__a_b', doc: 'underscore', params: [] }])
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
    assert.equal(r.repr, "([], False)", r.error ?? 'calendar is gone from this catalogue, and the module neither lists nor serves its tools')
  }, MOVED)
  // The raw name is the server's to choose, and a leading underscore is legal in it. The block
  // renders `mcp.cal._private()` for one — which the namespace has to be able to answer.
  const UNDERSCORED = [{ name: 'mcp__cal___private', doc: 'A leading underscore is legal.', params: [] }]
  await t('a tool whose raw name starts with an underscore is still reachable', 'from __dsh__.tools import mcp\n(await mcp.cal._private())["from"]', (r) => {
    assert.equal(r.repr, "'mcp__cal___private'", r.error)
  }, UNDERSCORED)
  // Every one of these is a way the process-global registry can be corrupted from a cell, and
  // each was a live defect: the modules are shared by every agent in the process, so a mistake in
  // one shell used to be permanent and invisible to `dir()`.
  await t('a tool whose raw name starts with `__` is reachable, not just listed', 'from __dsh__.tools.mcp.und import __odd\n(await __odd())["from"]', (r) => {
    assert.equal(r.repr, "'mcp__und____odd'", r.error ?? 'a leading-`__` raw name survives dsh\'s normalisation verbatim')
  }, [{ name: 'mcp__und____odd', doc: 'Leading dunder, no trailing.', params: [] }])
  await t('a star-import binds the tools', 'from __dsh__.tools.mcp.calendar import *\nsorted(n for n in dir() if n.startswith(("list_", "create_")))', (r) => {
    assert.equal(r.repr, "['create_event', 'list_events']", r.error ?? 'star-import reads __all__, never __getattr__')
  })
  // A server may own the spelling another server's name folds to. Folding unconditionally made them
  // ONE module — `mcp_server_module` is keyed by name — so the hyphenated server's tools vanished
  // through both spellings. Caught by @sourcery-ai; the tool level already had this rule by identity.
  await t('a server name never folds onto another server', 'from __dsh__.tools import mcp\n[sorted(dir(mcp)), sorted(dir(mcp.a_b)), sorted(dir(getattr(mcp, "a-b")))]', (r) => {
    assert.equal(r.repr, `[['a-b', 'a_b'], ['from_underscore'], ['from_hyphen']]`, r.error ?? 'each server keeps its own module')
  }, [{ name: 'mcp__a-b__from_hyphen', doc: 'x', params: [] }, { name: 'mcp__a_b__from_underscore', doc: 'x', params: [] }])
  await t('and the collided server still dispatches under its raw name', 'from __dsh__.tools import mcp\n(await getattr(mcp, "a-b").from_hyphen())["from"]', (r) => {
    assert.equal(r.repr, "'mcp__a-b__from_hyphen'", r.error)
  }, [{ name: 'mcp__a-b__from_hyphen', doc: 'x', params: [] }, { name: 'mcp__a_b__from_underscore', doc: 'x', params: [] }])
  // The fold is spelled twice — `spellable` in the kernel, `fold` + `isUsableName` in the block —
  // and the two must agree on every input, or a tool is listed under a name the other half routes
  // through `getattr`. `str.isidentifier()` is NOT the host's rule: it accepts keywords, so a raw
  // `-` folds to `_` (a soft keyword) and was bound and listed here while the block pointed at
  // `getattr(mcp.srv, "-")` for the same tool.
  await t('a fold landing on a keyword is refused, as the block refuses it', 'from __dsh__.tools import mcp\nsorted(dir(mcp.srv))', (r) => {
    // `ok-name` folds and the raw spelling leaves the listing; `-` stays as itself, because its
    // fold is a soft keyword the block would refuse — so both halves send it to `getattr`.
    assert.equal(r.repr, `['-', 'ok_name']`, r.error ?? 'only the fold that is a legal identifier is taken')
  }, [{ name: 'mcp__srv__-', doc: 'folds to a soft keyword', params: [] }, { name: 'mcp__srv__ok-name', doc: 'folds cleanly', params: [] }])
  // The block leads its import line with `ToolCallError` so the natural `except ToolCallError`
  // resolves. A cell that reaches for `import *` instead used to lose that name — and find out
  // inside the `except` clause, as a NameError raised while handling the failure it was meant to
  // explain. Not in `dir()`/`repr()`, which answer "what tools do I have"; it is not a tool.
  await t('a star-import binds the failure path, not only the tools', 'from __dsh__.tools import *\n(ToolCallError.__name__, "ToolCallError" in dir(__import__("__dsh__.tools", fromlist=["x"])))', (r) => {
    assert.equal(r.repr, "('ToolCallError', False)", r.error ?? '`import *` must bind it; the listing must not show it')
  })
  // The host mirrors the kernel's reservations as a two-name literal, which is only correct while
  // every other reserved name starts with `_` and is dropped by the prefix rule. Checked from the
  // Python side so adding a plain attribute to `ToolsModule` fails here instead of silently
  // advertising a tool that will never bind.
  await t('the reservation the host mirrors is the whole reservation', 'import types\nimport __dsh__.tools as T\nsorted(n for n in set(vars(type(T))) | set(vars(types.ModuleType)) | {"ToolCallError", "mcp"} if not n.startswith("_"))', (r) => {
    assert.equal(r.repr, "['ToolCallError', 'mcp']", r.error ?? 'a new plain attribute here needs mirroring in RESERVED_NAMES')
  })
  await t('writing to the namespace is refused instead of poisoning every other agent', 'from __dsh__.tools import mcp\nmcp.calendar = "poison"', (r) => {
    assert.equal(r.ok, false)
    assert.match(r.error, /shared by every agent in this process/)
  })
  await t('deleting a server module out of sys.modules does not wedge the session', 'import sys\ndel sys.modules["__dsh__.tools.mcp.calendar"]\nfrom __dsh__.tools import mcp\n(sorted(dir(mcp)), (await mcp.calendar.list_events(calendar_id="c"))["from"])', (r) => {
    assert.equal(r.repr, "(['calendar', 'notion'], 'mcp__calendar__list_events')", r.error ?? 'the module is rebuilt on the next ask')
  })

  // The root exists for the whole process, so it survives a shell that mounted no MCP server at
  // all — `mcp` means the namespace or nothing, never a half-installed package. The tool LISTING
  // is still honest: `dir(__dsh__.tools)` does not offer `mcp` when there is nothing under it.
  const NO_MCP = [{ name: 'read', doc: 'A native tool, and the only one.', params: [] }]
  await ns.start(NO_MCP, 'plain')
  try {
    const r = await ns.exec('import __dsh__.tools as T\nfrom __dsh__.tools import mcp\n(type(mcp).__name__, dir(mcp), "mcp" in dir(T), sorted(dir(T)))', undefined, NO_MCP, 'plain')
    assert.equal(r.repr, `('McpModule', [], False, ['read'])`, r.error ?? 'unexpected result')
    console.log('  ok   a shell with no MCP server still has the package, and is not offered it')
  } catch (error) { failures += 1; console.log(`  FAIL a shell with no MCP server still has the package, and is not offered it\n       ${error.message}`) }

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

// The block is Python the model is invited to copy, and until now nothing had ever RUN it. That is
// how a `Literal` shipped for a release with no import: every assertion above reads the text, and
// only an interpreter says whether the text is a program. Every shape that has broken it before is
// in this catalogue — a name Python refuses, a parameter it refuses, an enum, a union of objects.
console.log('the rendered block is a program:')
{
  const nested = { type: 'object', properties: { text: { type: 'string' }, truncated: { type: 'boolean' } }, required: ['text', 'truncated'] }
  const schemas = [
    { name: 'bash', description: 'Run it.', parameters: { properties: { command: { type: 'string' }, mode: { type: 'string', enum: ['fg', 'bg'] } }, required: ['command'] }, output: { oneOf: [
      { type: 'object', properties: { kind: { type: 'string', const: 'background' }, jobId: { type: 'string' } }, required: ['kind', 'jobId'] },
      { type: 'object', properties: { kind: { type: 'string', const: 'foreground' }, stdout: nested }, required: ['kind', 'stdout'] },
    ] } },
    { name: 'job_list', parameters: { properties: {} }, output: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
    { name: 'read', parameters: { properties: { file_path: { type: 'string' } }, required: ['file_path'] }, output: { type: 'string' } },
    { name: 'odd', parameters: { properties: { 'file-path': { type: 'string' } }, required: ['file-path'] }, output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    { name: '123tool', parameters: { properties: {} }, output: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } },
    { name: 'mcp__review__search', parameters: { properties: { q: { type: 'string' } }, required: ['q'] }, output: { type: 'object', additionalProperties: false, required: ['content', 'structuredContent'], properties: { content: { type: 'array', items: {} }, structuredContent: { type: 'object', properties: { hits: { type: 'integer' } }, required: ['hits'] } } } },
    { name: 'mcp__review__odd-name', parameters: { properties: {} }, output: { type: 'string' } },
    // A parameter the enclosing stub already spent, and a name the kernel will not bind: both used
    // to reach the fence, one as a SyntaxError and one as an ImportError.
    { name: 'mcp__review__by_self', parameters: { properties: { self: { type: 'string' } }, required: ['self'] }, output: { type: 'string' } },
    { name: '_private', parameters: { properties: {} }, output: { type: 'string' } },
  ]
  const { specs } = toolSpecs(schemas)
  const runner = new PythonKernel({ cwd: process.cwd(), onCall: async () => ({ ok: true, value: null }) })
  await runner.start(specs)
  // Its own shell: the fence redefines every tool it imports, so running it anywhere else would
  // leave the stubs behind for the next assertion to call.
  const fence = renderToolsSection(schemas).split('```python\n')[1].split('\n```')[0]
  const ran = await runner.exec(`${fence}\n[bash.__annotations__["return"], read.__annotations__["return"], sorted(n for n in globals() if n in ("search", "by_self", "odd-name"))]`, undefined, specs)
  try {
    assert.ok(ran.ok, `the block runs as written: ${ran.error?.message ?? ran.stderr}`)
    // Not just parseable — the annotations have to EVALUATE, which is where a missing import shows up.
    assert.match(ran.repr ?? '', /BashOutput1 \| .*BashOutput2/, 'and its union annotation is a real type, not a string')
    // Executing the block must not bind a server's tools: only `mcp` is, and a bare definition
    // under a server header would shadow whatever native tool shares that raw name.
    assert.match(ran.repr ?? '', /\[\]/, 'and no server tool leaked into the namespace the block runs in')
    console.log('  ok   it imports, declares and annotates without raising')
  } catch (error) {
    failures += 1
    console.log(`  FAIL it imports, declares and annotates without raising\n       ${error.message}`)
  }
  runner.dispose()
}

kernel.dispose()
console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
