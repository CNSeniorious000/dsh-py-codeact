import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHost } from './streaming-fixture.js'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const encode = (text) => JSON.stringify(text).slice(1, -1)
const delta = (argumentsDelta, id = 'python-1') => ({ type: 'tool-call-delta', index: 0, id, name: 'python', argumentsDelta })
const finish = (kind = 'tool-calls') => ({ type: 'finish', reason: { kind } })
const reports = []
async function scenario(name, options, test) {
  const start = performance.now(), effects = [], gates = new Map(), dispatches = []
  const observed = (value) => {
    if (effects.some((effect) => effect.value === value)) return Promise.resolve()
    if (!gates.has(value)) gates.set(value, Promise.withResolvers())
    return gates.get(value).promise
  }
  const host = await createHost({ id: name, ...options, setup({ ctx }) {
    ctx.tools.register(defineTool({ name: 'probe', description: 'Record an observable effect.', parameters: { value: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute({ value }, exec) {
        assert.ok(exec.parent, 'nested dispatch must retain its real parent')
        effects.push({ value, ms: Math.round(performance.now() - start) })
        gates.get(value)?.resolve()
        return value
      } }))
    ctx.tools.guard((exec) => { dispatches.push({ name: exec.name, callId: exec.callId, parent: exec.parent?.callId ?? exec.parent, rootCallId: exec.rootCallId }) })
    options.setup?.({ ctx })
  } })
  try {
    const originalAppend = host.session.append
    await test({ host, effects, observed, dispatches, start })
    assert.equal(host.session.append, originalAppend, 'plugin must not intercept Session.append')
    const notices = host.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'python-stream')
    for (const admission of notices.filter(event => event.data.source.phase === 'start')) {
      const { streamId, turn, step } = admission.data.source
      const result = notices.find(event => event.data.source.phase === 'result' && event.data.source.streamId === streamId)
      const end = host.events.find(event => event.type === 'step/end' && event.data.turn === turn && event.data.step === step)
      assert.ok(result && end && result.seq < end.seq, 'Python must settle before the host closes its step')
    }
    const report = { name, effects, requests: host.requests, events: host.events.map((e) => e.type), dispatches, ms: Math.round(performance.now() - start) }
    reports.push(report)
    console.log(`PASS: ${name} ${JSON.stringify({ effects, requests: host.requests })}`)
  } finally { await host.close() }
}

for (const streaming of [true, false]) {
  let effect, state, ended = false
  await scenario(streaming ? 'streaming-before-finish' : 'whole-cell-after-finish', {
    streaming,
    async *stream(request) {
      if (streaming) {
        const prompt = JSON.stringify(request)
        assert.match(prompt, /Stable statements execute once/)
        assert.doesNotMatch(prompt, /LAST expression is echoed/)
      }
      yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='first')\n"))
      if (streaming) await effect('first')
      else await pause(40)
      assert.deepEqual(state.map(({ value }) => value), streaming ? ['first'] : [])
      assert.equal(ended, false)
      yield delta(encode("for item in ['loop']:\n    await probe(value=item)\n"))
      await pause(40)
      assert.deepEqual(state.map(({ value }) => value), streaming ? ['first'] : [], 'suite must wait for successful EOF')
      ended = true
      yield delta('","description":"Streaming comparison"}')
      yield finish()
    },
  }, async ({ host, effects, observed, dispatches }) => {
    effect = observed; state = effects
    await host.run({ signal: AbortSignal.timeout(15000) })
    assert.deepEqual(effects.map(({ value }) => value), ['first', 'loop'], 'final completed call must not replay effects')
    assert.equal(dispatches.filter(({ name }) => name === (streaming ? 'python_stream' : 'python')).length, 1)
    const assistant = host.events.findIndex((e) => e.type === 'assistant/message')
    const result = host.events.findIndex((e) => e.type === 'tool/result')
    assert.ok(assistant >= 0 && result > assistant, 'outer result must follow the settled assistant call')
    if (streaming) assert.ok(host.events.findIndex((e) => e.type === 'tool/ptc-dispatch') < assistant, 'nested effects must be real and early')
  })
}

