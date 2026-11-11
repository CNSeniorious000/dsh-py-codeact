import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import * as tools from '@deepseek-ai/dsh-tools'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../lib/index.js'

// Older hosts are covered by dispatch.js; this exercises the real registry and policy pipeline after their API split.
if (!tools.renderToolsSdkPy) {
  const ctx = new Context(), sections = [], events = []
  let describe
  class Prompt extends Service {
    constructor() { super(ctx, 'systemPrompt') }
    tools(provider) { describe = provider }
    section(section) { sections.push(section) }
  }
  new Prompt()
  new LocalSubprocess(ctx)
  class Policy extends Service {
    constructor() { super(ctx, 'sandboxPolicy') }
    resolve() { return { mode: 'danger-full-access', workspaceRoot: process.cwd() } }
  }
  new Policy()
  new tools.ToolsService(ctx)
  const session = { id: 'executor-test', header: { version: 4, cwd: process.cwd() }, append: (type, data) => events.push({ type, data }), deriveMessages: () => [] }
  const agent = { id: session.id, session }
  ctx.tools.register(tools.defineTool({ name: 'probe', description: 'Return the input plus one.', parameters: { value: { type: 'number', required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: ({ value }) => value + 1 }))
  ctx.tools.register(tools.defineTool({ name: 'finish_turn', description: 'Conclude only on success.', parameters: { fail: { type: 'boolean', required: true } },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: ({ fail }, exec) => { exec.concludeTurn(); if (fail) throw new Error('terminal tool failed'); return 42 } }))
  let admitted = true
  ctx.tools.register(tools.defineTool({ name: 'conditional', description: 'A conditionally admitted tool.', parameters: {}, output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: () => 42 }), { when: () => admitted })
  const delegation = { oneOf: ['foreground', 'background', 'continuable'].map((kind) => ({ type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: kind, required: true } } })) }
  ctx.tools.register(tools.defineTool({ name: 'delegate', description: 'Conditional delegation.', parameters: {}, output: { schema: delegation, render: () => [] }, execute: () => ({ kind: 'foreground' }) }), { when: () => admitted })
  apply(ctx)
  try {
    assert.deepEqual(describe({ scope: agent }).schemas.map(({ name }) => name), ['python'])
    assert.match(sections.find(({ name }) => name === 'py-codeact:sdk').text({ scope: agent }), /probe/)
    const run = async (name, args, toolSet) => (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `call-${events.length}`, name, arguments: JSON.stringify(args) }], agent, toolSet, signal: AbortSignal.timeout(30000) })).results[0].result
    const denied = await run('probe', { value: 41 })
    assert.equal(denied.isError, true, 'exclusive mode must deny direct calls to other tools')
    const result = await run('python', { code: 'from __dsh__.tools import probe\nawait probe(value=41)', description: 'Verify nested dispatch' })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.match(result.value, /42/)
    assert.equal(events.filter(({ type }) => type === 'tool/ptc-dispatch-start').length, 1)
    assert.equal(events.filter(({ type }) => type === 'tool/ptc-dispatch').length, 1)
    const persisted = await run('python', { code: 'probe.__name__', description: 'Verify persistent state' })
    assert.equal(persisted.isError, false, JSON.stringify(persisted))
    assert.match(persisted.value, /probe/)
    const terminal = await run('python', { code: 'from __dsh__.tools import finish_turn\nawait finish_turn(fail=False)', description: 'Verify nested turn completion' })
    assert.equal(terminal.isError, false, JSON.stringify(terminal))
    assert.equal(terminal.concludesTurn, true, 'successful nested terminal tools must conclude the outer turn')
    const failedTerminal = await run('python', { code: 'await finish_turn(fail=True)', description: 'Verify failed completion is discarded' })
    assert.match(failedTerminal.value, /terminal tool failed/)
    assert.equal(failedTerminal.concludesTurn, undefined, 'failed nested tools must not conclude the turn')
    let active = 0, peak = 0, policyActive = false
    const schedule = []
    ctx.tools.register(tools.defineTool({ name: 'schedule_probe', description: 'Observe tool scheduling.',
      parameters: { id: { type: 'number', required: true }, parallel: { type: 'boolean', required: true } },
      output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      isConcurrencySafe: ({ parallel }) => parallel,
      async execute({ id }) {
        active++; peak = Math.max(peak, active); schedule.push(`start:${id}`)
        await new Promise(resolve => setTimeout(resolve, 20))
        schedule.push(`end:${id}`); active--
        return id
      } }))
    const policy = async (exec, next, stage) => {
      if (exec.name !== 'schedule_probe') return next()
      assert.equal(policyActive, false, 'pre/post policy stages must not overlap')
      policyActive = true
      schedule.push(`${stage}:${exec.arguments.id}`)
      await new Promise(resolve => setTimeout(resolve, 2))
      policyActive = false
      return next()
    }
    ctx.on('tools/pre-execute', (exec, next) => policy(exec, next, 'pre'))
    ctx.on('tools/post-execute', (exec, _result, next) => policy(exec, next, 'post'))
    const parallelCalls = (count, parallel) => `from __dsh__.tools import schedule_probe\nimport asyncio\nawait asyncio.gather(*(schedule_probe(id=i, parallel=${parallel}) for i in range(${count})))`
    assert.equal((await run('python', { code: parallelCalls(2, 'False'), description: 'Serialize exclusive tools' })).isError, false)
    assert.equal(peak, 1)
    assert.deepEqual(schedule, ['pre:0', 'start:0', 'end:0', 'post:0', 'pre:1', 'start:1', 'end:1', 'post:1'])
    peak = 0; schedule.length = 0
    assert.equal((await run('python', { code: parallelCalls(12, 'True'), description: 'Bound safe concurrency' })).isError, false)
    assert.ok(peak > 1 && peak <= 10, `unexpected concurrency ${peak}`)
    assert.deepEqual(schedule.filter(stage => stage.startsWith('post:')), Array.from({ length: 12 }, (_, id) => `post:${id}`))
    schedule.length = 0
    await run('python', { code: 'await asyncio.gather(schedule_probe(id=0, parallel=True), schedule_probe(id=1, parallel=False), schedule_probe(id=2, parallel=True))', description: 'Preserve exclusive barriers' })
    assert.ok(schedule.indexOf('post:0') < schedule.indexOf('pre:1'))
    assert.ok(schedule.indexOf('post:1') < schedule.indexOf('pre:2'))
    console.log('  ok   Python gathers honor exclusive barriers, bounded safe concurrency, and ordered policy')
    const resolve = () => ctx.tools.resolve({ agent, signal: AbortSignal.timeout(30000) })
    const allowed = await resolve()
    const sdk = sections.find(({ name }) => name === 'py-codeact:sdk')
    const orchestration = sections.find(({ name }) => name === 'py-codeact:orchestration')
    try {
      assert.match(sdk.text({ scope: agent, toolSet: allowed }), /conditional/)
      assert.notEqual(orchestration.text({ scope: agent, toolSet: allowed }), '')
      const nested = await run('python', { code: 'from __dsh__.tools import conditional\nawait conditional()', description: 'Verify conditional admission' }, allowed)
      assert.match(nested.value, /42/, JSON.stringify(nested))
    } finally { allowed.dispose() }
    admitted = false
    const blocked = await resolve()
    try {
      assert.doesNotMatch(sdk.text({ scope: agent, toolSet: blocked }), /conditional/)
      assert.equal(orchestration.text({ scope: agent, toolSet: blocked }), '')
      const hidden = await run('python', { code: 'import __dsh__.tools as T\nhasattr(T, "conditional")', description: 'Verify refreshed bindings' }, blocked)
      assert.match(hidden.value, /False/, JSON.stringify(hidden))
      const stale = await run('python', { code: 'await conditional()', description: 'Verify retained alias is denied' }, blocked)
      assert.doesNotMatch(stale.value, /<return>\s*42/)
      assert.match(stale.value, /ToolCallError|unknown|not found|not available/i, JSON.stringify(stale))
    } finally { blocked.dispose() }
    console.log('  ok   new host schemas, exclusive guard, nested dispatch, and persistent Python state')
  } finally {
    await ctx.parallel('dispose')
  }
}
