import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { decodeArguments } from './code-deltas.js'
import { PythonStreams, CODE_LIMIT, trackRawBytes } from './python-streams.js'
import { hashDecodedArguments, installRecovery, recordSource, sameStep } from './streaming-recovery.js'

/** Explicit source-stream admission using only public DSH plugin extension points. */
export async function createStreaming(ctx, { toolName = 'python', enabled }) {
  const registry = new PythonStreams(), streamToolName = `${toolName}_stream`
  const assemblies = new WeakMap(), steps = new WeakMap(), attempts = new Map(), calls = new WeakMap(), projections = new WeakMap()
  const modes = new WeakMap()
  registry.isEnabled = (agent, toolSet) => {
    // Programmatic tools.execute calls can omit toolSet; they have no assembled model step to pin.
    if (!toolSet) return enabled()
    // Admission may later shrink for policy reasons; it must not change the language promised by this step's prompt.
    if (!modes.has(toolSet)) modes.set(toolSet, Boolean(ctx.tools.executable(streamToolName, agent, toolSet)))
    return modes.get(toolSet)
  }
  const recovery = await installRecovery(ctx, {
    ownsCall: (agent, callId, position) => { const state = calls.get(agent)?.get(callId); return state !== undefined && (!position || sameStep(state, position)) },
    positionOf: (agent, toolSet) => { const step = steps.get(agent); return step?.toolSet === toolSet ? step : undefined },
  })
  const active = new Set()
  const remember = (operation) => { active.add(operation); operation.finally(() => active.delete(operation)).catch(() => {}); return operation }
  const flush = (agent) => ctx.sessions.flush(agent.session)
  const record = (state, kind, data = {}) => { state.noticeSeq = recordSource(state.agent.session, kind, {
    turn: state.turn, step: state.step, attemptId: state.attemptId, streamId: state.streamId, callId: state.callId, ...data,
  }, state.noticeSeq) }
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
    try { record(state, 'start', { capability: streamToolName }) }
    catch (error) { state.settled = true; abort(state, error); throw error }
    state.execution = remember((async () => {
      try {
        // Admission must reach durable storage before the first effect.
        if (!await flush(state.agent)) throw new Error('Python streaming requires session persistence before execution')
        if (state.error) throw state.error
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: state.callId, name: streamToolName, arguments: JSON.stringify({ streamId: state.streamId, description: 'Execute an explicitly admitted Python source stream' }) }],
          agent: state.agent, signal: AbortSignal.any([state.signal, state.executionAbort.signal]), toolSet: state.toolSet,
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

  function push(state, chunk) {
    if (chunk.type === 'finish') { state.finish = chunk.reason; return }
    if (chunk.type === 'block-end') {
      if (state.closedBlocks.has(chunk.index)) return
      state.closedBlocks.add(chunk.index)
      const prior = state.blocks.get(chunk.index), final = chunk.block
      if (state.started && (prior || final.type === 'tool-call')) {
        if (!prior || final.type !== 'tool-call' || final.id !== state.callId || final.name !== toolName) throw new Error('Final tool block differs from the admitted Python source')
        if (hashDecodedArguments(decodeArguments(prior.arguments)) !== hashDecodedArguments(decodeArguments(final.arguments))) throw new Error('Final tool call does not match the admitted Python source')
      } else if (!prior && final.type === 'tool-call') state.blocks.set(chunk.index, final)
      return
    }
    if (chunk.type !== 'tool-call-delta') return
    // Match DSH's first-close-wins assembler: stragglers cannot execute code absent from its final block.
    if (state.closedBlocks.has(chunk.index)) return
    if (chunk.namespace !== undefined) throw new Error('Namespaced streaming Python calls are unsupported')
    let block = state.blocks.get(chunk.index)
    if (!block) state.blocks.set(chunk.index, block = { id: chunk.id, name: chunk.name || undefined, arguments: '', rawBytes: 0, rawHigh: false })
    if (block.id !== chunk.id || chunk.name && block.name && block.name !== chunk.name) throw new Error('Streaming tool identity changed')
    if (chunk.name) block.name = chunk.name
    const text = chunk.argumentsDelta
    if (typeof text !== 'string') throw new Error('Streaming arguments must be strings')
    trackRawBytes(block, text)
    block.arguments += text
    if (state.started && (block.id !== state.callId || block.name !== toolName)) throw new Error('Streaming Python requires one tool call per response')
    if (block.name !== toolName) return
    if (state.blocks.size !== 1) throw new Error('Streaming Python requires one tool call per response')
    const first = !state.started
    if (first) start(state, block)
    if (!state.earlySettled && !registry.isClosed(state.streamId)) registry.append(state.streamId, first ? block.arguments : text)
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
      const final = event.call, raw = state.blocks.values().next().value.arguments
      if (!state.checkedArgs) throw new Error('Python source did not complete transport validation')
      if (event.count !== 1 || final?.id !== state.callId || final.name !== toolName || final.hash !== hashDecodedArguments(state.checkedArgs)) throw new Error('Final tool call does not match the admitted Python source')
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

  const admitted = (agent, toolSet) => {
    const state = attempts.get(agent?.id), step = steps.get(agent)
    return state?.started && state.agent === agent && step?.toolSet === toolSet && sameStep(state, step) ? state : undefined
  }

  registry.join = (exec, args) => {
    if (exec.name !== toolName || exec.parent !== undefined) return undefined
    // A provider may replace a streamed call's ID at block-end; it must never become a fresh cell.
    const state = calls.get(exec.agent)?.get(exec.callId) ?? admitted(exec.agent, exec.toolSet)
    if (!state) return undefined
    return (async () => {
      if (state.callId !== exec.callId) {
        abort(state, new Error('Final Python call identity differs from the admitted source'))
        await state.execution
        throw state.error
      }
      if (state.joined) throw new Error('Python source result was already consumed; refusing replay')
      if (state.toolSet !== exec.toolSet) throw new Error('Python source belongs to another tool admission')
      state.joined = true
      if (!state.finalArgs || args.code !== state.finalArgs.code || args.description !== state.finalArgs.description) abort(state, new Error('Final Python arguments differ from the admitted source'))
      try { await state.execution }
      finally { for (const context of state.result?.additionalContexts ?? []) exec.deferContext(context) }
      if (state.error) throw state.error
      const result = state.result
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
    state.toolSet = undefined
    return contexts
  }

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (context.agent && context.toolSet && context.signal) {
      if (registry.isEnabled(context.agent, context.toolSet)) assemblies.set(context.agent, { toolSet: context.toolSet, signal: context.signal })
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
        state.checkedArgs = decodeArguments(state.blocks.values().next().value.arguments)
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
  ctx.on('tools/result', (exec, result) => {
    const state = exec.name === toolName && calls.get(exec.agent)?.get(exec.callId)
    if (state && !state.joined && result.isError) abort(state, new Error('Final Python dispatch was denied after source admission; earlier effects remain'))
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