for (const changed of [false, true]) {
  let effect
  await scenario(changed ? 'authoritative-source-change-is-rejected' : 'provider-normalized-arguments-preserve-source', {
    async *stream() {
      const code = "from __dsh__.tools import probe\nawait probe(value='first')\nfor item in ['tail']:\n    await probe(value=item)\n"
      const args = { code, description: 'Normalize JSON without changing the source' }
      yield delta(JSON.stringify(args, null, 2))
      await effect('first')
      // pi-ai streams provider JSON, then emits a block-end with JSON.stringify(parsedArguments).
      const normalized = JSON.stringify({ description: args.description, code: changed ? code.replace("'first'", "'changed'") : code })
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'python-1', name: 'python', arguments: normalized } }
      if (!changed) {
        // The host freezes a block at its first authoritative close; later data cannot change that invocation.
        yield { ...delta('{"code":"raise AssertionError(123)"}', 'ignored-id'), name: 'ignored-tool' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Ignored replacement after close' } }
      }
      yield finish()
    },
  }, async ({ host, effects, observed }) => {
    effect = observed
    const execution = host.run({ signal: AbortSignal.timeout(15000) })
    if (changed) await assert.rejects(execution)
    else await execution
    assert.deepEqual(effects.map(({ value }) => value), changed ? ['first'] : ['first', 'tail'])
    if (!changed) assert.equal(host.events.findLast(event => event.type === 'tool/result').data.message.isError, false)
    assert.equal(host.requests, 1)
  })
}

for (const mutation of ['call-id', 'tool-name', 'extra-call', 'text-replacement']) {
  let effect
  await scenario(`authoritative-${mutation}-change-cannot-replay`, {
    async *stream(_request, attempt) {
      if (attempt > 1) {
        yield delta(JSON.stringify({ code: "print('STATE', counter, cleaned)\n", description: 'Inspect earlier effects and completed cleanup' }), 'inspect-state')
        yield finish()
        return
      }
      const code = "from __dsh__.tools import probe\nfrom contextlib import asynccontextmanager\nimport asyncio\ncounter = globals().get('counter', 0) + 1\ncleaned = False\n@asynccontextmanager\nasync def scope():\n    try:\n        yield\n    finally:\n        await asyncio.sleep(0.03)\n        globals()['cleaned'] = True\nasync with scope():\n    await probe(value='first')\n    for item in ['tail']:\n        await probe(value=item)\n"
      const args = JSON.stringify({ code, description: 'Reject a changed committed invocation' })
      yield delta(args)
      await effect('first')
      yield { type: 'block-end', index: 0, block: mutation === 'text-replacement' ? { type: 'text', text: 'The tool call was replaced.' }
        : { type: 'tool-call', id: mutation === 'call-id' ? 'changed-id' : 'python-1', name: mutation === 'tool-name' ? 'probe' : 'python', arguments: args } }
      if (mutation === 'extra-call') yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'extra-id', name: 'python',
        arguments: JSON.stringify({ code: 'counter += 10\n', description: 'This unadmitted call must not execute' }) } }
      yield finish()
    },
  }, async ({ host, effects, observed }) => {
    effect = observed
    await assert.rejects(host.run({ signal: AbortSignal.timeout(15000) }))
    await host.run({ signal: AbortSignal.timeout(15000) })
    assert.deepEqual(effects.map(({ value }) => value), ['first'])
    const result = host.events.findLast(event => event.type === 'tool/result').data.message
    assert.equal(result.isError, false)
    assert.match(JSON.stringify(result.content), /STATE 1 True/, 'changed final identities must neither replay Python nor outlive their step cleanup')
  })
}

for (const failure of ['max-tokens', 'disconnect', 'missing-finish']) {
  let effect
  await scenario(failure, {
    async *stream() {
      yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='retained')\n"))
      await effect('retained')
      yield delta(encode("for item in ['never']:\n    await probe(value=item)\n"))
      if (failure === 'disconnect') throw new Error('provider disconnected after one effect')
      if (failure === 'max-tokens') yield finish('max-tokens')
    },
  }, async ({ host, effects, observed }) => {
    effect = observed
    const result = await host.run({ signal: AbortSignal.timeout(15000) }).catch((error) => error)
    if (failure === 'max-tokens') assert.equal(result.kind, 'max-tokens')
    else assert.ok(result instanceof Error, String(result))
    assert.deepEqual(effects.map(({ value }) => value), ['retained'])
    assert.equal(host.requests, 1, 'a partial execution must never trigger an automatic generation retry')
  })
}

