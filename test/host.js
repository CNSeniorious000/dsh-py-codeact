import * as tools from '@deepseek-ai/dsh-tools'

// Single-invocation fixtures model the legacy registry; split-API hosts exercise the real executor.
if (tools.renderToolsSdkPy) {
  await import('./dispatch.js')
  await import('./review-regressions.js')
} else {
  await import('./host-executor.js')
}
