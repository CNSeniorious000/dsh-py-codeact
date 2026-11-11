import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
const workflow = readFileSync(new URL('../.github/workflows/code-review.yml', import.meta.url), 'utf8')
const script = workflow.match(/          script: \|\n((?: {12}.+\n)+)/)[1].replace(/^ {12}/gm, '')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const authorize = new AsyncFunction('github', 'context', 'core', script)

async function allowed(eventName, permission) {
  let value, lookups = 0
  const context = { eventName, repo: { owner: 'owner', repo: 'repo' }, payload: { sender: { login: 'sender' } } }
  const github = { rest: { repos: { async getCollaboratorPermissionLevel(input) {
    assert.deepEqual(input, { owner: 'owner', repo: 'repo', username: 'sender' })
    lookups++
    if (permission instanceof Error) throw permission
    return { data: { permission } }
  } } } }
  await authorize(github, context, { setOutput(name, result) { assert.equal(name, 'allowed'); value = result } })
  return { value, lookups }
}

test('automatic reviews do not require a commenter permission lookup', async () => {
  for (const event of ['push', 'pull_request_target', 'workflow_dispatch']) assert.deepEqual(await allowed(event), { value: true, lookups: 0 })
})

test('interactive reviews require the same write permissions as the review action', async () => {
  for (const event of ['issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
    for (const role of ['admin', 'maintain', 'write']) assert.deepEqual(await allowed(event, role), { value: true, lookups: 1 })
    for (const role of ['read', 'triage', 'none']) assert.deepEqual(await allowed(event, role), { value: false, lookups: 1 })
  }
  await assert.rejects(allowed('issue_comment', new Error('permission lookup failed')), /permission lookup failed/)
})

test('only authorized jobs enter the shared per-PR review queue', () => {
  assert.match(workflow, /  review:\n    needs: eligibility\n    if: needs\.eligibility\.outputs\.allowed == 'true'/)
  assert.match(workflow, /    concurrency:\n      group: code-review-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \|\| github\.ref \}\}/)
  assert.doesNotMatch(workflow, /^concurrency:/m, 'workflow-level concurrency would run before authorization')
  assert.doesNotMatch(workflow, /github\.run_id/, 'authorized comments and lifecycle runs must share the same queue')
})
