import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import codeAct, { apply as applyCodeAct } from '../lib/index.js'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import settings, { Config, apply, readStreaming, readToolConcurrency } from '../lib/settings.js'

for (const missing of ['sandboxPolicy', 'subprocess']) test(`execution follows the ${missing} provider lifetime`, async () => {
  const ctx = new Context()
  const provide = (name) => ctx.plugin({ name: `fixture-${name}`, apply(child) { child.provide(name, {}) } })
  let mounted
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await provide(missing === 'subprocess' ? 'sandboxPolicy' : 'subprocess')
    mounted = ctx.plugin(codeAct, { mode: 'both', streaming: false })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(ctx.tools.get('python'), undefined)
    const provider = await provide(missing)
    await mounted
    assert.ok(ctx.tools.get('python'))
    await provider.dispose()
    assert.equal(ctx.tools.get('python'), undefined)
    await provide(missing)
    for (let tries = 0; !ctx.tools.get('python'); tries++) {
      assert.ok(tries < 100, 'execution did not reactivate after provider replacement')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally { await mounted?.dispose(); await ctx.fiber.dispose() }
})

test('streaming settings validate the profile preference and preserve explicit overrides', () => {
  assert.equal(Config({}).streaming.get(), false)
  assert.equal(Config({ streaming: false }).streaming.get(), false)
  assert.equal(Config({ streaming: true }).streaming.get(), true)
  assert.throws(() => Config({ streaming: 'true' }))
})

test('tool concurrency is opt-in and validates the profile preference', () => {
  assert.equal(Config({}).respectToolConcurrency.get(), false)
  assert.equal(Config({ respectToolConcurrency: true }).respectToolConcurrency.get(), true)
  assert.throws(() => Config({ respectToolConcurrency: 'true' }))
  assert.equal(readToolConcurrency({}, {}), false)
})

test('the dedicated settings entry defaults to off and preset overrides require booleans', async () => {
  const ctx = new Context()
  try {
    await assert.rejects(applyCodeAct(ctx, { streaming: 'true' }), /streaming must be a boolean/)
    await assert.rejects(applyCodeAct(ctx, { respectToolConcurrency: 'true' }), /respectToolConcurrency must be a boolean/)
    await ctx.plugin(settings)
    assert.equal(ctx.get('pyCodeActSettings').streaming.get(), false)
    assert.equal(ctx.get('pyCodeActSettings').respectToolConcurrency.get(), false)
  } finally { await ctx.fiber.dispose() }
})

test('preset scopes inherit the profile preference without owning its lifetime', async () => {
  const ctx = new Context()
  try {
    assert.equal(readStreaming(ctx, {}), false)
    const config = { streaming: { get: () => enabled }, respectToolConcurrency: { get: () => enabled } }
    let enabled = true
    const provider = ctx.plugin({ apply(child) { apply(child, config) } })
    await provider
    const preset = createScope(ctx, 'codeact-settings-test')
    await preset.ctx.fiber
    assert.equal(readStreaming(preset.ctx, {}), true)
    assert.equal(readStreaming(preset.ctx, { streaming: false }), false)
    assert.equal(readToolConcurrency(preset.ctx, {}), true)
    assert.equal(readToolConcurrency(preset.ctx, { respectToolConcurrency: false }), false)
    enabled = false
    assert.equal(readStreaming(preset.ctx, {}), false)
    assert.equal(readStreaming(preset.ctx, { streaming: true }), true)
    assert.equal(readToolConcurrency(preset.ctx, {}), false)
    assert.equal(readToolConcurrency(preset.ctx, { respectToolConcurrency: true }), true)
    await preset.dispose()
    assert.ok(ctx.get('pyCodeActSettings'))
    await provider.dispose()
    assert.equal(ctx.get('pyCodeActSettings'), undefined)
  } finally { await ctx.fiber.dispose() }
})
