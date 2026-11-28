import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as tools from '@deepseek-ai/dsh-tools'

// The plugin must render its Python SDK without the executor package that used to carry the renderer: a host that
// still exports one supplies it, and every other host falls back to the vendored copy.
const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import { registerHooks } from 'node:module'
  registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-tool-executor-ptc') throw Object.assign(new Error('the plugin must not import the removed renderer'), { code: 'ERR_MODULE_NOT_FOUND' })
    return next(specifier, context)
  } })
  await import('./lib/index.js')
`], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
assert.equal(loaded.status, 0, loaded.stderr)
const { jsonSchemaToPy, renderToolsSdkPy } = await import('../lib/py-types.js')
assert.match(renderToolsSdkPy([]), /class Tools\(Protocol\)/)
assert.equal(jsonSchemaToPy({ type: 'string' }), 'str')
console.log(`  ok   ${tools.renderToolsSdkPy ? 'legacy host renders with its own renderer' : 'host without a renderer uses the vendored Python renderer'}`)
