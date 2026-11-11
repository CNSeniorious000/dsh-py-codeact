import z from '@deepseek-ai/schemastery'

export const name = 'dsh-py-codeact-settings'
// Only the profile preference is live; execution-row overrides must retain their ordinary reload lifecycle.
export const Config = z.object({ streaming: z.boolean().default(false).volatile(), respectToolConcurrency: z.boolean().default(false).volatile() })

export function readStreaming(ctx, config) {
  return config.streaming ?? ctx.get('pyCodeActSettings')?.streaming.get() ?? false
}

export function readToolConcurrency(ctx, config) {
  return config.respectToolConcurrency ?? ctx.get?.('pyCodeActSettings')?.respectToolConcurrency?.get() ?? false
}

export function apply(ctx, config) {
  ctx.provide('pyCodeActSettings', config)
  ctx.inject(['settings'], (child) => {
    if (child.settings.configure) child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

export default { name, Config, apply }
