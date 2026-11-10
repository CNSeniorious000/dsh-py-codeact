import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PythonStreams } from '../lib/python-streams.js'

function fixture() {
  const service = new PythonStreams(), agent = { id: 'agent' }
  service.create('stream', { callId: 'call', agent })
  return { service, agent }
}

describe('Python source handoff', () => {
  test('binds exact stream, call and agent identities', () => {
    const { service, agent } = fixture()
    assert.equal(service.has('stream', 'call', agent), true)
    assert.equal(service.has('missing', 'call', agent), false)
    assert.equal(service.has('stream', 'different', agent), false)
    assert.equal(service.has('stream', 'call', { id: 'agent' }), false)
    assert.throws(() => service.claim('stream', 'different', agent), /identity/)
    assert.throws(() => service.claim('stream', 'call', { id: 'agent' }), /identity/)
    assert.equal(service.claim('stream', 'call', agent), service.get('stream'))
    assert.throws(() => service.claim('stream', 'call', agent), /already claimed/)
    assert.throws(() => service.create('stream', { callId: 'other', agent }), /Duplicate/)
  })

  test('delivers FIFO deltas early and permits EOF only after exact finalization', async () => {
    const { service, agent } = fixture(), source = service.claim('stream', 'call', agent)[Symbol.asyncIterator]()
    const parts = ['{"description":"Run","code":"await first()\\n', 'await second()\\n', 'await last()"}']
    const first = source.next()
    service.append('stream', parts[0])
    assert.deepEqual(await first, { value: 'await first()\n', done: false })
    service.append('stream', parts[1])
    service.append('stream', parts[2])
    assert.deepEqual(await source.next(), { value: 'await second()\n', done: false })
    assert.deepEqual(await source.next(), { value: 'await last()', done: false })
    let settled = false
    const final = source.next().then((value) => { settled = true; return value })
    await Promise.resolve()
    assert.equal(settled, false)
    assert.deepEqual(service.finish('stream', parts.join('')), { code: 'await first()\nawait second()\nawait last()', description: 'Run' })
    assert.deepEqual(await final, { value: undefined, done: true })
    assert.deepEqual(await source.next(), { value: undefined, done: true })
  })

  test('empty and metadata-only deltas neither emit source nor close the stream', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    let settled = false
    const pending = source.next().then((value) => { settled = true; return value })
    service.append('stream', '')
    service.append('stream', '{"description":"Empty","code":""}')
    await Promise.resolve()
    assert.equal(settled, false)
    service.finish('stream', '{"description":"Empty","code":""}')
    assert.deepEqual(await pending, { value: undefined, done: true })
  })

  test('abort takes priority over already queued source, including a wakeup race', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    const error = new Error('provider disconnected'), pending = source.next()
    service.append('stream', '{"code":"never()\\n')
    service.abort('stream', error)
    await assert.rejects(pending, actual => actual === error)
    service.abort('stream', new Error('later failure'))
    await assert.rejects(source.next(), actual => actual === error)
    assert.throws(() => service.append('stream', 'anything'), actual => actual === error)
    assert.throws(() => service.finish('stream', '{}'), actual => actual === error)
  })

  test('abort also discards a finished stream before its queued source is consumed', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    const raw = '{"code":"never()\\n","description":"Run"}', error = new Error('turn cancelled')
    service.append('stream', raw)
    service.finish('stream', raw)
    service.abort('stream', error)
    await assert.rejects(source.next(), actual => actual === error)
  })

  test('only one iterator and one pending next are allowed', async () => {
    const { service } = fixture(), iterable = service.get('stream'), source = iterable[Symbol.asyncIterator]()
    assert.throws(() => iterable[Symbol.asyncIterator](), /already has a reader/)
    const pending = source.next()
    await assert.rejects(source.next(), /Concurrent reads/)
    const error = new Error('stop')
    service.abort('stream', error)
    await assert.rejects(pending, actual => actual === error)
  })

  test('mismatched final arguments abort instead of flushing queued code', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    service.append('stream', '{"code":"never()","description":"Run"}')
    assert.throws(() => service.finish('stream', '{"code":"changed()","description":"Run"}'), /differ/)
    await assert.rejects(source.next(), /differ/)
  })

  test('late malformed arguments abort after any already-delivered prefix', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    service.append('stream', '{"code":"first()\\n')
    assert.equal((await source.next()).value, 'first()\n')
    service.append('stream', 'queued()\\n",')
    assert.throws(() => service.append('stream', '"code":"replacement"}'), /duplicate/)
    await assert.rejects(source.next(), /duplicate/)
  })

  test('consumer return drops queued source and wakes pending next', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    const pending = source.next()
    assert.deepEqual(await source.return(), { value: undefined, done: true })
    assert.deepEqual(await pending, { value: undefined, done: true })
    assert.throws(() => service.append('stream', '{'), /closed/)
  })

  test('delete and service disposal reject pending readers', async () => {
    const { service, agent } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    const pending = source.next()
    assert.equal(service.delete('stream'), true)
    assert.equal(service.delete('stream'), false)
    assert.equal(service.has('stream', 'call', agent), false)
    await assert.rejects(pending, /deleted/)
    assert.throws(() => service.get('stream'), /Unknown/)
    service.create('other', { callId: 'another', agent })
    const other = service.get('other')[Symbol.asyncIterator]().next()
    service.dispose()
    await assert.rejects(other, /deleted/)
  })

  test('raw argument and decoded source caps abort the entire pending stream', async () => {
    const { service } = fixture(), source = service.get('stream')[Symbol.asyncIterator]()
    assert.throws(() => service.append('stream', ' '.repeat(12 * 1024 * 1024 + 1)), /12 MiB/)
    await assert.rejects(source.next(), /12 MiB/)
    const second = fixture(), secondReader = second.service.get('stream')[Symbol.asyncIterator]()
    assert.throws(() => second.service.append('stream', '{"code":"' + 'a'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/)
    await assert.rejects(secondReader.next(), /2 MiB/)
  })
})
