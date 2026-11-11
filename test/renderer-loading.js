import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as tools from '@deepseek-ai/dsh-tools'

// Intercept only the optional renderer's resolution, so both real host package sets exercise their actual import branch.
const load = (missing) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { registerHooks } from 'node:module'
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tool-executor-ptc') throw Object.assign(new Error("Cannot find package '${missing}' imported from renderer"), { code: 'ERR_MODULE_NOT_FOUND' })
    return next(specifier, context)
  } })
  await import('./lib/index.js')
`], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
const absent = load('@deepseek-ai/dsh-tool-executor-ptc')
if (tools.renderToolsSdkPy) {
  assert.equal(absent.status, 0, absent.stderr)
  console.log('  ok   legacy host loads without the new renderer')
} else {
  assert.equal(absent.status, 1, absent.stderr)
  assert.match(absent.stderr, /this host requires @deepseek-ai\/dsh-tool-executor-ptc/)
  assert.match(absent.stderr, /dsh plugin --profile <name> add/)
  const broken = load('broken-transitive-dependency')
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /Cannot find package 'broken-transitive-dependency'/)
  assert.doesNotMatch(broken.stderr, /this host requires/)
  console.log('  ok   missing renderer has installation guidance; other import errors are preserved')
}
