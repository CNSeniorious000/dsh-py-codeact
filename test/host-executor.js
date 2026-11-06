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
  apply(ctx)
  try {
    assert.deepEqual(describe({ scope: agent }).schemas.map(({ name }) => name), ['python'])
    assert.match(sections.find(({ name }) => name === 'py-codeact:sdk').text({ scope: agent }), /probe/)
    const run = async (name, args) => (await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `call-${events.length}`, name, arguments: JSON.stringify(args) }], agent, signal: AbortSignal.timeout(30000) })).results[0].result
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
    console.log('  ok   new host schemas, exclusive guard, nested dispatch, and persistent Python state')
  } finally {
    await ctx.parallel('dispose')
  }
}
