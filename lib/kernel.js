/**
 * Host side of the persistent Python kernel: spawn, JSON-lines framing on fd 3, and the outbound tool-call bridge.
 *
 * Model code has full access to fd 3, so every inbound frame is shape-validated and REBUILT before anything reads it — a forged extra field never rides along, and junk drops instead of throwing in the message handler.
 *
 * @module dsh-py-codeact/kernel
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

/** Wire default for the `shell` field. Python has its own copy of this literal — the seam is the one place the two languages must agree by hand. */
export const DEFAULT_SHELL = 'main'

export const KERNEL_PY = join(dirname(fileURLToPath(import.meta.url)), '..', 'py', 'kernel.py')

/** The shell a frame addresses. Empty string falls back too, matching the Python side's `or` rather than diverging from it. */
const shellOf = (raw) => (typeof raw.shell === 'string' && raw.shell !== '' ? raw.shell : DEFAULT_SHELL)

/** Rebuild one inbound frame, or `undefined` when it is not a shape we accept. */
function validateFrame(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const t = raw.t
  if (t === 'ready') return { t, shell: shellOf(raw), env: raw.env === null || typeof raw.env !== 'object' ? undefined : raw.env }
  if (t === 'call') {
    if (!Number.isSafeInteger(raw.id) || typeof raw.name !== 'string') return undefined
    return { t, id: raw.id, shell: shellOf(raw), name: raw.name, args: raw.args }
  }
  if (t === 'done') {
    if (!Number.isSafeInteger(raw.id) || typeof raw.ok !== 'boolean') return undefined
    const text = (value) => (typeof value === 'string' ? value : undefined)
    return {
      t, id: raw.id, ok: raw.ok, shell: shellOf(raw),
      stdout: text(raw.stdout) ?? '',
      stderr: text(raw.stderr) ?? '',
      repr: text(raw.repr),
      error: text(raw.error),
      note: text(raw.note),
    }
  }
  return undefined
}

/**
 * Environment the kernel gets when `inheritEnv` is off.
 *
 * NOT the empty env the worker-thread runtime uses: CPython running IPython needs a few of these to work at all (a profile dir under HOME, a PATH for shell escapes, a TMPDIR). The point is excluding ambient credentials.
 *
 * Deliberately an allowlist rather than dsh's shared `scrubbedParentEnv()`, which is a denylist over `/KEY|PASSWORD|SECRET|TOKEN/i` — `GH_PAT`, `*_AUTH` and a `DATABASE_URL` with an inline password all pass that filter. The README promises no ambient credentials reach model code, and only an allowlist keeps that promise.
 */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'SYSTEMROOT', 'APPDATA',
  // A cell installs packages and fetches URLs. Without these, `!uv pip install` behind a corporate proxy fails with a network error that points nowhere near the missing variable. None of them is credential-shaped. Lowercase forms included deliberately: curl and requests read those, not the uppercase ones.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
]

function baseEnv() {
  return Object.fromEntries(
    ENV_ALLOWLIST.map((key) => [key, process.env[key]]).filter(([, value]) => value !== undefined),
  )
}

/**
 * Delete throwaway venvs left by harness processes that are gone.
 *
 * Teardown is best-effort by nature: the `rm` on exit is asynchronous, and a SIGKILL'd harness never reaches it at all. Sweeping on the way IN makes the leak self-healing instead of unbounded — and the pid tag means a directory in use by a live harness is never touched.
 */
async function sweepAbandonedEnvs() {
  const alive = (pid) => {
    try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
  }
  let entries
  try { entries = await readdir(tmpdir()) } catch { return }
  await Promise.all(entries.map(async (entry) => {
    const pid = Number(/^dsh-py-codeact-(\d+)-/.exec(entry)?.[1])
    if (!Number.isInteger(pid) || alive(pid)) return
    await rm(join(tmpdir(), entry), { recursive: true, force: true }).catch(() => {})
  }))
}

export class KernelDeadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'KernelDeadError'
  }
}

