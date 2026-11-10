import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createHost } from './streaming-fixture.js'
import plugin from '../lib/index.js'
import settings, { apply as installSettings } from '../lib/settings.js'

async function bounded(operation) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CodeAct bootstrap or disposal did not settle')), 1000) })]) }
  finally { clearTimeout(timer) }
}

for (const missing of ['sessions', 'sessionProjections', 'llm']) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolsService)
    for (const [name, service] of [['sessions', SessionStore], ['sessionProjections', SessionProjectionRegistry], ['llm', LlmRuntime]]) if (name !== missing) await ctx.plugin(service)
    await ctx.plugin(settings)
    assert.equal(ctx.get(missing), undefined)
    assert.equal(ctx.get('pyCodeActSettings').streaming.get(), false)
    await bounded(ctx.plugin(plugin))
    assert.ok(ctx.tools.get('python'), `default settings must not hide Python when ${missing} is absent`)
    assert.equal(ctx.tools.get('python_stream'), undefined)
    console.log(`PASS: default settings preserve whole-cell bootstrap without ${missing}`)
  } finally { await bounded(ctx.fiber.dispose()) }
}

let enabled = false, observed = Promise.withResolvers()
const effects = []
const host = await createHost({
  id: 'streaming-settings', config: { streaming: undefined },
  setup({ ctx }) {
    // Preset entries can activate before the profile's settings entry.
    installSettings(ctx, { streaming: { get: () => enabled } })
    ctx.tools.register(defineTool({ name: 'probe', description: 'Record one effect.', parameters: { value: { type: 'number', required: true } },
      output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute({ value }) { effects.push(value); observed.resolve(); return value } }))
  },
  async *stream(request, number) {
    const streaming = number % 2 === 0
    const prompt = JSON.stringify(request)
    assert.match(prompt, streaming ? /Stable statements execute once/ : /LAST expression is echoed/)
    assert.doesNotMatch(prompt, streaming ? /LAST expression is echoed/ : /Stable statements execute once/)
    const code = 'import os\nfrom __dsh__.tools import probe\ncounter = globals().get("counter", 0) + 1\nawait probe(value=counter)\nprint("STATE", counter, os.getpid())\ncounter\n'
    yield { type: 'tool-call-delta', index: 0, id: `cell-${number}`, name: 'python', argumentsDelta: '{"code":' + JSON.stringify(code).slice(0, -1) }
    // A settings write during generation affects the next request, including when this one has not started executing.
    enabled = !streaming
    if (streaming) await observed.promise
    else assert.equal(effects.length, number - 1)
    if (number === 4) throw new Error('Source interrupted after an early effect')
    yield { type: 'tool-call-delta', index: 0, id: `cell-${number}`, name: 'python', argumentsDelta: '","description":"Keep one CodeAct session"}' }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  },
})
try {
  const pids = []
  for (let turn = 1; turn <= 5; turn++) {
    observed = Promise.withResolvers()
    if (turn === 4) {
      await assert.rejects(host.run({ signal: AbortSignal.timeout(15000) }), /Source interrupted after an early effect/)
      continue
    }
    await host.run({ signal: AbortSignal.timeout(15000) })
    const result = host.events.findLast(event => event.type === 'tool/result').data.message
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, new RegExp(`STATE ${turn} (\\d+)`))
    pids.push(text.match(/STATE \d+ (\d+)/)[1])
    if (turn === 2) assert.doesNotMatch(text, /<return>/)
    else assert.match(text, /<return>/)
  }
  assert.deepEqual(effects, [1, 2, 3, 4, 5])
  assert.equal(new Set(pids).size, 1, 'settings changes must retain the interpreter and its namespace')
  assert.equal(host.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'python-stream' && event.data.source.phase === 'start').length, 2)
  assert.equal(host.requests, 5)
  console.log('PASS: mode changes retain namespace, step semantics, and exactly-once effects after success and interruption')
} finally { await host.close() }

for (const [streaming, restricted] of [[false, false], [true, false], [true, true]]) {
  const effects = []
  let ctx, agent, toolSet, releaseRestriction
  const host = await createHost({
    id: `complete-block-${streaming}-${restricted}`, streaming,
    setup(value) {
      ({ ctx, agent } = value)
      ctx.on('system-prompt/assemble', (_assembly, context, next) => { toolSet = context.toolSet; return next() })
      ctx.tools.register(defineTool({ name: 'probe', description: 'Record one effect.', parameters: { value: { type: 'number', required: true } },
        output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute({ value }) { effects.push(value); return value } }))
    },
    async *stream(request) {
      assert.match(JSON.stringify(request), streaming ? /Stable statements execute once/ : /LAST expression is echoed/)
      if (restricted) {
        assert.ok(ctx.tools.executable('python_stream', agent, toolSet))
        releaseRestriction = agent.ctx.tools.restrict({ deny: ['python_stream'] })
        assert.equal(ctx.tools.executable('python_stream', agent, toolSet), undefined)
      }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'complete-cell', name: 'python',
        arguments: JSON.stringify({ code: 'from __dsh__.tools import probe\ncounter = globals().get("counter", 0) + 1\nawait probe(value=counter)\nprint("FALLBACK", counter)\ncounter\n', description: 'Execute a completed Python call' }) } }
      assert.deepEqual(effects, [], 'a complete block without deltas must wait for the final dispatch')
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  })
  try {
    await host.run({ signal: AbortSignal.timeout(15000) })
    assert.deepEqual(effects, [1])
    const result = host.events.findLast(event => event.type === 'tool/result').data.message
    assert.notEqual(result.isError, true, JSON.stringify(result))
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.match(text, /FALLBACK 1/)
    if (streaming) assert.doesNotMatch(text, /<return>/, 'the completed fallback must retain raw Python semantics after admission shrinks')
    else assert.match(text, /<return>1<\/return>/)
    assert.equal(host.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'python-stream').length, 0, 'a completed fallback is never an early source admission')
    console.log(`PASS: complete-block fallback streaming=${streaming} restricted=${restricted} preserves step semantics and executes once`)
  } finally { releaseRestriction?.(); await host.close() }
}
