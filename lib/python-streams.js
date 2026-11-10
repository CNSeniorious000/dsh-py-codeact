import { CodeDeltas } from './code-deltas.js'

export const RAW_LIMIT = 12 * 1024 * 1024
export const CODE_LIMIT = 2 * 1024 * 1024
const done = { value: undefined, done: true }

export function trackRawBytes(state, text) {
  if (!text) return
  const first = text.charCodeAt(0), last = text.charCodeAt(text.length - 1)
  // byteLength replaces lone UTF-16 surrogates; undo the overcount for a split pair.
  state.rawBytes += Buffer.byteLength(text) - (state.rawHigh && first >= 0xdc00 && first <= 0xdfff ? 2 : 0)
  state.rawHigh = last >= 0xd800 && last <= 0xdbff
  if (state.rawBytes > RAW_LIMIT) throw new Error('Python arguments exceed 12 MiB')
}

function wake(state) {
  const notify = state.wake
  state.wake = undefined
  notify?.()
}

function discard(state) {
  state.queue.length = 0
  state.head = 0
}

function open(state) {
  if (state.error) throw state.error
  if (state.finished || state.closed) throw new Error('Python source is already closed')
}

function sourceFor(state) {
  return {
    [Symbol.asyncIterator]() {
      if (state.reader) throw new Error('Python source already has a reader')
      state.reader = true
      let pending = false
      return {
        async next() {
          if (pending) throw new Error('Concurrent reads of Python source are not allowed')
          pending = true
          try {
            while (true) {
              if (state.closed) return done
              // Failure must win even if a producer queued source immediately before aborting.
              if (state.error) throw state.error
              if (state.head < state.queue.length) {
                const value = state.queue[state.head++]
                if (state.head === state.queue.length) discard(state)
                return { value, done: false }
              }
              if (state.finished) { state.closed = true; return done }
              await new Promise((resolve) => { state.wake = resolve })
            }
          } finally { pending = false }
        },
        async return() {
          state.closed = true
          discard(state)
          wake(state)
          return done
        },
        [Symbol.asyncIterator]() { return this },
      }
    },
  }
}

/** One reader per source; transport failure takes precedence over queued code. */
export class PythonStreams {
  streams = new Map()

  dispose() { for (const id of this.streams.keys()) this.delete(id) }

  create(id, { callId, agent }) {
    if (typeof id !== 'string' || !id || typeof callId !== 'string' || !callId || !agent) throw new Error('Python source requires stream, call and agent identities')
    if (this.streams.has(id)) throw new Error(`Duplicate Python source: ${id}`)
    const state = { callId, agent, decoder: new CodeDeltas(), queue: [], head: 0, rawBytes: 0, codeBytes: 0, rawHigh: false, claimed: false, reader: false, finished: false, closed: false }
    state.source = sourceFor(state)
    this.streams.set(id, state)
    return state.source
  }

  state(id) {
    const state = this.streams.get(id)
    if (!state) throw new Error(`Unknown Python source: ${id}`)
    return state
  }

  has(id, callId, agent) {
    const state = this.streams.get(id)
    return state !== undefined && state.callId === callId && state.agent === agent
  }

  get(id) { return this.state(id).source }
  isClosed(id) { return this.state(id).closed }

  claim(id, callId, agent) {
    const state = this.state(id)
    if (!this.has(id, callId, agent)) throw new Error('Python source identity does not match the tool execution')
    if (state.claimed) throw new Error('Python source was already claimed')
    state.claimed = true
    return state.source
  }

  append(id, rawDelta) {
    const state = this.state(id)
    try {
      open(state)
      if (typeof rawDelta !== 'string') throw new Error('Python argument deltas must be strings')
      if (!rawDelta) return
      trackRawBytes(state, rawDelta)
      const code = state.decoder.feed(rawDelta)
      state.codeBytes += Buffer.byteLength(code)
      if (state.codeBytes > CODE_LIMIT) throw new Error('Python source exceeds 2 MiB')
      if (code) { state.queue.push(code); wake(state) }
    } catch (error) {
      this.abort(id, error)
      throw error
    }
  }

  finish(id, rawFinalArgs) {
    const state = this.state(id)
    try {
      open(state)
      const args = state.decoder.finish(rawFinalArgs)
      state.finished = true
      wake(state)
      return args
    } catch (error) {
      this.abort(id, error)
      throw error
    }
  }

  abort(id, error) {
    const state = this.state(id)
    state.error ??= error instanceof Error ? error : new Error('Python source aborted', { cause: error })
    discard(state)
    wake(state)
  }

  delete(id) {
    if (!this.streams.has(id)) return false
    this.abort(id, new Error('Python source deleted'))
    return this.streams.delete(id)
  }
}