export class PythonKernel {
  /**
   * @param options.command - argv to spawn. By default the PEP 723 environment is resolved once with `uv python find --script` and that interpreter is spawned DIRECTLY. Pass `[<python>, <kernel.py>]` to use your own.
   * @param options.cwd - working directory for the kernel process.
   * @param options.env - full environment override; omit for the allowlist above.
   * @param options.onCall - `(name, args) => Promise<{ok, value?, message?}>`, the host's tool dispatch. The kernel may have several outstanding under `asyncio.gather`.
   * @param options.hardInterruptMs - grace period before SIGKILL when an aborted cell does not yield to the in-band interrupt.
   */
  constructor({ command, cwd, env, onCall, hardInterruptMs = 5000, ephemeralEnv = true } = {}) {
    this.command = command
    this.ephemeralEnv = ephemeralEnv
    this.ephemeralRoot = undefined
    this.dead = false
    this.cwd = cwd
    this.env = { ...(env ?? baseEnv()), PYTHONUNBUFFERED: '1' }
    this.onCall = onCall
    this.hardInterruptMs = hardInterruptMs
    this.proc = undefined
    this.buffer = ''
    this.nextExecId = 0
    this.pending = new Map() // execId -> {resolve, reject}
    this.shells = new Set()  // agents with a live shell in this process
    this.ready = undefined
  }

  get alive() {
    // Tracked from the exit event rather than read off `proc.killed`, which Node sets on any `kill()` call — including a signal the process survived.
    return this.proc !== undefined && !this.dead
  }

  /**
   * The interpreter to spawn, plus anything that has to be torn down with it.
   *
   * NOT `uv run --script`: that stays in the process tree as a PARENT of the real interpreter. When it exits, the interpreter is reparented to init, the handle we hold reports an exit, and a perfectly live kernel looks dead — so the next cell respawns and the session's state is lost for no reason. `uv python find --script` materializes the same PEP 723 environment and hands back the interpreter, which we then own directly.
   *
   * That environment is SHARED, though: uv keys it by the script's dependency list, so every session and every future run resolves the same directory. A cell doing `!uv pip install` would leak into all of them — and pointing `config.python` at a project venv is worse, since the install lands in the user's own project. So each kernel gets a throwaway venv of its own that INHERITS the base environment's packages: imports still resolve, installs stay local, and the directory dies with the kernel. Same shape as `ipython-mcp.py`'s ephemeral-venv fork.
   */
  async #resolveCommand() {
    // `uv python find --script` only LOOKS the environment up — on a machine where it has never been built it happily returns the bare interpreter, which has no IPython, and the kernel dies on its first import. `sync` builds it (a no-op once it exists), and only then does `find` name the environment rather than the interpreter uv would have used to make it. Every developer who already ran the kernel once has this cached, which is exactly why it never showed up here.
    if (this.command === undefined) await execFileAsync('uv', ['sync', '--script', KERNEL_PY], { env: this.env })
    const base = this.command ?? [(await execFileAsync('uv', ['python', 'find', '--script', KERNEL_PY], { env: this.env })).stdout.trim(), KERNEL_PY]
    if (this.ephemeralEnv === false || this.command !== undefined) return base // an explicit argv is the user's business

