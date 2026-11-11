import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const group = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8').match(/^  group: (.+)$/m)[1]
// This expression uses the shared JS/GitHub subset of property access, comparisons, and boolean operators.
const concurrencyGroup = (event_name, run_id, sender = 'User') => group.replace(/\$\{\{ (.+?) \}\}/g, (_match, expression) => String(runInNewContext(expression, {
  github: { event_name, run_id, ref: 'refs/heads/main', event: { pull_request: { number: 106 }, issue: { number: 106 }, sender: { type: sender } } },
  format: (template, value) => template.replace('{0}', value),
})))

test('lifecycle reviews for the same PR keep their coalescing group', () => {
  assert.equal(concurrencyGroup('pull_request_target', 1), concurrencyGroup('pull_request_target', 2))
  assert.equal(concurrencyGroup('pull_request_target', 1, 'Bot'), concurrencyGroup('pull_request_target', 2))
  assert.equal(concurrencyGroup('push', 1), concurrencyGroup('push', 2))
})

test('comment and review runs cannot replace lifecycle or other interactive reviews', () => {
  for (const event of ['issue_comment', 'pull_request_review', 'pull_request_review_comment', 'workflow_dispatch']) {
    for (const sender of ['User', 'Bot']) {
      assert.notEqual(concurrencyGroup(event, 1, sender), concurrencyGroup('pull_request_target', 2))
      assert.notEqual(concurrencyGroup(event, 1, sender), concurrencyGroup(event, 2, sender))
    }
  }
})
