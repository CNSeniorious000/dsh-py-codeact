import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashArguments, hashDecodedArguments, installRecovery, recordSource } from '../lib/streaming-recovery.js'

const identity = { streamId: 'stream-1', callId: 'python-1', turn: 1, step: 1 }
// DSH 0.2.2-rc.2+ wraps the string denial returned by earlier hosts.
const guardReason = (denial) => typeof denial === 'string' ? denial : denial?.reason
const latestRecord = session => session.snapshotEvents().findLast(event => event.type === 'developer/message' && event.data.message.source.kind === 'python-stream').data.message
const notices = new WeakMap()
const record = (session, phase, data = {}) => {
  let owned = notices.get(session)
  if (!owned) notices.set(session, owned = new Map())
  const source = { ...identity, ...data }, seq = recordSource(session, phase, source, owned.get(source.streamId))
  owned.set(source.streamId, seq)
  return seq
}
async function environment(options) {
  const ctx = new Context()
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolsService(ctx)
  ctx.tools.setExecutor({ describe: () => ({ schemas: [] }), execute: () => { throw new Error('This recovery fixture does not execute tools') } })
  return { ctx, recovery: await installRecovery(ctx, options), async close() { await ctx.fiber.dispose() } }
}

test('restored admission reports unknown outcome and denies exact-call replay', async () => {
  let owner
  const env = await environment({ ownsCall: (agent, callId) => agent === owner && callId === identity.callId })
  try {
    const session = env.ctx.sessions.create('original', { meta: { cwd: process.cwd() } })
    owner = { session }
    record(session, 'start')
    assert.equal(env.recovery.context(session, owner), '')
    assert.equal(env.ctx.tools.checkGuards({ agent: owner, callId: identity.callId }), undefined)
    const restored = Session.create('restored', session.snapshotEvents(), { ...session.header, id: 'restored' })
    assert.ok((env.recovery.context(restored)).includes('execution outcome unknown'))
    assert.ok((env.recovery.context(restored)).includes('TOOL_NOT_STARTED'))
    assert.match(guardReason(env.ctx.tools.checkGuards({ agent: { session: restored }, callId: identity.callId })), /cannot be replayed/)
    assert.equal(env.ctx.tools.checkGuards({ agent: { session: restored }, callId: 'new-call' }), undefined)
    assert.ok((env.recovery.context(restored)).includes('execution outcome unknown'))
  } finally { await env.close() }
})

test('remounting the plugin on the same live session refuses ownerless admission', async () => {
  const env = await environment({ ownsCall: () => true })
  const remounted = await environment()
  try {
    const session = env.ctx.sessions.create('remounted', { meta: { cwd: process.cwd() } })
    const agent = { session }
    record(session, 'start')
    assert.equal(session.firstLiveSeq, 0)
    assert.equal(env.ctx.tools.checkGuards({ agent, callId: identity.callId }), undefined)
    assert.equal(env.recovery.context(session, agent), '')
    assert.match(guardReason(remounted.ctx.tools.checkGuards({ agent, callId: identity.callId })), /cannot be replayed/)
    assert.ok((remounted.recovery.context(session, agent)).includes('execution outcome unknown'))
    assert.equal(remounted.ctx.tools.checkGuards({ agent, callId: 'new-call' }), undefined)
  } finally { await env.close(); await remounted.close() }
})

test('later turns can reuse provider identities without settling an earlier unknown invocation', async () => {
  const env = await environment({ positionOf: (agent) => agent.position })
  try {
    const session = env.ctx.sessions.create('reused', { meta: { cwd: process.cwd() } })
    const agent = { session, position: { turn: 1, step: 1 } }
    const streamId = (turn) => JSON.stringify([session.id, turn, 1, 'attempt-1', identity.callId])
    record(session, 'start', { streamId: streamId(1) })
    assert.match(guardReason(env.ctx.tools.checkGuards({ agent, callId: identity.callId })), /cannot be replayed/)
    agent.position = { turn: 2, step: 1 }
    assert.equal(env.ctx.tools.checkGuards({ agent, callId: identity.callId }), undefined)
    record(session, 'start', { streamId: streamId(2), turn: 2 })
    assert.equal(env.recovery.stateOf(session).length, 2)
    session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId: identity.callId, isError: false, content: [{ type: 'text', text: 'New invocation completed' }] }) }, { surfaceOp: 'append' })
    assert.deepEqual(env.recovery.stateOf(session), [{ ...identity, streamId: streamId(1) }])
    assert.match(env.recovery.context(session), /Turn 1, step 1.*execution outcome unknown/)
  } finally { await env.close() }
})

