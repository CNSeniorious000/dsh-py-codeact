import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

// Exercise the plugin's bridge, not only PythonKernel.onCall: session-format tags are written here.
// Format 4 is the 0.1.7+ line: same dispatch tags as v3, but the plugin-wrapper source is
// retired there, so the injected message must carry the producer-owned kind.
for (const [version, eventType] of [[undefined, 'tool/code-dispatch'], [2, 'tool/code-dispatch'], [3, 'tool/ptc-dispatch'], [4, 'tool/ptc-dispatch']]) {
  const events = [], listeners = new Map(), calls = []
  let python, outcome = 'success'
  const history = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'previous-cell', name: 'python', arguments: '{}' }] },
  ]
  const injected = []
  const session = {
    header: { version, cwd: process.cwd() },
    append: (type, data) => events.push({ type, data }),
    deriveMessages: () => history,
  }
  const agent = {
    id: `dispatch-v${version}`,
    session,
    inject: (message) => { injected.push(message) },
  }
  const ctx = {
    on: (name, listener) => listeners.set(name, listener),
    effect: (effect) => effect(),
    systemPrompt: { section() {} },
    tools: {
      register: (tool) => { python = tool },
      sdkSchemas: () => [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, output: { type: 'string' } }],
      execute: async (call) => {
        calls.push(call)
        if (outcome === 'throw') throw new Error('dispatch rejected')
        if (outcome === 'error') return { isError: true, error: { message: 'read failed' }, content: [{ type: 'text', text: 'read failed' }] }
        return { isError: false, value: 'file contents', content: [{ type: 'text', text: 'file contents' }] }
      },
    },
  }
  apply(ctx, { mode: 'both' })
  const parent = {}, signal = AbortSignal.timeout(30000)
  try {
    const created = listeners.get('agent/created')
    assert.ok(created, `format ${version ?? 'legacy'} listens for agent creation`)
    assert.equal(listeners.has('agent/session-start'), false, `format ${version ?? 'legacy'} does not use the removed session-start event`)
    created({ agent })
    assert.equal(injected.length, 1, `format ${version ?? 'legacy'} announces a prior cell after a host restart`)
    // The source literal follows the session format generation: the released wrapper on v2/v3,
    // the producer-owned `plugin:<name>` on v4, where the wrapper would abort the write.
    if (version !== undefined && version >= 4) {
      assert.equal(injected[0].source?.kind, 'plugin:dsh-py-codeact')
      assert.equal(injected[0].source?.plugin, undefined)
    } else {
      assert.equal(injected[0].source?.kind, 'plugin')
      assert.equal(injected[0].source?.plugin, 'dsh-py-codeact')
    }
    assert.equal(injected[0].source?.form, 'notice')

    for (outcome of ['success', 'error', 'throw']) {
      events.length = 0
      const callId = `cell-${outcome}`
      const result = await python.execute({ code: 'from __dsh__.tools import read\nawait read(file_path="README.md")', description: 'Read through the bridge' },
        { callId, rootCallId: callId, token: parent, agent, signal, deferContext() {} })
      assert.match(result, outcome === 'success' ? /file contents/ : outcome === 'error' ? /read failed/ : /dispatch rejected/)
      assert.deepEqual(events.map((event) => event.type), [`${eventType}-start`, eventType], `format ${version}: both dispatch events must be readable`)
      assert.equal(events[1].data.isError, outcome !== 'success')
      assert.equal(events[1].data.subCallId, events[0].data.subCallId)
      assert.equal(events[0].data.parentCallId, callId)
      assert.equal(calls.at(-1).callId, events[0].data.subCallId)
      assert.equal(calls.at(-1).parent, parent)
      assert.equal(calls.at(-1).agent, agent)
      // Sub-calls take the cell's own controller, not the outer execution's signal: that is what lets
      // `execute` cancel a call still parked on an approval the moment the cell settles.
      assert.ok(calls.at(-1).signal instanceof AbortSignal)
      assert.notEqual(calls.at(-1).signal, signal)
      assert.equal(calls.at(-1).signal.aborted, true, 'the cell cancels its sub-calls once it settles')
      console.log(`  ok   format ${version ?? 'legacy'} bridge ${outcome}`)
    }
    created({ agent })
    assert.equal(injected.length, 1, `format ${version ?? 'legacy'} does not announce a live same-process kernel again`)
  } finally {
    listeners.get('dispose')()
  }
}

// A sub-call can still be in flight when its cell settles: the kernel's own per-call timeout gave up on
// a tool parked on an approval, or a cell returned with a detached call outstanding. `execute` cancels
// the cell's controller and then drains, so the call is refused rather than performed, and its settle
// is still written — in the same turn as its `-start`, the only place the v3/v4 reader accepts one.
{
  const events = [], dispatched = [], listeners = new Map()
  let python
  const session = {
    header: { version: 4, cwd: process.cwd() },
    append: (type, data) => events.push({ type, data }),
    deriveMessages: () => [],
  }
  const agent = { id: 'late-settle', session, inject: () => {} }
  const ctx = {
    on: (name, listener) => listeners.set(name, listener),
    effect: (effect) => effect(),
    systemPrompt: { section() {} },
    tools: {
      register: (tool) => { python = tool },
      sdkSchemas: () => [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, output: { type: 'string' } }],
      // A dispatch parked on an approval settles only when its signal aborts. Honour it the way the
      // harness's own pipeline does, so this body is never reached.
      execute: (call) => {
        dispatched.push(call)
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new Error('tool call aborted before dispatch'))
          if (call.signal.aborted) abort()
          else call.signal.addEventListener('abort', abort, { once: true })
        })
      },
    },
  }
  apply(ctx, { mode: 'both' })
  try {
    listeners.get('agent/created')({ agent })
    const callId = 'cell-late'
    const exec = { callId, rootCallId: callId, token: {}, agent, signal: AbortSignal.timeout(30000), deferContext: () => {} }
    await python.execute({ code: 'import asyncio\nfrom __dsh__.tools import read\nasyncio.ensure_future(read(file_path="README.md"))\nawait asyncio.sleep(0.5)', description: 'Detach a call that outlives this cell' }, exec)
    assert.equal(dispatched.length, 1, 'the detached call reached the host while the cell was still alive')
    assert.equal(dispatched[0].signal.aborted, true, 'the settled cell cancelled the call instead of letting it run')
    assert.deepEqual(events.map((event) => event.type), ['tool/ptc-dispatch-start', 'tool/ptc-dispatch'], 'the settle is still logged, in the turn its start opened')
    assert.equal(events[1].data.isError, true)
    assert.match(events[1].data.content[0].text, /aborted before dispatch/, 'and it records the cancellation rather than a run')
    console.log('  ok   a sub-call still in flight when its cell settles is cancelled and still logged')
  } finally {
    listeners.get('dispose')()
  }
}
