import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { apply } from '../lib/index.js'
import { PythonKernel } from '../lib/kernel.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-policy-test-'))
const previousCredential = process.env.DATABASE_URL
process.env.DATABASE_URL = 'dsh-test-ambient-credential'
const host = new Context()
const sandbox = new LocalSandbox(host, LocalSandbox.Config({}))
const subprocess = new LocalSubprocess(host)
const listeners = new Map(), confined = []
let python, mode = 'read-only', effectiveCwd = root
effectiveCwd = join(root, 'nested')
await mkdir(effectiveCwd)
const session = (id, parentSession) => ({ id, header: { version: 4, cwd: root, parentSession }, append() {}, deriveMessages: () => [] })
const parent = { id: 'policy-parent', session: session('policy-parent') }
const child = { id: 'policy-child', session: session('policy-child', parent.id) }
const ctx = {
  subprocess,
  on: (name, listener) => listeners.set(name, listener), effect: (effect) => effect(),
  systemPrompt: { section() {} },
  workingDirectory: { ensure: async () => effectiveCwd },
  sandboxPolicy: { resolve: ({ session }) => ({ mode, workspaceRoot: root, sessionId: session.id }) },
  sandbox: { confine: async (argv, policy, signal) => { confined.push(policy); return sandbox.confine(argv, policy, signal) } },
  tools: { register: (tool) => { python = tool }, sdkSchemas: () => [] },
}
const run = (code, agent = parent) => python.execute({ code, description: 'Verify execution policy' },
  { agent, callId: 'policy-cell', rootCallId: 'policy-cell', signal: AbortSignal.timeout(30000), deferContext() {} })
apply(ctx, { mode: 'both' })
try {
  assert.match(await run('import os\nos.getcwd()'), /nested/, 'new kernels use the effective working directory')
  assert.match(await run('"DATABASE_URL" in os.environ'), /False/, 'managed subprocesses retain the credential allowlist')
  const file = join(root, 'denied.txt')
  const denied = await run(`from pathlib import Path\nPath(${JSON.stringify(file)}).write_text("denied")`)
  assert.match(denied, /PermissionError|Operation not permitted|Read-only file system/)
  await assert.rejects(access(file), { code: 'ENOENT' })
  assert.equal(confined[0].mode, 'read-only')
  await run('remembered = 42')
  assert.match(await run('remembered'), /42/, 'state persists under an unchanged policy')
  assert.match(await run('"remembered" in globals()', child), /False/, 'confined child gets a separate kernel')
  assert.equal(confined.length, 2)
  assert.equal(confined[1].sessionId, child.id)

  mode = 'workspace-write'
  const changing = listeners.get('session/event')(parent.session, { type: 'sandbox/mode' })
  const reset = await run('"remembered" in globals()')
  await changing
  assert.match(reset, /False/, 'policy changes discard the previous kernel')
  assert.match(reset, /interpreter was restarted/, 'the first cell after a policy change reports lost state')
  assert.match(await run(`Path = __import__("pathlib").Path\nPath(${JSON.stringify(file)}).write_text("allowed")`), /7/)
  await access(file)
  assert.equal(confined.at(-1).mode, 'workspace-write')

  mode = 'danger-full-access'
  await listeners.get('session/event')(parent.session, { type: 'sandbox/mode' })
  const wraps = confined.length
  await run('import os\nparent_pid = os.getpid()')
  assert.match(await run('import os\nos.getpid()', child), new RegExp(await run('parent_pid')))
  assert.equal(confined.length, wraps, 'explicit unrestricted execution bypasses confinement')

  const descendant = await run('import asyncio, sys\nchild = await asyncio.create_subprocess_exec(sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(\'ready\', flush=True); time.sleep(600)", stdout=asyncio.subprocess.PIPE)\nawait child.stdout.readline()\nchild.pid')
  const pid = Number(descendant.trim().split('\n').at(-1))
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  mode = 'read-only'
  await listeners.get('session/event')(parent.session, { type: 'sandbox/mode' })
  const status = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  assert.ok(status.status === 1 || (status.status === 0 && status.stdout.trim().startsWith('Z')), 'permission changes terminate even descendants that ignore SIGTERM')

  await listeners.get('dispose')()
  ctx.sandboxPolicy = undefined
  await assert.rejects(run('1'), /sandboxPolicy is required/)
  ctx.sandboxPolicy = { resolve: () => ({ mode: 'read-only', workspaceRoot: root }) }
  ctx.sandbox = undefined
  await assert.rejects(run('1'), /sandbox provider is required/)
  ctx.subprocess = undefined
  await assert.rejects(run('1'), /subprocess provider is required/)
  ctx.subprocess = subprocess
  ctx.sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }
  apply(ctx, { mode: 'both', command: ['dsh-python-test-nonexistent-binary'] })
  await assert.rejects(run('1'), { name: 'KernelDeadError' })
  console.log('  ok   real sandbox read-only/workspace-write, policy reset, session isolation, explicit bypass and fail-closed execution')
} finally {
  if (previousCredential === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = previousCredential
  await listeners.get('dispose')()
  await host.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

// Disposing while provisioning is in flight must not launch an interpreter afterwards.
let release, entered
const blocked = new Promise((resolve) => { release = resolve })
const reached = new Promise((resolve) => { entered = resolve })
const starting = new PythonKernel({ command: ['must-not-exist'], prepareSpawn: async (argv) => { entered(); await blocked; return argv } })
const startup = starting.start([])
await reached
await starting.dispose({ force: true })
release()
await assert.rejects(startup, /disposed before startup/)
assert.equal(starting.proc, undefined)
console.log('  ok   disposal during provisioning prevents a late process launch')
