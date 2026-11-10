import z from '@deepseek-ai/schemastery'

export const name = 'dsh-py-codeact-settings'
// Only the profile preference is live; execution-row overrides must retain their ordinary reload lifecycle.
export const Config = z.object({ streaming: z.boolean().default(false).volatile() })

export function readStreaming(ctx, config) {
  return config.streaming ?? ctx.get('pyCodeActSettings')?.streaming.get() ?? false
}

export function apply(ctx, config) {
  ctx.provide('pyCodeActSettings', config)
  ctx.inject(['settings'], (child) => {
    if (child.settings.configure) child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })
}

export default { name, Config, apply }