let runtimeEffect
await scenario('runtime-failure-and-persistent-namespace', {
  async *stream(_request, attempt) {
    if (attempt === 1) {
      yield delta('{"code":"' + encode("from __dsh__.tools import probe\nkept = 41\nawait probe(value='before-error')\nraise ValueError('intentional failure')\n"))
      await runtimeEffect('before-error')
      await pause(60)
      yield delta(encode("await probe(value='never')\n") + '","description":"Fail after an effect"}')
    } else yield delta(JSON.stringify({ code: "await probe(value=str(kept + 1))\n", description: 'Read prior state' }), 'python-2')
    yield finish()
  },
}, async ({ host, effects, observed }) => {
  runtimeEffect = observed
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.match(JSON.stringify(host.events), /intentional failure/)
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects.map(({ value }) => value), ['before-error', '42'])
})

await scenario('nested-policy-denial', {
  setup({ ctx }) { ctx.tools.guard((exec) => exec.name === 'probe' ? 'blocked by the real nested tool policy' : undefined) },
  async *stream() {
    yield delta(JSON.stringify({ code: "from __dsh__.tools import probe\nawait probe(value='denied')\n", description: 'Check nested guard' }))
    yield finish()
  },
}, async ({ host, effects, dispatches }) => {
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects, [])
  assert.ok(dispatches.some(({ name, parent, rootCallId }) => name === 'probe' && parent && rootCallId === 'python-1'), JSON.stringify(dispatches))
  assert.match(JSON.stringify(host.events), /blocked by the real nested tool policy/)
})

let cancellationEffect
const controller = new AbortController()
await scenario('cancel-while-awaiting-source', {
  async *stream() {
    yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='before-cancel')\n"))
    await cancellationEffect('before-cancel')
    controller.abort(new Error('cancelled by fixture'))
    yield delta(encode("await probe(value='never')\n"))
  },
}, async ({ host, effects, observed }) => {
  cancellationEffect = observed
  await assert.rejects(host.run({ signal: controller.signal }), /cancelled by fixture/)
  assert.deepEqual(effects.map(({ value }) => value), ['before-cancel'])
})

for (const phase of ['admission', 'execution']) {
  const waiting = Promise.withResolvers(), release = Promise.withResolvers()
  let flushes = 0
  await scenario(`structured-cancellation-during-${phase}`, {
    setup({ ctx }) {
      if (phase === 'admission') ctx.on('session/flush', async () => { if (++flushes === 1) { waiting.resolve(); await release.promise } })
    },
    async *stream() {
      yield delta(JSON.stringify({ code: "from __dsh__.tools import probe\nimport asyncio\nawait probe(value='before-cancel')\nawait asyncio.sleep(30)\n", description: 'Handle structured cancellation' }))
      yield finish()
    },
  }, async ({ host, effects, observed }) => {
    const running = host.run({ signal: AbortSignal.timeout(15000) })
    try {
      if (phase === 'admission') await waiting.promise
      else {
        await observed('before-cancel')
        await pause(20)
        assert.ok(host.events.some(event => event.type === 'assistant/message'), 'the final call must already be committed')
      }
      host.agent.cancel({ kind: 'user' })
      release.resolve()
      assert.equal((await running).kind, 'aborted')
      const notice = host.events.findLast(event => event.type === 'user/message' && event.data.source.kind === 'python-stream' && event.data.source.phase === 'result')
      const result = host.events.findLast(event => event.type === 'tool/result')
      assert.doesNotMatch(JSON.stringify([notice, result]), /\[object Object\]/)
      if (phase === 'admission') {
        assert.deepEqual(effects, [])
        assert.match(notice.data.source.outcome, /InterruptedError:.*cancelled.*Earlier effects remain/)
      } else {
        assert.deepEqual(effects.map(({ value }) => value), ['before-cancel'])
        assert.equal(result.data.message.isError, true)
        assert.match(JSON.stringify(result.data.message.content), /InterruptedError:.*cancelled.*Earlier effects remain/)
        assert.match(notice.data.source.outcome, /aborted/)
      }
    } finally { release.resolve() }
  })
}