test('failed source remains model-visible after generic recovery and final errors', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('failure', { meta: { cwd: process.cwd() } })
    record(session, 'start')
    record(session, 'result', { error: 'Connection lost after an effect' })
    assert.ok((env.recovery.context(session)).includes('Connection lost after an effect'))
    const assembly = await env.ctx.systemPrompt.assemble({ agent: { session } })
    assert.equal(assembly.contexts.some((item) => item.name === 'python-stream-recovery'), true)
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: identity.callId, isError: true, content: [{ type: 'text', text: 'Generic recovery says not started' }] }),
      error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }, { surfaceOp: 'append' })
    assert.ok((env.recovery.context(session)).includes('Connection lost after an effect'))
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: identity.callId, isError: true, content: [{ type: 'text', text: 'Connection lost after an effect' }] }) }, { surfaceOp: 'append' })
    assert.ok((env.recovery.context(session)).includes('Connection lost after an effect'))
  } finally { await env.close() }
})

test('final policy denial preserves earlier effects until a successful result is visible', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('denial', { meta: { cwd: process.cwd() } })
    record(session, 'start')
    record(session, 'result', { result: { isError: false, content: [{ type: 'text', text: 'Effect completed before source EOF' }] } })
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: identity.callId, isError: true, content: [{ type: 'text', text: 'Final Python call denied by policy' }] }),
      error: { name: 'ToolDeniedError', code: 'DENIED' } }, { surfaceOp: 'append' })
    assert.ok((env.recovery.context(session)).includes('Effect completed before source EOF'))
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId: identity.callId, isError: false, content: [{ type: 'text', text: 'Effect completed before source EOF' }] }) }, { surfaceOp: 'append' })
    assert.equal(env.recovery.context(session), '')
  } finally { await env.close() }
})

test('settlement projection exposes the authoritative complete assistant call', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('assistant', { meta: { cwd: process.cwd() } })
    assert.equal(env.recovery.lastAssistant(session), null)
    const message = createAssistantMessage({ source: { provider: 'fixture', model: 'controlled' },
      content: [{ type: 'tool-call', id: 'python-1', name: 'python', arguments: '{"code":"print(42)","description":"Print a value"}' }] })
    const event = session.append('assistant/message', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    assert.deepEqual(env.recovery.lastAssistant(session), { seq: event.seq, type: event.type, interrupted: false, count: 1, call: { id: 'python-1', name: 'python', hash: hashArguments(message.content[0].arguments) } })
  } finally { await env.close() }
})

test('session flush persists admission before restart without a result', async () => {
  const env = await environment()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-stream-recovery-'))
  try {
    const session = env.ctx.sessions.create('persisted', { meta: { cwd: process.cwd() } })
    const path = join(directory, 'session.json')
    let persisted = false
    env.ctx.on('session/flush', async (current) => {
      const file = await open(path, 'w')
      try { await file.writeFile(JSON.stringify({ header: current.header, events: current.snapshotEvents() })); await file.sync(); persisted = true }
      finally { await file.close() }
    })
    record(session, 'start')
    assert.equal(persisted, false)
    assert.equal(await env.ctx.sessions.flush(session), true)
    assert.equal(persisted, true)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    const restored = Session.create(saved.header.id, saved.events, saved.header)
    const second = await environment()
    try {
      assert.ok((second.recovery.context(restored)).includes('execution outcome unknown'))
      assert.match(guardReason(second.ctx.tools.checkGuards({ agent: { session: restored }, callId: identity.callId })), /cannot be replayed/)
    } finally { await second.close() }
  } finally { await env.close(); await rm(directory, { recursive: true, force: true }) }
})


test('recovery evidence survives fork and restore without adding chat or model messages', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('native-notices', { meta: { cwd: process.cwd() } })
    const start = record(session, 'start')
    const admission = latestRecord(session)
    assert.deepEqual(session.deriveMessages(), [])
    assert.equal(admission.source.phase, 'start')
    const result = record(session, 'result', { result: { content: [{ type: 'text', text: 'Accepted visible output' }], value: 'private canonical result' } })
    assert.deepEqual(session.deriveMessages(), [])
    assert.equal(latestRecord(session).source.phase, 'result')
    assert.match(latestRecord(session).source.output, /Accepted visible output/)
    assert.doesNotMatch(JSON.stringify(session.snapshotEvents()), /private canonical result/)
    assert.deepEqual(session.eventAt(result).sourceEventSeqs, [start])
    const fork = env.ctx.sessions.fork(session, start, 'before-settlement')
    assert.match(env.recovery.context(fork), /execution outcome unknown/)
    assert.equal(latestRecord(fork).source.phase, 'start')
    const restored = Session.create('restored-notices', session.snapshotEvents(), { ...session.header, id: 'restored-notices' })
    assert.match(env.recovery.context(restored), /Accepted visible output/)
    assert.deepEqual(restored.deriveMessages(), [])
  } finally { await env.close() }
})