    const [python] = base
    // Independent: the sweep only needs tmpdir, the site-packages read only needs the interpreter. Overlapping them hides a directory walk behind a subprocess spawn on every cold start.
    const [{ stdout: sitePaths }] = await Promise.all([
      execFileAsync(python, ['-c', 'import site, os; print(os.pathsep.join(site.getsitepackages()))'], { env: this.env }),
      sweepAbandonedEnvs(),
    ])
    // Tagged with our pid so the sweep above can tell an abandoned directory from one a live harness is still using.
    const root = await mkdtemp(join(tmpdir(), `dsh-py-codeact-${process.pid}-`))
    // symlink so this costs milliseconds rather than a copy of every package
    await execFileAsync('uv', ['venv', '--python', python, '--link-mode', 'symlink', root], { env: this.env })
    this.ephemeralRoot = root
    this.env = {
      ...this.env,
      VIRTUAL_ENV: root,
      // Read by kernel.py BEFORE it imports IPython. Appended, so the throwaway venv's own site-packages keep precedence and an install shadows the inherited copy rather than being shadowed by it.
      DSH_CODEACT_INHERIT_SITE: sitePaths.trim(),
    }
    return [join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), KERNEL_PY]
  }

  /**
   * Spawn the interpreter and open one shell. Idempotent per shell.
   *
   * The first call brings the process up; later shells (a subagent's) reuse it, so a fan-out pays one `init` frame rather than another interpreter.
   */
  async start(toolSpecs, shell = DEFAULT_SHELL) {
    if (this.ready === undefined) {
      this.ready = this.#spawn(toolSpecs, shell)
      this.shells.add(shell)
      return this.ready
    }
    await this.ready
    if (!this.shells.has(shell)) {
      this.shells.add(shell)
      this.#send({ t: 'init', shell, tools: toolSpecs })
    }
    return this
  }

  /** Drop one agent's shell so its globals can be collected. The process stays. */
  closeShell(shell) {
    if (!this.shells.delete(shell) || !this.alive) return
    try { this.#send({ t: 'dispose', shell }) } catch { /* going away anyway */ }
  }

  async #spawn(toolSpecs, shell) {
    const [bin, ...argv] = await this.#resolveCommand()
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, argv, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
      this.proc = proc
      // The kernel captures Python-level stdout/stderr per cell, so anything arriving on fd 1/2 came from a native write (a subprocess the model spawned) or from uv provisioning. Not attributable to a cell — retained only for the crash message.
      this.nativeOutput = ''
      const drain = (chunk) => { this.nativeOutput = (this.nativeOutput + chunk).slice(-8192) }
      proc.stdout.setEncoding('utf8').on('data', drain)
      proc.stderr.setEncoding('utf8').on('data', drain)

      proc.stdio[3].setEncoding('utf8').on('data', (chunk) => this.#receive(chunk))

      // Every way the kernel can go away funnels through here. `reject` on an already-settled promise is a no-op, so late deaths cost nothing.
      const die = (why) => {
        this.dead = true
        if (this.ephemeralRoot !== undefined) {
          rm(this.ephemeralRoot, { recursive: true, force: true }).catch(() => {})
          this.ephemeralRoot = undefined
        }
        // Not every death is an exit. Model code can `os.close(3)`, and then the pipe errors here while the interpreter is still running the cell — but `dead` is now true, so `dispose()`'s `if (!this.alive) return` skips the teardown and the process outlives the harness as an orphan holding ~60-100MB. Signalling here is idempotent: after a real exit the pid is gone and `kill` is a no-op we swallow.
        if (proc.exitCode === null && proc.signalCode === null) {
          try { proc.kill('SIGKILL') } catch { /* already reaped */ }
        }
        const error = new KernelDeadError(why)
        // Cleared BEFORE rejecting: `finish` releases the event-loop hold only when it sees an empty map, and rejecting first left every one of them looking at a non-empty one — so the handles stayed reffed after the kernel was already gone.
        const waiting = [...this.pending.values()]
        this.pending.clear()
        this.#hold(false)
        for (const { reject: rejectPending } of waiting) rejectPending(error)
        reject(error)
      }
      // 'error' fires INSTEAD of 'exit' when the spawn itself fails (ENOENT). Without marking it dead here, `alive` stays true forever and every later cell is handed the corpse instead of respawning.
      proc.once('error', (error) => die(`python kernel failed to start: ${error.message}`))
      proc.once('exit', (code, signal) =>
        die(`python kernel exited (code ${code}, signal ${signal})${this.nativeOutput ? `\n${this.nativeOutput}` : ''}`))
      // A broken pipe surfaces on the stream, not on the process — and model code can `os.close(3)` at any time. Unhandled, it takes down the whole harness process, not just this kernel.
      for (const stream of [proc.stdout, proc.stderr, proc.stdio[3]]) {
        stream.on('error', (error) => die(`python kernel pipe failed: ${error.message}`))
      }

      this.onReady = resolve
      this.#hold(true) // the init handshake must not be cut short by an idle exit
      this.#send({ t: 'init', shell, tools: toolSpecs })
    })
  }

  #send(frame) {
    if (!this.alive) throw new KernelDeadError('python kernel is not running')
    this.proc.stdio[3].write(`${JSON.stringify(frame)}\n`)
  }

  #receive(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.length === 0) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      const frame = validateFrame(parsed)
      if (frame === undefined) continue
      this.#handle(frame)
    }
  }

  #handle(frame) {
    if (frame.t === 'ready') {
      if (this.pending.size === 0) this.#hold(false)
      // Which interpreter, which version, where `uv pip install` lands. Reported by the kernel rather than guessed here: the host only knows the argv it spawned, and with the default PEP 723 route it does not even know that until `uv` has resolved it.
      // The kernel can only report `sys.prefix != sys.base_prefix`, which is equally true of the user's own project venv. Whether the installs are actually disposable is something only this side knows, and the prompt states it as fact.
      this.pythonEnv = { ...frame.env, disposable: this.ephemeralRoot !== undefined }
      this.onReady?.(this)
      return
    }
    if (frame.t === 'done') {
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return // forged or late — the host answers once
      this.pending.delete(frame.id)
      entry.resolve(frame)
      return
    }
    // frame.t === 'call' — dispatch into the harness, answer exactly once.
    this.onCall(frame.name, frame.args, frame.shell).then(
      (outcome) => this.#reply(frame, outcome),
      (error) => this.#reply(frame, { ok: false, message: error?.message ?? String(error) }),
    )
  }

  #reply(frame, outcome) {
    if (!this.alive) return
    try {
      this.#send(outcome.ok
        ? { t: 'result', id: frame.id, ok: true, value: outcome.value ?? null }
        : { t: 'result', id: frame.id, ok: false, tool: frame.name, message: outcome.message ?? 'tool call failed' })
    } catch (error) {
      // This is the ONLY `#send` reached from an unguarded promise chain, and the one that serialises a tool's canonical value — model-reachable data, so a circular graph or a BigInt is enough to make `JSON.stringify` throw. Unhandled it took down the whole harness process; the cell's `await` also never settled. Answering with the failure keeps both alive.
      try {
        this.#send({ t: 'result', id: frame.id, ok: false, tool: frame.name, message: `tool result could not be serialised: ${error?.message ?? error}` })
      } catch { /* the pipe itself is gone; `die` has already rejected everything */ }
    }
  }

  /**
   * Hold / release the event loop. An idle kernel must NOT keep the harness alive (it would finish its turn and hang, and outlive it as an orphan), but a cell in flight must, or the process could exit mid-execution. So the handles are unreffed at spawn and reffed only for the duration of a cell.
   */
  #hold(active) {
    if (this.proc === undefined) return
    for (const handle of [this.proc, this.proc.stdout, this.proc.stderr, this.proc.stdio[3]]) {
      if (active) handle?.ref?.()
      else handle?.unref?.()
    }
  }

  /**
   * Run one cell. Rejects only when the kernel dies; a program exception comes back as `{ok: false, error}` so the model can self-correct from it.
   */
  async exec(code, signal, toolSpecs, shell = DEFAULT_SHELL) {
    await this.ready
    // `addEventListener('abort', …)` NEVER fires on a signal that is already aborted. Without this check, a turn cancelled while the kernel was still starting — a cold `uv` resolve takes seconds — would run its cell all the way through, side effects and all, and report success.
    if (signal?.aborted) throw signal.reason ?? new Error('aborted before the cell was dispatched')
    const id = ++this.nextExecId
    return new Promise((resolve, reject) => {
      let escalation
      const finish = (ok, arg) => {
        clearTimeout(escalation)
        signal?.removeEventListener('abort', onAbort)
        if (this.pending.size === 0) this.#hold(false)
        if (ok) resolve(arg)
        else reject(arg)
      }
      const onAbort = () => {
        this.interrupt(shell)
        // A cell parked on `await` cancels in-band. A pure CPU loop never reaches the signal handler, so kill the interpreter as the backstop; the caller respawns and the model is told state was lost.
        escalation = setTimeout(() => this.proc?.kill('SIGKILL'), this.hardInterruptMs)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve: (value) => finish(true, value), reject: (error) => finish(false, error) })
      this.#hold(true)
      try {
        this.#send({ t: 'exec', id, shell, code, tools: toolSpecs })
      } catch (error) {
        this.pending.delete(id)
        finish(false, error)
      }
    })
  }

  /** Cancel the running cell in-band; the kernel stays alive and keeps its state. */
  interrupt(shell = DEFAULT_SHELL) {
    if (!this.alive) return
    try { this.#send({ t: 'interrupt', shell }) } catch { /* dying anyway */ }
  }

  dispose() {
    if (!this.alive) return
    try { this.#send({ t: 'shutdown' }) } catch { /* dying anyway */ }
    // Mark it dead NOW, not when 'exit' eventually lands: `#send` only checks `alive`, so until then another exec or interrupt could be dispatched into a kernel that is mid-teardown, racing the SIGKILL below.
    this.dead = true
    const proc = this.proc
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000)
    proc.once('exit', () => clearTimeout(timer))
  }
}
