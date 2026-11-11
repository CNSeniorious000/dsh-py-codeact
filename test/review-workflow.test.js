import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8')
const concurrency = workflow.match(/^ {4}concurrency:\n((?: {6}.*\n)+)/m)[1]
const group = concurrency.match(/^ {6}group: (.+)$/m)[1]
const queueFor = (event) => group.replace(/\$\{\{ (.+?) \}\}/g, (_match, expression) => runInNewContext(expression, { github: { event, ref: 'refs/heads/main' } }))

test('all activity on one PR shares a serialized review session', () => {
  for (const type of ['User', 'Bot']) {
    assert.equal(queueFor({ pull_request: { number: 107 }, issue: {}, sender: { type } }), 'code-review-107')
    assert.equal(queueFor({ pull_request: {}, issue: { number: 107 }, sender: { type } }), 'code-review-107')
  }
  assert.equal(queueFor({ pull_request: {}, issue: {} }), 'code-review-refs/heads/main')
})

test('later events retain pending work and let the active review finish', () => {
  assert.match(concurrency, /^ {6}queue: max$/m)
  assert.doesNotMatch(concurrency, /cancel-in-progress:/, 'GitHub defaults to keeping the active run')
  assert.doesNotMatch(group, /run_id/, 'activity that shares a session cache must share one group')
})

test('only activity that can steer a review takes a queue slot', () => {
  // The group holds 100 pending runs and cancels the next one, so a comment flood the action would skip could
  // push a new head's review out of the queue. Authorization therefore gates the run that joins the group.
  assert.doesNotMatch(workflow, /^concurrency:/m, 'the run must not join the group before authorization')
  assert.match(workflow, /^ {2}authorize:$/m)
  assert.match(workflow, /^ {2}review:\n {4}needs: authorize$/m)
  assert.match(workflow, /needs\.authorize\.outputs\.writer == 'true'/)
  assert.match(workflow, /collaborators\/\$SENDER\/permission/)
  assert.match(workflow, /admin\|write\|maintain/)
})