test('recovery metadata stays bounded while persisted notices retain the full output', async () => {
  const env = await environment()
  try {
    for (const offset of [3998, 3999, 4000]) for (const failure of [false, true]) {
      const session = env.ctx.sessions.create(`unicode-${offset}-${failure}`, { meta: { cwd: process.cwd() } })
      const text = 'x'.repeat(offset) + '😀tail', expected = 'x'.repeat(offset) + (offset === 3998 ? '😀' : '')
      record(session, 'start')
      record(session, 'result', failure ? { error: text } : { result: { content: [{ type: 'text', text }] } })
      const saved = JSON.parse(JSON.stringify({ header: session.header, events: session.snapshotEvents() }))
      const restored = Session.create(saved.header.id, saved.events, saved.header)
      const notice = latestRecord(restored)
      assert.equal(notice.source.outcome.isWellFormed(), true, 'truncation must not create an unpaired surrogate')
      assert.equal(notice.source.outcome, expected)
      assert.ok(notice.source.output.endsWith(text), 'history must retain output beyond the recovery metadata limit')
      assert.equal(Buffer.from(notice.source.output, 'utf8').toString('utf8'), notice.source.output)
    }
  } finally { await env.close() }
})

test('restored recovery distinguishes empty output, failed output and an absent result', async () => {
  const env = await environment()
  try {
    const completed = 'Execution completed without textual output.', failed = 'Execution failed without textual output.', missing = 'Execution settled without a recorded result'
    const cases = [
      [{ result: { isError: false, content: [] } }, completed],
      [{ result: { isError: false, content: [{ type: 'text', text: '' }] } }, completed],
      [{ result: { isError: false, content: [{ type: 'image', attachment: { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }] } }, completed],
      [{ result: { isError: true, content: [] } }, failed],
      [{}, missing],
      [{ error: '' }, failed],
    ]
    for (const [index, [data, expected]] of cases.entries()) {
      const session = env.ctx.sessions.create(`empty-output-${index}`, { meta: { cwd: process.cwd() } })
      record(session, 'start')
      record(session, 'result', data)
      const saved = JSON.parse(JSON.stringify({ header: session.header, events: session.snapshotEvents() }))
      const restored = Session.create(saved.header.id, saved.events, saved.header)
      const notice = latestRecord(restored)
      assert.equal(notice.source.outcome, expected)
      assert.ok(notice.source.output.endsWith(expected))
      assert.ok(env.recovery.context(restored).endsWith(expected))
    }
  } finally { await env.close() }
})

test('authoritative Python arguments compare decoded values while rejecting ambiguous JSON', () => {
  const expected = hashDecodedArguments({ code: 'print("你好")\n', description: 'Print' })
  assert.equal(hashArguments('{ "description": "Print", "code": "print(\\"你好\\")\\n" }'), expected)
  assert.equal(hashArguments('{"code":"first","code":"second","description":"Print"}'), null)
  assert.equal(hashArguments('{"code":"first","description":"Print","extra":true}'), null)
  assert.equal(hashArguments('{"code":"first","description":"Print"} trailing'), null)
})


test('successful calls leave only the ordinary result and no recovery context after restore', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('normal', { meta: { cwd: process.cwd() } })
    record(session, 'start')
    record(session, 'result', { result: { isError: false, content: [{ type: 'text', text: '42' }] } })
    const message = createToolResultMessage({ callId: identity.callId, isError: false, content: [{ type: 'text', text: '42' }] })
    session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    const restored = Session.create('normal-restored', session.snapshotEvents(), { ...session.header, id: 'normal-restored' })
    for (const current of [session, restored]) {
      assert.deepEqual(current.deriveMessages(), [message])
      assert.equal(env.recovery.context(current), '')
    }
  } finally { await env.close() }
})

test('legacy user notices still prevent replay after upgrade', async () => {
  const env = await environment()
  try {
    const session = env.ctx.sessions.create('legacy', { meta: { cwd: process.cwd() } })
    session.append('user/message', createUserMessage({ source: { kind: 'python-stream', phase: 'start', ...identity }, content: [{ type: 'text', text: 'Legacy admission' }] }), { surfaceOp: 'append' })
    assert.match(env.recovery.context(session), /execution outcome unknown/)
    assert.match(guardReason(env.ctx.tools.checkGuards({ agent: { session }, callId: identity.callId })), /cannot be replayed/)
  } finally { await env.close() }
})
