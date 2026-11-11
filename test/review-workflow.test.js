import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8')
const concurrency = workflow.match(/^concurrency:\n((?: {2}.*\n)+)/m)[1]
const group = concurrency.match(/  group: (.+)/)[1]
const queueFor = (event) => group.replace(/\$\{\{ (.+?) \}\}/g, (_match, expression) => runInNewContext(expression, { github: { event, ref: 'refs/heads/main' } }))

test('all activity on one PR shares a serialized review session', () => {
  for (const type of ['User', 'Bot']) {
    assert.equal(queueFor({ pull_request: { number: 107 }, issue: {}, sender: { type } }), 'code-review-107')
    assert.equal(queueFor({ pull_request: {}, issue: { number: 107 }, sender: { type } }), 'code-review-107')
  }
  assert.equal(queueFor({ pull_request: {}, issue: {} }), 'code-review-refs/heads/main')
})

test('later events retain pending work and let the active review finish', () => {
  assert.match(concurrency, /^  queue: max$/m)
  assert.doesNotMatch(concurrency, /cancel-in-progress:/, 'GitHub defaults to keeping the active run')
  assert.doesNotMatch(group, /run_id/, 'bot activity must not fork the same session cache')
  assert.doesNotMatch(workflow, /getCollaboratorPermissionLevel|eligibility:/, 'the action owns permission filtering')
})