await scenario('stream-admission-denial-never-falls-back', {
  setup({ ctx }) { ctx.tools.guard(exec => exec.name === 'python_stream' ? 'stream admission denied' : undefined) },
  async *stream() {
    yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='never')\n"))
    await pause(30)
    yield delta('","description":"Denied source"}')
    yield finish()
  },
}, async ({ host, effects, dispatches }) => {
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects, [])
  assert.match(JSON.stringify(host.events), /stream admission denied/)
  assert.equal(dispatches.filter(({ name }) => name === 'python_stream').length, 1)
  assert.equal(host.events.filter(event => event.type === 'tool/result').length, 1)
})

let retryEffect, retryCalls = 0
await scenario('admitted-provider-error-vetoes-retry', {
  setup({ ctx }) { ctx.on('agent/request-error', () => { retryCalls++; return { kind: 'retry' } }) },
  async *stream() {
    yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='retained')\n"))
    await retryEffect('retained')
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'fixture-error', message: 'admitted provider error' } } }
  },
}, async ({ host, effects, observed }) => {
  retryEffect = observed
  await assert.rejects(host.run({ signal: AbortSignal.timeout(15000) }), /admitted provider error/)
  assert.equal(host.requests, 1)
  assert.equal(retryCalls, 0)
  assert.deepEqual(effects.map(({ value }) => value), ['retained'])
})

let contextEffect
await scenario('open-context-unwinds-on-provider-disconnect', {
  async *stream(_request, attempt) {
    if (attempt === 1) {
      const code = "from __dsh__.tools import probe\nfrom contextlib import asynccontextmanager\nlifecycle = []\n@asynccontextmanager\nasync def scope():\n    lifecycle.append('enter')\n    try:\n        yield\n    finally:\n        lifecycle.append('exit')\nasync with scope():\n    await probe(value='inside')\n"
      yield delta('{"code":"' + encode(code))
      await contextEffect('inside')
      throw new Error('disconnect with open context')
    }
    yield delta(JSON.stringify({ code: "await probe(value=','.join(lifecycle))\n", description: 'Observe cleanup after disconnect' }), 'python-2')
    yield finish()
  },
}, async ({ host, effects, observed }) => {
  contextEffect = observed
  await assert.rejects(host.run({ signal: AbortSignal.timeout(15000) }), /disconnect with open context/)
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects.map(({ value }) => value), ['inside', 'enter,exit'])
})

await scenario('nested-turn-completion-survives-final-join', {
  setup({ ctx }) {
    ctx.tools.register(defineTool({ name: 'finish_turn', description: 'Conclude the current turn.', parameters: {},
      output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute(_args, exec) { exec.concludeTurn(); return 42 } }))
  },
  async *stream() {
    yield delta(JSON.stringify({ code: "from __dsh__.tools import finish_turn\nawait finish_turn()\n", description: 'Finish the turn' }))
    yield finish()
  },
}, async ({ host, dispatches }) => {
  const reason = await host.run({ signal: AbortSignal.timeout(15000) })
  assert.equal(reason.kind, 'completed')
  assert.equal(dispatches.filter(({ name }) => name === 'finish_turn').length, 1)
})

