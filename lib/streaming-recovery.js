import { createHash } from 'node:crypto'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { decodeArguments } from './code-deltas.js'

const entry = z.object({ streamId: z.string(), callId: z.string(), turn: z.number(), step: z.number(), outcome: z.string().optional(), output: z.string().optional() })
export const streamRecoveryEvent = 'plugin:dsh-py-codeact/stream-recovery'
export const sameStep = (left, right) => left.turn === right.turn && left.step === right.step
export const hashDecodedArguments = ({ code, description }) => createHash('sha256').update(JSON.stringify([code, description])).digest('hex')
export function hashArguments(source) {
  try { return hashDecodedArguments(decodeArguments(source)) }
  catch { return null }
}

/** Keep recovery records off the message surface so settlement doesn't start a new model request series. */
export function recordSource(session, phase, data) {
  const identity = entry.parse(data)
  if (phase === 'start') return appendPluginRecord(session, streamRecoveryEvent, { phase, ...identity })
  const fallback = data.error !== undefined || data.result?.isError ? 'Execution failed without textual output.' : data.result ? 'Execution completed without textual output.' : 'Execution settled without a recorded result'
  const output = String(data.error ?? data.result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '') || fallback
  // Keep a bounded summary alongside full accepted output for recovery without a final tool result.
  const outcome = output.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '')
  return appendPluginRecord(session, streamRecoveryEvent, { phase, ...identity, outcome, output })
}

// Keep only unresolved invocations, not the conversation's source or result history.
// Native recovery cannot infer early effects from a complete assistant call alone.
const recoveryProjection = {
  key: 'dsh-py-codeact/stream-recovery', stateVersion: 6, stateSchema: z.array(entry), init: () => [],
  apply(state, event) {
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      if (event.data.message.isError) return state
      const matches = (item) => item.callId === event.data.message.source.callId && sameStep(item, event.data)
      return state.some(matches) ? state.filter(item => !matches(item)) : state
    }
    // Older sessions stored recovery evidence in user or developer messages.
    const message = event.type === 'developer/message' ? event.data.message : event.type === 'user/message' ? event.data : undefined
    const source = event.type === streamRecoveryEvent ? event.data : message?.source.kind === 'python-stream' ? message.source : undefined
    if (!source) return state
    const { phase } = source
    if (phase !== 'start' && phase !== 'result') return state
    const admission = entry.parse(source)
    if (phase === 'start') {
      if (state.some(item => item.streamId === admission.streamId)) throw new Error('Duplicate Python source admission')
      return [...state, admission]
    }
    return state.map(item => item.streamId !== admission.streamId ? item : { ...item, outcome: admission.outcome, ...(admission.output === undefined ? {} : { output: admission.output }) })
  },
}

export function recoveryContext(state, ownsCall = () => false) {
  const unresolved = state.filter(item => !ownsCall(item.callId, item) || item.outcome !== undefined)
  if (!unresolved.length) return ''
  return ['Python streaming recovery: earlier effects may already exist. Do not replay these invocations or their executed prefixes, even if generic tool recovery says TOOL_NOT_STARTED. Inspect external state before deciding what remains. Interpreter memory is not restored after a process restart.',
    ...unresolved.map(item => `Turn ${item.turn}, step ${item.step}, call ${JSON.stringify(item.callId)}: ${item.outcome === undefined ? 'execution outcome unknown; no settled outcome was recorded.' : item.output ?? item.outcome}`)].join('\n')
}

export async function installRecovery(ctx, { ownsCall = () => false, positionOf = () => undefined } = {}) {
  const [handle, assistant] = await Promise.all([
    ctx.sessionProjections.register(recoveryProjection),
    ctx.sessionProjections.register({ key: 'dsh-py-codeact/stream-settlement', stateVersion: 4,
      stateSchema: z.object({ seq: z.number(), type: z.string(), interrupted: z.boolean(), calls: z.array(z.object({ id: z.string(), name: z.string(), hash: z.string().nullable() })) }).nullable(), init: () => null,
      // A response may carry several calls; settlement finds the admitted one among them instead of assuming it is the only or the first.
      apply(state, event) {
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
        const calls = (event.data.message?.content ?? []).filter(block => block.type === 'tool-call').map(block => ({ id: block.id, name: block.name, hash: hashArguments(block.arguments) }))
        return { seq: event.seq, type: event.type, interrupted: event.data.interrupted === true, calls }
      } }),
  ])
  const context = (session, agent) => recoveryContext(handle.stateOf(session), (callId, position) => agent !== undefined && ownsCall(agent, callId, position))
  ctx.systemPrompt.context({ name: 'python-stream-recovery', order: 100, required: true, interpolate: false, text: ({ agent }) => agent ? context(agent.session, agent) : '' })
  const checkedLegacyHistory = new WeakSet()
  ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
    const config = await next()
    const { session } = agent
    if (checkedLegacyHistory.has(session)) return config
    signal.throwIfAborted()
    const unresolved = new Set(handle.stateOf(session).map(item => item.streamId))
    // Durable replacements need an open step, which the host enters after pre-step.
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq), source = event?.type === 'user/message' ? event.data.source : undefined
      if (source?.kind !== 'python-stream' || (source.phase !== 'start' && source.phase !== 'result') || unresolved.has(source.streamId)) continue
      session.append('developer/message', { turn, step, message: createDeveloperMessage({ source: { kind: 'python-stream' }, content: [] }) },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
    checkedLegacyHistory.add(session)
    return config
  }, { prepend: true })
  ctx.tools.guard((exec) => {
    if (!exec.agent || exec.parent !== undefined) return
    const position = positionOf(exec.agent, exec.toolSet)
    const prior = handle.stateOf(exec.agent.session).find(item => item.callId === exec.callId && (!position || sameStep(item, position)))
    if (prior && !ownsCall(exec.agent, exec.callId, prior)) return 'This Python invocation was already admitted and has no current execution owner. Its effects cannot be replayed.'
  })
  return { stateOf: (session) => handle.stateOf(session), context, lastAssistant: (session) => assistant.stateOf(session) }
}
