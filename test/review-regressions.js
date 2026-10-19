import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../lib/index.js'
import { KERNEL_PY, PythonKernel } from '../lib/kernel.js'

const host = new Context(), subprocess = new LocalSubprocess(host)
function fixture(execute, waterfall) {
  const listeners = new Map(), logs = []
  let python
  const session = { id: 'review-session', header: { version: 4, cwd: process.cwd() }, append: (type, data) => logs.push({ type, data }), deriveMessages: () => [] }
  const agent = { id: session.id, session }
  apply({ subprocess, waterfall, on: (name, fn) => listeners.set(name, fn), effect: (fn) => fn(), systemPrompt: { section() {} },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) },
    tools: { register: (tool) => { python = tool }, sdkSchemas: () => [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } }, output: { type: 'string' } }], execute },
  }, { mode: 'both' })
  return { listeners, logs, session, run: (code) => python.execute({ code, description: 'Review regression' }, { agent, callId: 'review-cell', rootCallId: 'review-cell', token: {}, signal: AbortSignal.timeout(30000), deferContext() {} }) }
}

try {
  const progress = new EventEmitter(), gate = Promise.withResolvers()
  const reply = once(progress, 'reply', { signal: AbortSignal.timeout(30000) })
  const slowLog = fixture(async (call) => {
    if (call.arguments.file_path === 'reply') progress.emit('reply')
    return { isError: false, value: 'full result', content: [{ type: 'text', text: 'full result' }] }
  }, async (_scope, _event, _dispatch, next) => { await gate.promise; return next() })
  let finished = false
  const flight = slowLog.run('from __dsh__.tools import read\nawait read(file_path="first")\nawait read(file_path="reply")').then((value) => { finished = true; return value })
  try {
    await reply
    assert.equal(finished, false, 'the Python reply advances while durable logging is blocked')
    gate.resolve()
    assert.match(await flight, /full result/)
    assert.equal(slowLog.logs.filter((event) => event.type === 'tool/ptc-dispatch').length, 2, 'all logs settle before the cell closes')
  } finally { gate.resolve(); await slowLog.listeners.get('dispose')() }
  console.log('  ok   slow log hooks do not block Python replies and are drained before cell completion')

  const approval = new EventEmitter(), settle = Promise.withResolvers()
  const started = once(approval, 'started', { signal: AbortSignal.timeout(30000) })
  let callSignal
  const pending = fixture((call) => new Promise((_resolve, reject) => {
    callSignal = call.signal
    call.signal.addEventListener('abort', () => { settle.promise.then(() => reject(new Error('approval cancelled'))) }, { once: true })
    approval.emit('started')
  }))
  const cell = pending.run('from __dsh__.tools import read\nawait read(file_path="waiting")')
  try {
    await started
    let retired = false
    const closing = pending.listeners.get('session/event')(pending.session, { type: 'sandbox/mode' }).then(() => { retired = true })
    assert.equal(callSignal.aborted, true, 'policy changes immediately cancel bridged approvals')
    assert.equal(retired, false, 'retirement joins still-settling dispatches')
    settle.resolve()
    await Promise.all([closing, cell])
    assert.equal(pending.logs.at(-1).data.isError, true)
  } finally { settle.resolve(); await pending.listeners.get('dispose')() }
  console.log('  ok   policy retirement aborts active cells and joins their dispatch settlement')

  for (const operation of ['terminate', 'waitForExit']) {
    let grace
    const kernel = new PythonKernel({ command: ['not-executed'], subprocess: { spawn: (spec) => {
      grace = spec.graceMs
      return { stdout: new PassThrough(), stderr: new PassThrough(), control: new PassThrough(), done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => { if (operation === 'terminate') throw new Error('termination failed') },
        waitForExit: async () => { throw new Error('range observation failed') },
      }
    } } })
    await assert.rejects(kernel.start([]), /termination failed|range observation failed/)
    await kernel.dispose()
    assert.equal(grace, 1, 'hard termination does not add another user-visible grace period')
  }
  console.log('  ok   provider teardown failures settle startup and close without hanging')

  async function checkEnvironment(options) {
    const kernel = new PythonKernel(options)
    try {
      await kernel.start([])
      assert.equal(kernel.pythonEnv.disposable, false, 'a temporary profile does not make interpreter installs disposable')
      return kernel.pythonEnv.executable
    }
    finally { await kernel.dispose() }
  }
  // Resolve through the same scrubbed environment as the kernel; CI may set UV_CACHE_DIR only in the ambient environment.
  const interpreter = await checkEnvironment({ ephemeralEnv: false })
  await checkEnvironment({ command: [interpreter, KERNEL_PY] })
  console.log('  ok   configured and non-ephemeral interpreter environments are reported accurately')
} finally { await host.fiber.dispose() }