for (const mode of ['malformed-final-json', 'final-policy-denial']) {
  let contextSeen
  await scenario(mode, {
    config: { hardInterruptMs: 1000 },
    setup({ ctx }) {
      if (mode === 'final-policy-denial') ctx.tools.guard(exec => exec.name === 'python' && exec.callId === 'python-1' ? 'final Python policy denied' : undefined)
    },
    async *stream(request, attempt) {
      if (attempt === 1) {
        const code = "from __dsh__.tools import probe\nfrom contextlib import asynccontextmanager\nimport asyncio\nlifecycle = []\n@asynccontextmanager\nasync def guarded_scope():\n    lifecycle.append('enter')\n    try:\n        yield\n    finally:\n        await asyncio.sleep(0.03)\n        lifecycle.append('exit')\nasync with guarded_scope():\n    await probe(value='inside')\n    await asyncio.sleep(10)\n"
        yield delta('{"code":"' + encode(code))
        await contextSeen('inside')
        if (mode === 'final-policy-denial') yield delta('","description":"Deny final dispatch"}')
        yield finish()
      } else {
        assert.match(JSON.stringify(request), /Python streaming recovery/)
        yield delta(JSON.stringify({ code: "await probe(value=','.join(lifecycle))\n", description: 'Inspect completed cleanup' }), 'python-2')
        yield finish()
      }
    },
  }, async ({ host, effects, observed }) => {
    contextSeen = observed
    const first = host.run({ signal: AbortSignal.timeout(15000) })
    if (mode === 'malformed-final-json') await assert.rejects(first)
    else await first
    await host.run({ signal: AbortSignal.timeout(15000) })
    assert.deepEqual(effects.map(({ value }) => value), ['inside', 'enter,exit'])
  })
}

await scenario('missing-persistence-refuses-early-effects', {
  persistence: false,
  async *stream() {
    yield delta(JSON.stringify({ code: "from __dsh__.tools import probe\nawait probe(value='never')\n", description: 'Require durable admission' }))
    await pause(20)
    yield finish()
  },
}, async ({ host, effects }) => {
  await assert.rejects(host.run({ signal: AbortSignal.timeout(15000) }), /requires session persistence/)
  assert.deepEqual(effects, [])
})

let recoveryFlushes = 0
await scenario('persistence-failure-does-not-poison-next-turn', {
  setup({ ctx }) { ctx.on('session/flush', () => { if (++recoveryFlushes <= 2) throw new Error(`temporary persistence failure ${recoveryFlushes}`) }) },
  async *stream(_request, attempt) {
    yield delta(JSON.stringify({ code: `from __dsh__.tools import probe\nawait probe(value='turn-${attempt}')\n`, description: 'Recover after persistence returns' }), `python-${attempt}`)
    yield finish()
  },
}, async ({ host, effects }) => {
  await host.run({ signal: AbortSignal.timeout(15000) })
  const failed = host.events.findLast(event => event.type === 'tool/result').data.message
  assert.equal(failed.isError, true)
  assert.match(JSON.stringify(failed.content), /temporary persistence failure 2/)
  assert.deepEqual(effects, [], 'failed admission must not execute source')
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.equal(host.requests, 2)
  assert.deepEqual(effects.map(({ value }) => value), ['turn-2'])
  assert.equal(host.events.findLast(event => event.type === 'tool/result').data.message.isError, false)
  assert.ok(recoveryFlushes >= 4)
})

for (const failures of [[2], [2, 3]]) {
  let flushes = 0, attachments = 0
  const marker = 'Accepted context survives storage failure'
  await scenario(`accepted-context-survives-${failures.length}-result-flush-failures`, {
    setup({ ctx }) {
      ctx.on('session/flush', () => { if (failures.includes(++flushes)) throw new Error(`storage failed ${flushes}`) })
      ctx.tools.register(defineTool({ name: 'attach_context', description: 'Attach accepted context.', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute(_args, exec) {
          attachments++
          exec.deferContext(createUserMessage({ source: { kind: 'streaming-test' }, content: [{ type: 'text', text: marker }] }))
          return 'attached'
        } }))
    },
    async *stream() {
      yield delta(JSON.stringify({ code: "from __dsh__.tools import probe, attach_context\nawait probe(value='once')\nawait attach_context()\n", description: 'Preserve accepted context on failure' }))
      yield finish()
    },
  }, async ({ host, effects }) => {
    await host.run({ signal: AbortSignal.timeout(15000) })
    assert.deepEqual(effects.map(({ value }) => value), ['once'])
    assert.equal(attachments, 1)
    const inserted = host.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted ?? [])
    assert.equal(inserted.filter(message => JSON.stringify(message).includes(marker)).length, 1)
    const result = host.events.findLast(event => event.type === 'tool/result').data.message
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /storage failed/)
  })
}

