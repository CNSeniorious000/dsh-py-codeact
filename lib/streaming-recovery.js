import { createHash } from 'node:crypto'
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { decodeArguments } from './code-deltas.js'

const entry = z.object({ streamId: z.string(), callId: z.string(), turn: z.number(), step: z.number(), outcome: z.string().optional(), output: z.string().optional() })
export const sameStep = (left, right) => left.turn === right.turn && left.step === right.step
export const hashDecodedArguments = ({ code, description }) => createHash('sha256').update(JSON.stringify([code, description])).digest('hex')
export function hashArguments(source) {
  try { return hashDecodedArguments(decodeArguments(source)) }
  catch { return null }
}

/** Empty developer nodes persist recovery evidence without entering chat or model history. */
export function recordSource(session, phase, data, startSeq) {
  const { streamId, callId, turn, step } = entry.parse(data)
  const summary = phase === 'start' ? 'Python streaming started' : 'Python streaming settled'
  const fallback = data.error !== undefined || data.result?.isError ? 'Execution failed without textual output.' : data.result ? 'Execution completed without textual output.' : 'Execution settled without a recorded result'
  const output = String(data.error ?? data.result?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '') || fallback
  // Keep a bounded summary alongside full accepted output for recovery without a final tool result.
  const outcome = phase === 'start' ? undefined : output.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '')
  const source = { kind: 'python-stream', form: 'notice', summary, phase, streamId, callId, turn, step, ...(outcome === undefined ? {} : { outcome, output }) }
  // DSH omits empty developer messages from model input and user-facing chat.
  // Keep full accepted output in durable metadata for interrupted calls without a final tool result.
  return session.append('developer/message', { turn, step, message: createDeveloperMessage({ source, content: [] }) }, phase === 'start'
    ? { surfaceOp: 'append' }
    : { surfaceOp: { op: 'replace', startSeq, endSeq: startSeq }, sourceEventSeqs: [startSeq] }).seq
}

// Keep only unresolved invocations, not the conversation's source or result history.
// Native recovery cannot infer early effects from a complete assistant call alone.
const recoveryProjection = {
  key: 'dsh-py-codeact/stream-recovery', stateVersion: 5, stateSchema: z.array(entry), init: () => [],
  apply(state, event) {
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      if (event.data.message.isError) return state
      const matches = (item) => item.callId === event.data.message.source.callId && sameStep(item, event.data)
      return state.some(matches) ? state.filter(item => !matches(item)) : state
    }
    // Read legacy user notices too, so upgrading retains unresolved effects.
    const message = event.type === 'developer/message' ? event.data.message : event.type === 'user/message' ? event.data : undefined
    if (message?.source.kind !== 'python-stream') return state
    const { phase, ...source } = message.source
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
    ctx.sessionProjections.register({ key: 'dsh-py-codeact/stream-settlement', stateVersion: 3,
      stateSchema: z.object({ seq: z.number(), type: z.string(), interrupted: z.boolean(), count: z.number(), call: z.object({ id: z.string(), name: z.string(), hash: z.string().nullable() }).nullable() }).nullable(), init: () => null,
      apply(state, event) {
        if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
        const calls = event.data.message?.content.filter(block => block.type === 'tool-call') ?? [], first = calls[0]
        return { seq: event.seq, type: event.type, interrupted: event.data.interrupted === true, count: calls.length,
          call: first ? { id: first.id, name: first.name, hash: hashArguments(first.arguments) } : null }
      } }),
  ])
  const context = (session, agent) => recoveryContext(handle.stateOf(session), (callId, position) => agent !== undefined && ownsCall(agent, callId, position))
  ctx.systemPrompt.context({ name: 'python-stream-recovery', order: 100, required: true, interpolate: false, text: ({ agent }) => agent ? context(agent.session, agent) : '' })
  ctx.tools.guard((exec) => {
    if (!exec.agent || exec.parent !== undefined) return
    const position = positionOf(exec.agent, exec.toolSet)
    const prior = handle.stateOf(exec.agent.session).find(item => item.callId === exec.callId && (!position || sameStep(item, position)))
    if (prior && !ownsCall(exec.agent, exec.callId, prior)) return 'This Python invocation was already admitted and has no current execution owner. Its effects cannot be replayed.'
  })
  return { stateOf: (session) => handle.stateOf(session), context, lastAssistant: (session) => assistant.stateOf(session) }
}
