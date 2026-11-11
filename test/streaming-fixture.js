import { Context, Service } from '@deepseek-ai/cordis'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import plugin from '../lib/index.js'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every lifecycle and model step below belongs to the installed, unmodified host.
// A single model step per run keeps lifecycle failures attributable to their originating request.
export async function createHost({ stream, streaming = true, id = 'streaming-test', config = {}, setup, persistence = true } = {}) {
  const ctx = new Context(), directory = await mkdtemp(join(tmpdir(), 'dsh-streaming-'))
  try {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ToolsService)
    await ctx.plugin(LocalSubprocess)
    class Policy extends Service {
      constructor(ctx) { super(ctx, 'sandboxPolicy') }
      resolve() { return { mode: 'danger-full-access', workspaceRoot: process.cwd() } }
    }
    await ctx.plugin(Policy)
    let requests = 0
    class FixtureAdapter extends LlmAdapter {
      stream(request) { requests++; return stream(request, requests) }
    }
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter())
    if (persistence) ctx.on('session/flush', async (session) => {
      const file = await open(join(directory, 'session.json'), 'w')
      try { await file.writeFile(JSON.stringify({ header: session.header, events: session.snapshotEvents() })); await file.sync() }
      finally { await file.close() }
    })
    await ctx.plugin(plugin, { streaming, ...config })
    ctx.on('agent/pre-step', async (payload, next) => payload.step > 1 ? { kind: 'reject' } : next())
    const frames = []
    ctx.on('agent/assistant-stream', ({ frame }) => { frames.push(frame) }, { global: true })
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
    const handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture', model: 'controlled' }, meta: { cwd: process.cwd() } })
    const { agent } = handle
    const { session } = agent
    await setup?.({ ctx, agent, session })
    return {
      ctx, agent, session, frames,
      get requests() { return requests },
      get events() { return session.snapshotEvents() },
      async run({ prompt = 'Run the controlled fixture.', signal } = {}) {
        signal?.throwIfAborted()
        const onAbort = () => agent.cancel({ kind: 'user' })
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'human' } }))
          await agent.whenIdle()
          signal?.throwIfAborted()
          const reason = session.snapshotEvents().findLast((event) => event.type === 'turn/end')?.data.reason
          if (reason?.kind === 'error') throw new Error(reason.error?.message ?? JSON.stringify(reason.error))
          return reason
        } finally { signal?.removeEventListener('abort', onAbort) }
      },
      async close() {
        try { await handle.dispose(); await ctx.parallel('dispose'); await ctx.fiber.dispose() }
        finally { await rm(directory, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    await ctx.parallel('dispose')
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}
