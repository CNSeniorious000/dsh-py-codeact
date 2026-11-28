import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { decodeArguments } from './code-deltas.js'
import { PythonStreams, CODE_LIMIT, trackRawBytes } from './python-streams.js'
import { hashDecodedArguments, installRecovery, recordSource, sameStep } from './streaming-recovery.js'

/** The decoded source, or undefined while its argument string is still arriving or is not one. */
const sourceOf = (text) => { try { return decodeArguments(text) } catch { return undefined } }

/** Same executed Python code — the identity a provider keeps when it re-closes or renames one admitted call. */
const sameSource = (left, right) => left !== undefined && right !== undefined && left.code === right.code

/** Explicit source-stream admission using only public DSH plugin extension points. */
export async function createStreaming(ctx, { toolName = 'python', enabled }) {
  const registry = new PythonStreams(), streamToolName = `${toolName}_stream`
  const assemblies = new WeakMap(), steps = new WeakMap(), attempts = new Map(), calls = new WeakMap(), projections = new WeakMap()
  const modes = new WeakMap()
  // 0.2.3-alpha.3 selects a root registry instead of an executor; the capability is resolved through the root.
  const rootHost = typeof ctx.tools.setRoot === 'function'
  registry.isEnabled = (agent, toolStep) => {
    // Programmatic tools.execute calls can omit the model step; they have no assembled step to pin.
    if (!toolStep) return enabled()
    // Admission may later shrink for policy reasons; it must not change the language promised by this step's prompt.
    // The root API drops the registration's `when` gate, so the live preference is read here instead.
    if (!modes.has(toolStep)) modes.set(toolStep, rootHost ? enabled() && ctx.tools.get(streamToolName, agent) !== undefined : Boolean(ctx.tools.executable(streamToolName, agent, toolStep)))
    return modes.get(toolStep)
  }
  const recovery = await installRecovery(ctx, {
    ownsCall: (agent, callId, position) => { const state = calls.get(agent)?.get(callId); return state !== undefined && (!position || sameStep(state, position)) },
    positionOf: (agent, toolStep) => { const step = steps.get(agent); return step?.toolStep === toolStep ? step : undefined },
  })
  const active = new Set()
  const remember = (operation) => { active.add(operation); operation.finally(() => active.delete(operation)).catch(() => {}); return operation }
  const flush = (agent) => ctx.sessions.flush(agent.session)
  const record = (state, phase, data = {}) => recordSource(state.agent.session, phase, {
    turn: state.turn, step: state.step, streamId: state.streamId, callId: state.callId, ...data,
  })
  function abort(state, error) {
    state.error ??= error instanceof Error ? error : new Error(toolErrorMessage(error))
    state.executionAbort?.abort(state.error)
    if (state.started && registry.streams.has(state.streamId)) registry.abort(state.streamId, state.error)
  }

  function release(state) {
    if (!state.ended || !state.settled || !state.started) return
    state.signal.removeEventListener('abort', state.onAbort)
    registry.delete(state.streamId)
  }

  function start(state, block) {
    if (calls.get(state.agent)?.has(block.id) || recovery.stateOf(state.agent.session).some(item => item.callId === block.id && sameStep(item, state))) throw new Error('Python call identity was already admitted; refusing replay')
    state.started = true
    state.executionAbort = new AbortController()
    state.callId = block.id
    // DSH attempt counters restart when an Agent is reattached to a Session.
    state.streamId = JSON.stringify([state.agent.id, state.turn, state.step, state.attemptId, block.id])
    let owned = calls.get(state.agent)
    if (!owned) calls.set(state.agent, owned = new Map())
    owned.set(block.id, state)
    registry.create(state.streamId, { callId: block.id, agent: state.agent })
    state.onAbort = () => {
      const reason = state.signal.reason
      // DSH cancels with a structured cause, not an Error instance.
      abort(state, reason instanceof Error ? reason : new Error('InterruptedError: the harness cancelled this streaming cell. Earlier effects remain.', { cause: reason }))
    }
    state.signal.addEventListener('abort', state.onAbort, { once: true })
    if (state.signal.aborted) state.onAbort()
    try { record(state, 'start') }
    catch (error) { state.settled = true; abort(state, error); throw error }
    state.execution = remember((async () => {
      try {
        // Admission must reach durable storage before the first effect.
        if (!await flush(state.agent)) throw new Error('Python streaming requires session persistence before execution')
        if (state.error) throw state.error
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: state.callId, name: streamToolName, arguments: JSON.stringify({ streamId: state.streamId, description: 'Execute an explicitly admitted Python source stream' }) }],
          agent: state.agent, signal: AbortSignal.any([state.signal, state.executionAbort.signal]), ...(rootHost ? {} : { toolSet: state.toolStep }),
        })
        state.result = batch.results[0]?.result
        if (!state.result) throw new Error('Streaming dispatch returned no result')
        const { value: _value, ...durableResult } = state.result
        record(state, 'result', { result: durableResult })
        await flush(state.agent)
      } catch (error) {
        abort(state, error)
        record(state, 'result', { error: toolErrorMessage(error) })
        await flush(state.agent)
      } finally {
        state.settled = true
        // Rejected admission and runtime errors must stop the source reader, but provider audit continues.
        if (!state.ended) {
          state.earlySettled = true
          if (registry.streams.has(state.streamId)) registry.abort(state.streamId, new Error('Streaming execution settled before source completion'))
        }
        release(state)
      }
    })())
  }

  /** Raw arguments of the block bound to the source stream — the one invocation whose effects already ran. */
  const admittedRaw = (state) => state.blocks.get(state.admittedIndex)?.arguments

  /**
   * Bind the source stream to the FIRST Python call in index order, once no earlier call can still turn out to be it.
   * The host dispatches the batch in message order, so streaming a later call would hold the kernel while an earlier
   * one is dispatched into it and rejected as busy. Returns the block this call admitted, whose accumulated source the
   * caller must feed; the caller's own delta is not part of it on later chunks.
   */
  function admit(state) {
    if (state.admittedIndex !== undefined) return undefined
    let chosen
    for (const [index, block] of state.blocks) if (block.name === toolName && (chosen === undefined || index < chosen[0])) chosen = [index, block]
    if (!chosen || state.unstreamed !== undefined && state.unstreamed < chosen[0]) return undefined
    for (const [index, block] of state.blocks) if (index < chosen[0] && block.name === undefined) return undefined
    state.admittedIndex = chosen[0]
    start(state, chosen[1])
    return chosen[1]
  }

  function push(state, chunk) {
    const feed = (block) => { if (!state.earlySettled && !registry.isClosed(state.streamId)) registry.append(state.streamId, block.arguments) }
    if (chunk.type === 'finish') { state.finish = chunk.reason; return }
    if (chunk.type === 'block-end') {
      if (state.closedBlocks.has(chunk.index)) return
      state.closedBlocks.add(chunk.index)
      // Any other call in the response belongs to the host's batch, dispatched after the message; only the admitted source executes early.
      if (chunk.index !== state.admittedIndex) {
        const final = chunk.block, tracked = state.blocks.get(chunk.index)
        if (final.type === 'tool-call') {
          if (tracked) { if (final.name) tracked.name = final.name }
          // A complete block that never streamed is dispatched whole before any later call; admitting a later one would starve it on a busy kernel.
          else if (final.name === toolName) state.unstreamed = Math.min(state.unstreamed ?? Infinity, chunk.index)
          // A close that names the admitted call is that invocation re-closed at another index, which can never become a second cell.
          if (state.admittedIndex !== undefined && final.id === state.callId) throw new Error('Final tool block differs from the admitted Python source')
          // Buffered source only executes when the authoritative close agrees with it — identity included; otherwise the
          // committed call runs as one whole cell under the identity it was committed with.
          if (tracked && (final.id !== tracked.id || final.name === toolName && !sameSource(sourceOf(tracked.arguments), sourceOf(final.arguments)))) {
            state.blocks.delete(chunk.index)
            if (final.name === toolName) state.unstreamed = Math.min(state.unstreamed ?? Infinity, chunk.index)
          }
        } else if (tracked) state.blocks.delete(chunk.index)
        const fresh = admit(state)
        if (fresh) feed(fresh)
        return
      }
      const prior = state.blocks.get(chunk.index), final = chunk.block
      if (!prior || final.type !== 'tool-call' || final.id !== state.callId || final.name !== toolName) throw new Error('Final tool block differs from the admitted Python source')
      if (hashDecodedArguments(decodeArguments(prior.arguments)) !== hashDecodedArguments(decodeArguments(final.arguments))) throw new Error('Final tool call does not match the admitted Python source')
      return
    }
    if (chunk.type !== 'tool-call-delta') return
    // Match DSH's first-close-wins assembler: stragglers cannot execute code absent from its final block.
    if (state.closedBlocks.has(chunk.index)) return
    // Exactly one call is bound to the source stream; deltas of any other call never reach it.
    if (state.admittedIndex !== undefined && chunk.index !== state.admittedIndex) return
    if (chunk.namespace !== undefined) throw new Error('Namespaced streaming Python calls are unsupported')
    let block = state.blocks.get(chunk.index)
    if (!block) state.blocks.set(chunk.index, block = { id: chunk.id, name: chunk.name || undefined, arguments: '', rawBytes: 0, rawHigh: false })
    if (block.id !== chunk.id || chunk.name && block.name && block.name !== chunk.name) throw new Error('Streaming tool identity changed')
    if (chunk.name) block.name = chunk.name
    const text = chunk.argumentsDelta
    if (typeof text !== 'string') throw new Error('Streaming arguments must be strings')
    trackRawBytes(block, text)
    block.arguments += text
    const fresh = admit(state)
    if (fresh) feed(fresh)
    if (state.admittedIndex !== chunk.index || fresh === block) return
    if (!state.earlySettled && !registry.isClosed(state.streamId)) registry.append(state.streamId, text)
  }

  function end(state, frame) {
    if (state.ended) return
    state.ended = true
    if (!state.started) return
    try {
      if (state.error) throw state.error
      if (frame.outcome.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message') throw new Error('Python source did not reach an authoritative assistant message')
      if (!['stop', 'tool-calls'].includes(state.finish?.kind)) throw new Error(`Python source did not finish successfully: ${state.finish?.kind ?? 'missing finish'}`)
      const event = recovery.lastAssistant(state.agent.session)
      if (event?.seq !== frame.outcome.seq || event.interrupted) throw new Error('Python source settlement does not match the current attempt')
      const final = event.calls.filter((call) => call.id === state.callId && call.name === toolName), raw = admittedRaw(state)
      if (!state.checkedArgs) throw new Error('Python source did not complete transport validation')
      if (final.length !== 1 || final[0].hash !== hashDecodedArguments(state.checkedArgs)) throw new Error('Final tool call does not match the admitted Python source')
      state.finalArgs = !state.earlySettled && !registry.isClosed(state.streamId) ? registry.finish(state.streamId, raw) : state.checkedArgs
      state.checkedArgs = undefined
    } catch (error) {
      abort(state, error)
    } finally { release(state) }
  }

  async function drain(agent) {
    const states = [...attempts.values()].filter((state) => !agent || state.agent === agent)
    // Each invocation reports its own failure; cleanup must not carry it into a later turn.
    await Promise.allSettled(states.map((state) => state.execution))
  }

  const stepOf = (exec) => exec.toolStep ?? exec.toolSet
  const admitted = (agent, toolStep) => {
    const state = attempts.get(agent?.id), step = steps.get(agent)
    return state?.started && state.agent === agent && step?.toolStep === toolStep && sameStep(state, step) ? state : undefined
  }

  registry.join = (exec, args) => {
    if (exec.name !== toolName || exec.parent !== undefined) return undefined
    const state = calls.get(exec.agent)?.get(exec.callId)
    if (!state) {
      // A provider may replace a streamed call's ID — settlement then fails, so the compared source may have to come from
      // the raw block instead of `finalArgs`. The same source must never become a fresh cell. Any other call in the step
      // is a whole-cell invocation the host dispatches after the message.
      const prior = admitted(exec.agent, stepOf(exec))
      if (!prior || !sameSource(prior.finalArgs ?? prior.checkedArgs ?? sourceOf(admittedRaw(prior)), args)) return undefined
      abort(prior, new Error('Python call repeats the admitted source; earlier effects already ran'))
      return (async () => { await prior.execution; throw prior.error })()
    }
    return (async () => {
      if (state.joined) throw new Error('Python source result was already consumed; refusing replay')
      if (state.toolStep !== stepOf(exec)) throw new Error('Python source belongs to another tool admission')
      state.joined = true
      if (!state.finalArgs || args.code !== state.finalArgs.code) abort(state, new Error('Final Python arguments differ from the admitted source'))
      try { await state.execution }
      finally { for (const context of state.result?.additionalContexts ?? []) exec.deferContext(context) }
      const result = state.result
      // Cancellation can arrive after execution, while its accepted result is being persisted.
      if (result && (result.isError || state.error && state.signal.aborted)) projections.set(exec.token,
        result.isError ? result.content : [...result.content, { type: 'text', text: toolErrorMessage(state.error) }])
      if (state.error) throw state.error
      if (result.isError) throw new Error(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
      if (result.concludesTurn) exec.concludeTurn()
      projections.set(exec.token, result.content)
      return result.value
    })()
  }

  registry.projectContent = (exec) => projections.get(exec.token)

  registry.settleBatch = async ({ agent, toolSet }) => {
    const state = admitted(agent, toolSet)
    if (!state) return
    if (!state.joined) abort(state, new Error('Final Python dispatch did not join its admitted source; earlier effects remain'))
    // The pipeline already recorded the invocation's failure; preserve its accepted contexts.
    await Promise.allSettled([state.execution])
    // Joined contexts already passed final policy, which may deliberately discard them.
    const contexts = state.joined ? [] : state.result?.additionalContexts ?? []
    state.blocks.clear()
    state.finalArgs = undefined
    state.checkedArgs = undefined
    state.result = undefined
    state.toolStep = undefined
    return contexts
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent && (context.toolStep ?? context.toolSet) && context.signal) {
      const step = context.toolStep ?? context.toolSet
      if (registry.isEnabled(context.agent, step)) assemblies.set(context.agent, { toolStep: step, signal: context.signal })
      else assemblies.delete(context.agent)
    }
    return next()
  })
  ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
    await drain(agent)
    const assembly = assemblies.get(agent)
    const previous = steps.get(agent)
    if (!previous || !sameStep(previous, { turn, step })) calls.delete(agent)
    if (assembly?.signal === signal) {
      steps.set(agent, { ...assembly, turn, step })
    } else steps.delete(agent)
    return next()
  }, { prepend: true })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      attempts.delete(agent.id)
      const admitted = steps.get(agent)
      if (!admitted || admitted.turn !== frame.turn || admitted.step !== frame.step) return
      attempts.set(agent.id, { ...admitted, agent, attemptId: frame.attemptId, blocks: new Map(), closedBlocks: new Set() })
      return
    }
    const state = attempts.get(agent.id)
    if (!state || state.agent !== agent || state.attemptId !== frame.attemptId) return
    try {
      if (frame.type === 'chunk' && !state.error) push(state, frame.chunk)
      if (frame.type === 'end') end(state, frame)
    } catch (error) { abort(state, error) }
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (!isAgentLoopRequest(options)) { yield* next(); return }
    let state, finish, exhausted = false
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'finish') finish = chunk.reason
        yield chunk
        state = attempts.get(options.sessionId)
        if (state?.error) throw state.error
      }
      state ??= attempts.get(options.sessionId)
      if (state?.started && !finish) throw new Error('Python source ended without a finish event')
      // Validate transport completeness while the middleware still owns cleanup.
      // Only the later committed assistant frame may deliver Python EOF.
      if (state?.started && ['stop', 'tool-calls'].includes(finish?.kind)) {
        state.checkedArgs = decodeArguments(admittedRaw(state))
        if (Buffer.byteLength(state.checkedArgs.code) > CODE_LIMIT) throw new Error('Python source exceeds 2 MiB')
      }
      exhausted = true
    } catch (error) {
      state ??= attempts.get(options.sessionId)
      if (state?.started) abort(state, error)
      throw error
    } finally {
      state ??= attempts.get(options.sessionId)
      if (state?.started && (!exhausted || options.signal?.aborted || state.error || !['stop', 'tool-calls'].includes(finish?.kind))) {
        abort(state, state.error ?? options.signal?.reason ?? new Error(`Python source ended before successful completion: ${finish?.kind ?? 'missing finish'}`))
        // Retain step-owned admission during cleanup without replacing the original stream error.
        await Promise.allSettled([state.execution])
      }
    }
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, turn, step }, next) => {
    const state = attempts.get(agent.id)
    if (!state?.started || state.turn !== turn || state.step !== step) return next()
    abort(state, new Error('Model retry is disabled after Python source admission'))
    await Promise.allSettled([state.execution])
    return undefined
  }, { prepend: true })
  // The root API has no executor wrapper to await the admitted execution inside; the denied path's policy stage can.
  // Only a call that never joined needs it: a dispatched one waits for the source inside `join`.
  ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (rootHost && exec.name === toolName) {
      const state = calls.get(exec.agent)?.get(exec.callId)
      if (state && !state.joined) await Promise.allSettled([state.execution])
    }
    return next()
  }, { prepend: true })
  // A denied or skipped admission's accepted context has no batch result to ride: the root API never runs its body,
  // so hand the context to the next step directly, once.
  const deliverContexts = (state) => {
    const contexts = state.contexts ?? state.result?.additionalContexts ?? []
    if (state.contextsDelivered || state.joined || contexts.length === 0) return false
    state.contextsDelivered = true
    for (const context of contexts) state.agent.inbox?.splice('next-step', state.agent.inbox.nextStep.length, 0, [context])
    return true
  }
  // Nested calls produce their accepted context while the source streams, before any settlement can decide the outcome.
  registry.recordContexts = (exec, contexts) => {
    const state = calls.get(exec.agent)?.get(exec.callId)
    if (state && contexts.length > 0) (state.contexts ??= []).push(...contexts)
  }
  ctx.on('tools/result', (exec, result) => {
    const state = exec.name === toolName && calls.get(exec.agent)?.get(exec.callId)
    if (!state || state.joined) return
    if (rootHost) {
      deliverContexts(state)
      abort(state, new Error('Final Python dispatch did not join its admitted source; earlier effects remain'))
    }
    else if (result.isError) abort(state, new Error('Final Python dispatch was denied after source admission; earlier effects remain'))
  })
  // A call the batch skips on cancellation commits its result without notifying tools/result; its log event remains.
  ctx.on('session/event', (session, event) => {
    if (!rootHost || event.type !== 'tool/result') return
    const callId = event.data?.message?.source?.callId
    for (const state of attempts.values()) if (state.callId === callId && state.agent.session === session) deliverContexts(state)
  })
  ctx.on('agent/turn-stopping', ({ agent }) => drain(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const state = attempts.get(agent.id)
    if (state?.agent !== agent) return
    if (!state.settled) abort(state, new Error('Python agent disposed'))
    attempts.delete(agent.id)
    calls.delete(agent)
  })
  ctx.on('dispose', async () => {
    for (const state of attempts.values()) if (!state.settled) abort(state, new Error('Python streaming plugin disposed'))
    await Promise.allSettled([...active])
    registry.dispose()
  })
  return Object.assign(registry, { streamToolName, drain, recovery })
}
