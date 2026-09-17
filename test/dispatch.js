import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

// Exercise the plugin's bridge, not only PythonKernel.onCall: session-format tags are written here.
for (const [version, eventType] of [[undefined, 'tool/code-dispatch'], [2, 'tool/code-dispatch'], [3, 'tool/ptc-dispatch']]) {
  const events = [], listeners = new Map(), calls = []
  let python, outcome = 'success'
  const session = { header: { version, cwd: process.cwd() }, append: (type, data) => events.push({ type, data }) }
  const agent = { id: `dispatch-v${version}`, session }
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
      assert.equal(calls.at(-1).signal, signal)
      console.log(`  ok   format ${version ?? 'legacy'} bridge ${outcome}`)
    }
  } finally {
    listeners.get('dispose')()
  }
}
