import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubcallScheduler } from '../lib/subcall-scheduler.js'

test('parallel bodies settle out of order but commit in submission order', async () => {
  const controller = new AbortController(), secondFinished = Promise.withResolvers(), release = Promise.withResolvers()
  const commits = []
  const scheduler = new SubcallScheduler({
    executionMode: () => ({ kind: 'parallel' }),
    prepare: async exec => ({ kind: 'dispatch', exec }),
    async dispatch(exec) { if (exec === 0) await release.promise; else secondFinished.resolve(); return { result: exec } },
    complete: async (exec, outcome) => { commits.push(exec); return outcome.result },
  }, controller.signal)
  const first = scheduler.run(0, () => {}, result => result)
  const second = scheduler.run(1, () => {}, result => result)
  await secondFinished.promise
  assert.deepEqual(commits, [])
  release.resolve()
  assert.deepEqual(await Promise.all([first, second]), [0, 1])
  assert.deepEqual(commits, [0, 1])
  controller.abort()
})

test('queued calls reclassify after registry changes and cancel before starting', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const calls = [], starts = [], replies = []
  let parallel = true
  const pipeline = {
    executionMode: () => ({ kind: parallel ? 'parallel' : 'exclusive' }),
    prepare: async input => ({ kind: 'dispatch', exec: input }),
    async dispatch(input) { calls.push(input); entered.resolve(); await release.promise; return { result: input } },
    complete: async (_exec, outcome) => outcome.result,
  }
  const scheduler = new SubcallScheduler(pipeline, controller.signal, 1)
  const run = id => scheduler.run(id, () => starts.push(id), result => { replies.push(result); return result })
  const first = run(0), second = run(1), third = run(2)
  const settled = Promise.allSettled([first, second, third])
  await entered.promise
  parallel = false
  controller.abort(new Error('cell cancelled'))
  release.resolve()
  const outcomes = await settled
  assert.deepEqual(calls, [0])
  assert.deepEqual(starts, [0])
  assert.deepEqual(replies, [0])
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected', 'rejected'])
  assert.equal(outcomes[1].reason.message, 'cell cancelled')
})

test('a queued call becoming exclusive waits for earlier result commits', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers(), release = Promise.withResolvers()
  const order = []
  let parallel = true
  const pipeline = {
    executionMode: () => ({ kind: parallel ? 'parallel' : 'exclusive' }),
    prepare: async exec => { order.push(`pre:${exec}`); return { kind: 'dispatch', exec } },
    async dispatch(exec) { if (exec === 0) { entered.resolve(); await release.promise }; return { result: exec } },
    complete: async (exec, result) => { order.push(`post:${exec}`); return result },
  }
  const scheduler = new SubcallScheduler(pipeline, controller.signal, 1)
  const first = scheduler.run(0, () => {}, result => result)
  const second = scheduler.run(1, () => {}, result => result)
  await entered.promise
  parallel = false
  release.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['pre:0', 'post:0', 'pre:1', 'post:1'])
  controller.abort()
})

for (const stage of ['prepare', 'dispatch', 'complete']) test(`failed ${stage} releases an exclusive barrier and later calls still settle`, async () => {
  const controller = new AbortController()
  const scheduler = new SubcallScheduler({
    executionMode: () => ({ kind: 'exclusive' }),
    prepare: async exec => { if (exec === 0 && stage === 'prepare') throw new Error('stage failed'); return { kind: 'dispatch', exec } },
    dispatch: async exec => { if (exec === 0 && stage === 'dispatch') throw new Error('stage failed'); return { result: exec } },
    complete: async (exec, outcome) => { if (exec === 0 && stage === 'complete') throw new Error('stage failed'); return outcome.result },
  }, controller.signal)
  const results = await Promise.allSettled([0, 1].map(id => scheduler.run(id, () => {}, result => result)))
  assert.equal(results[0].reason.message, 'stage failed')
  assert.deepEqual(results[1], { status: 'fulfilled', value: 1 })
  controller.abort()
})

test('a completed parallel call can submit more work while its sibling is running', { timeout: 3000 }, async () => {
  const controller = new AbortController(), started = Promise.withResolvers(), thirdStarted = Promise.withResolvers(), release = Promise.withResolvers()
  const scheduler = new SubcallScheduler({
    executionMode: () => ({ kind: 'parallel' }),
    prepare: async exec => ({ kind: 'dispatch', exec }),
    async dispatch(exec) { if (exec === 1) { started.resolve(); await release.promise }; return { result: exec } },
    complete: async (_exec, outcome) => outcome.result,
  }, controller.signal, 2)
  const run = id => scheduler.run(id, () => { if (id === 2) thirdStarted.resolve() }, result => result)
  const first = run(0), second = run(1)
  await started.promise
  await first
  const third = run(2)
  await thirdStarted.promise
  release.resolve()
  assert.deepEqual(await Promise.all([second, third]), [1, 2])
  controller.abort()
})

test('slow logging applies backpressure after delivering completed results', async () => {
  const controller = new AbortController(), logged = Promise.withResolvers(), starts = []
  const scheduler = new SubcallScheduler({
    executionMode: () => ({ kind: 'exclusive' }),
    prepare: async exec => ({ kind: 'dispatch', exec }),
    dispatch: async exec => ({ result: exec }),
    complete: async (_exec, outcome) => outcome.result,
  }, controller.signal, 1)
  const run = id => scheduler.run(id, () => starts.push(id), result => { scheduler.trackLog(logged.promise); return result })
  const first = run(0), second = run(1), third = run(2)
  await Promise.all([first, second])
  assert.deepEqual(starts, [0, 1])
  logged.resolve()
  await third
  controller.abort()
})