await scenario('accepted-content-survives-final-join', {
  setup({ ctx }) {
    ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'python_stream' ? { kind: 'accept', content: [{ type: 'text', text: 'REDACTED' }] } : next())
  },
  async *stream() {
    yield delta(JSON.stringify({ code: "print('private-output-marker')\n", description: 'Check result projection' }))
    yield finish()
  },
}, async ({ host }) => {
  await host.run({ signal: AbortSignal.timeout(15000) })
  const result = host.events.find(event => event.type === 'tool/result')
  const ledger = host.events.find(event => event.type === 'user/message' && event.data.source.kind === 'python-stream' && event.data.source.phase === 'result')
  assert.match(JSON.stringify(result), /REDACTED/)
  assert.doesNotMatch(JSON.stringify([result, ledger]), /private-output-marker/)
  assert.equal(ledger.data.source.outcome, 'REDACTED')
})

let duplicate
await scenario('later-request-may-reuse-provider-call-id', {
  setup({ ctx }) {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name === 'python' && !result.isError && duplicate === undefined) {
        duplicate = null
        duplicate = await ctx.tools.execute({ agent: exec.agent, signal: exec.signal, toolSet: exec.toolSet, calls: [{ type: 'tool-call', id: exec.callId, name: 'python',
          arguments: JSON.stringify({ code: "await probe(value='duplicate')\n", description: 'Refuse repeated dispatch in the same invocation' }) }] })
      }
      return next()
    })
  },
  async *stream(_request, attempt) {
    yield delta(JSON.stringify({ code: `from __dsh__.tools import probe\nawait probe(value='${attempt === 1 ? 'once' : 'next'}')\n`, description: 'Check call identity' }))
    yield finish()
  },
}, async ({ host, effects }) => {
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.equal(duplicate.results[0].result.isError, true)
  assert.match(JSON.stringify(duplicate.results[0].result), /already consumed|refusing replay/)
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects.map(({ value }) => value), ['once', 'next'])
})

let admissionEffect, admissionEffects
const durableAdmission = Promise.withResolvers()
let flushes = 0
await scenario('effects-wait-for-admission-flush', {
  setup({ ctx }) { ctx.on('session/flush', async () => { if (++flushes === 1) await durableAdmission.promise }) },
  async *stream() {
    yield delta('{"code":"' + encode("from __dsh__.tools import probe\nawait probe(value='after-flush')\n"))
    await pause(40)
    assert.deepEqual(admissionEffects, [])
    assert.equal(flushes, 1)
    durableAdmission.resolve()
    await admissionEffect('after-flush')
    yield delta('","description":"Wait for durable admission"}')
    yield finish()
  },
}, async ({ host, effects, observed }) => {
  admissionEffect = observed; admissionEffects = effects
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(effects.map(({ value }) => value), ['after-flush'])
  assert.ok(flushes >= 2)
})
await scenario('complete-call-preserves-raw-python', {
  async *stream() { throw new Error('Programmatic Python must not invoke the model') },
}, async ({ host, effects }) => {
  const execute = async (code, id) => (await host.ctx.tools.execute({ agent: host.agent, signal: AbortSignal.timeout(15000),
    calls: [{ type: 'tool-call', id, name: 'python', arguments: JSON.stringify({ code, description: 'Check raw Python fallback' }) }] })).results[0].result
  const result = await execute("from __dsh__.tools import probe\nawait probe(value='once')\n42", 'complete-1')
  assert.notEqual(result.isError, true)
  assert.deepEqual(effects.map(({ value }) => value), ['once'])
  assert.doesNotMatch(JSON.stringify(result), /<return>|Out\[/, 'raw Python must not echo the last expression')
  const magic = await execute('%pwd', 'complete-2')
  assert.match(JSON.stringify(magic), /SyntaxError/, 'IPython magics must stay disabled without a live source admission')
  assert.equal(host.requests, 0)
})

await assert.rejects(createHost({ config: { mode: 'both' } }), /requires mode: code/)

if (process.env.STREAMING_REPORT) await writeFile(process.env.STREAMING_REPORT, JSON.stringify(reports, null, 2) + '\n')
console.log(`${reports.length} real DSH host scenarios passed`)
