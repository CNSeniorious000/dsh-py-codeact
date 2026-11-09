import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import plugin, { apply } from '../lib/index.js'
import { createHost } from './streaming-fixture.js'

const prompt = () => createUserMessage({ content: [{ type: 'text', text: 'Run the fixture.' }], source: { kind: 'human' } })
const finish = { type: 'finish', reason: { kind: 'tool-calls' } }
const encode = text => JSON.stringify(text).slice(1, -1)
const bothEntered = Promise.withResolvers(), entered = [], counts = new Map()
const host = await createHost({ id: 'scoped-first', streaming: false, config: { uiOnly: true },
  async *stream(request) {
    const attempt = (counts.get(request.sessionId) ?? 0) + 1
    counts.set(request.sessionId, attempt)
    const code = attempt === 1 ? `from __dsh__.tools import probe\nowner = ${JSON.stringify(request.sessionId)}\nawait probe(value=owner)\n` : 'await probe(value=owner)\n'
    yield { type: 'tool-call-delta', index: 0, id: `scoped-${attempt}`, name: 'python', argumentsDelta: '{"code":"' + encode(code) }
    if (attempt === 1) await bothEntered.promise
    yield { type: 'tool-call-delta', index: 0, id: `scoped-${attempt}`, name: 'python', argumentsDelta: '","description":"Scoped execution"}' }
    yield finish
  },
})
let second, timeout
try {
  host.ctx.tools.register(defineTool({ name: 'probe', description: 'Record the owning agent.', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute({ value }, exec) { entered.push([exec.agent.id, value]); if (entered.length === 2) bothEntered.resolve(); return value } }))
  await host.agent.ctx.plugin(plugin, { streaming: true })
  second = await host.ctx.agents.create({ sessionId: 'scoped-second', agentOptions: { provider: 'fixture', model: 'controlled' }, meta: { cwd: process.cwd() },
    setup: async (agentCtx) => { await agentCtx.plugin(plugin, { streaming: true }) } })
  timeout = setTimeout(() => bothEntered.reject(new Error('Scoped source execution timed out')), 15000)
  second.agent.followup(prompt())
  await host.run({ signal: AbortSignal.timeout(15000) })
  await second.agent.whenIdle()
  clearTimeout(timeout)
  assert.deepEqual(entered.toSorted(), [['scoped-first', 'scoped-first'], ['scoped-second', 'scoped-second']])
  for (const agent of [host.agent, second.agent]) {
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result')
    assert.notEqual(result.data.message.isError, true)
    assert.ok(events.find(event => event.type === 'user/message' && event.data.source.kind === 'python-stream' && event.data.source.phase === 'result').seq < events.find(event => event.type === 'step/end').seq)
  }
  await second.dispose()
  second = undefined
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(entered.at(-1), ['scoped-first', 'scoped-first'])
  console.log('PASS: concurrent agent-scoped mounts stay isolated and survive sibling disposal')
} finally { clearTimeout(timeout); bothEntered.resolve(); await second?.dispose(); await host.close() }

const ctx = new Context(), waiting = Promise.withResolvers(), release = Promise.withResolvers()
class DelayedProjections extends SessionProjectionRegistry {
  async register(definition) {
    const handle = await super.register(definition)
    waiting.resolve()
    await release.promise
    return handle
  }
}
try {
  await ctx.plugin(DelayedProjections)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolsService)
  const llm = await ctx.plugin(LlmRuntime)
  const pending = ctx.plugin({ ...plugin, name: 'pending-streaming', apply: (child) => apply(child, { streaming: true }) })
  await waiting.promise
  const disposal = pending.dispose()
  release.resolve()
  await disposal
  await Promise.resolve(pending).catch(() => {})
  assert.equal(ctx.tools.definitions().length, 0)
  const replacement = await ctx.plugin({ ...plugin, name: 'replacement-streaming', apply: (child) => apply(child, { streaming: true }) })
  assert.ok(ctx.tools.definitions().some(tool => tool.name === 'python'))
  await replacement.update({ streaming: true })
  assert.equal(ctx.tools.definitions().filter(tool => tool.name === 'python').length, 1)
  await llm.dispose()
  assert.equal(ctx.tools.definitions().length, 0, 'dependent tools must unload with the LLM service')
  await ctx.plugin(LlmRuntime)
  for (let tries = 0; !ctx.tools.definitions().some(tool => tool.name === 'python'); tries++) {
    assert.ok(tries < 100, 'streaming did not reactivate after its service returned')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await replacement.dispose()
  assert.equal(ctx.tools.definitions().length, 0)
  console.log('PASS: HMR and required-service replacement release and recreate streaming effects')
  console.log('PASS: disposal during projection registration leaves no late tools or stale registrations')
} finally { release.resolve(); await ctx.fiber.dispose() }
