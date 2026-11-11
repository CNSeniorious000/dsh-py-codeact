/** Order policy and result commits while overlapping only explicitly safe tool bodies. */
export class SubcallScheduler {
  #pending = []
  #commits = []
  #running = new Set()
  #logs = new Set()
  #exclusive = false
  #driving = false
  #wake

  constructor(pipeline, signal, maxParallel = 10) {
    this.pipeline = pipeline
    this.signal = signal
    this.maxParallel = maxParallel
    signal.addEventListener('abort', () => this.#wake?.(), { once: true })
  }

  run(input, start, complete) {
    return new Promise((resolve, reject) => {
      this.#pending.push({ input, start, complete, resolve, reject, settled: false })
      this.#wake?.()
      void this.#drive()
    })
  }

  trackLog(operation) {
    const settled = operation.then(() => {}, () => {})
    this.#logs.add(settled)
    void settled.then(() => this.#logs.delete(settled))
    return operation
  }

  async #start(job) {
    try {
      job.start()
      const prepared = await this.pipeline.prepare(job.input)
      job.exec = prepared.exec
      const flight = (async () => {
        try { job.outcome = prepared.kind === 'dispatch' ? await this.pipeline.dispatch(prepared.exec) : prepared }
        catch (error) { job.failed = true; job.error = error }
        finally { job.settled = true }
      })()
      this.#running.add(flight)
      void flight.finally(() => { this.#running.delete(flight); this.#wake?.() })
    } catch (error) { job.failed = true; job.error = error; job.settled = true }
  }

  async #commit(job) {
    try {
      if (job.failed) throw job.error
      const result = await this.pipeline.complete(job.exec, job.outcome)
      job.resolve(await job.complete(result))
      // Return the value promptly, then bound retained log payloads before starting more work.
      while (this.#logs.size > this.maxParallel) await Promise.race(this.#logs)
    } catch (error) { job.reject(error) }
  }

  async #drive() {
    if (this.#driving) return
    this.#driving = true
    try {
      for (;;) {
        // Install the wakeup before inspecting queues so a completion cannot be lost.
        const changed = new Promise(resolve => { this.#wake = resolve })
        const commit = this.#commits[0]
        if (commit?.settled) {
          this.#commits.shift()
          await this.#commit(commit)
          if (commit.mode === 'exclusive') this.#exclusive = false
          continue
        }
        const job = this.#pending[0]
        if (job) {
          if (this.signal.aborted) {
            this.#pending.shift()
            job.reject(this.signal.reason ?? new Error('Python cell settled before the tool started'))
            continue
          }
          // Registry policy can change while a call is queued; classify again at each start attempt.
          const mode = this.pipeline.executionMode(job.input).kind
          // Completed bodies still retain their outcomes until the ordered commit catches up.
          const capacity = !this.#exclusive && (mode === 'exclusive' ? this.#running.size === 0 : this.#commits.length < this.maxParallel)
          if (capacity) {
            this.#pending.shift()
            job.mode = mode
            this.#exclusive = mode === 'exclusive'
            this.#commits.push(job)
            await this.#start(job)
            continue
          }
        }
        if (!this.#pending.length && !this.#commits.length && !this.#running.size) return
        await changed
      }
    } finally { this.#driving = false; this.#wake = undefined }
  }
}
