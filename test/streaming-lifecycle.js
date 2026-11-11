import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { Context, Service } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import plugin, { apply } from '../lib/index.js'
import { createHost } from './streaming-fixture.js'

const prompt = () => createUserMessage({ content: [{ type: 'text', text: 'Run the fixture.' }], source: { kind: 'human' } })
const finish = { type: 'finish', reason: { kind: 'tool-calls' } }
const encode = text => JSON.stringify(text).slice(1, -1)
const bothEntered = Promise.withResolvers(), entered = [], counts = new Map()
const host = await createHost({ id: 'scoped-first', streaming: false, config: { uiOnly: true },
  async *stream(request) {
    const attempt = (counts.get(request.sessionId) ?? 0) + 1
    counts.set(request.sessionId, attempt)
    const code = attempt === 1 ? `from __dsh__.tools import probe\nowner = ${JSON.stringify(request.sessionId)}\nawait probe(value=owner)\n` : 'await probe(value=owner)\n'
    yield { type: 'tool-call-delta', index: 0, id: `scoped-${attempt}`, name: 'python', argumentsDelta: '{"code":"' + encode(code) }
    if (attempt === 1) await bothEntered.promise
    yield { type: 'tool-call-delta', index: 0, id: `scoped-${attempt}`, name: 'python', argumentsDelta: '","description":"Scoped execution"}' }
    yield finish
  },
})
let second, timeout
try {
  host.ctx.tools.register(defineTool({ name: 'probe', description: 'Record the owning agent.', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute({ value }, exec) { entered.push([exec.agent.id, value]); if (entered.length === 2) bothEntered.resolve(); return value } }))
  await host.agent.ctx.plugin(plugin, { streaming: true })
  second = await host.ctx.agents.create({ sessionId: 'scoped-second', agentOptions: { provider: 'fixture', model: 'controlled' }, meta: { cwd: process.cwd() },
    setup: async (agentCtx) => { await agentCtx.plugin(plugin, { streaming: true }) } })
  timeout = setTimeout(() => bothEntered.reject(new Error('Scoped source execution timed out')), 15000)
  second.agent.followup(prompt())
  await host.run({ signal: AbortSignal.timeout(15000) })
  await second.agent.whenIdle()
  clearTimeout(timeout)
  assert.deepEqual(entered.toSorted(), [['scoped-first', 'scoped-first'], ['scoped-second', 'scoped-second']])
  for (const agent of [host.agent, second.agent]) {
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result')
    assert.notEqual(result.data.message.isError, true)
    assert.ok(events.find(event => event.type === 'user/message' && event.data.source.kind === 'python-stream' && event.data.source.phase === 'result').seq < events.find(event => event.type === 'step/end').seq)
  }
  await second.dispose()
  second = undefined
  await host.run({ signal: AbortSignal.timeout(15000) })
  assert.deepEqual(entered.at(-1), ['scoped-first', 'scoped-first'])
  console.log('PASS: concurrent agent-scoped mounts stay isolated and survive sibling disposal')
} finally { clearTimeout(timeout); bothEntered.resolve(); await second?.dispose(); await host.close() }

for (const streaming of [false, true]) {
  const sources = new Map(), server = createServer(), sockets = new Set()
  server.on('connection', peer => { sockets.add(peer); peer.on('close', () => sockets.delete(peer)); peer.resume() })
  const host = await createHost({ id: `isolated-${streaming}`, streaming, config: { hardInterruptMs: 150 },
    async *stream(request, attempt) {
      yield { type: 'tool-call-delta', index: 0, id: `isolated-${attempt}`, name: 'python', argumentsDelta: '{"description":"Verify session isolation","code":"' + encode(sources.get(request.sessionId)) }
      yield { type: 'tool-call-delta', index: 0, id: `isolated-${attempt}`, name: 'python', argumentsDelta: '"}' }
      yield finish
    },
  })
  let child, pending, timeout
  const createChild = () => host.ctx.agents.create({ sessionId: `isolated-child-${streaming}`, agentOptions: { provider: 'fixture', model: 'controlled' },
    meta: { cwd: process.cwd(), parentSession: host.agent.id } })
  const sdk = async agent => (await host.ctx.systemPrompt.assemble({ agent, scope: agent })).sections.find(section => section.name === 'py-codeact:sdk').text
  const run = async (agent, code) => {
    const before = agent.session.snapshotEvents().length
    sources.set(agent.id, code)
    agent.followup(prompt())
    await agent.whenIdle()
    const result = agent.session.snapshotEvents().slice(before).findLast(event => event.type === 'tool/result')?.data.message
    assert.ok(result, JSON.stringify(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')))
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }
  const pid = output => Number(output.match(/pid=(\d+)/)?.[1])
  // The socket keeps Python inside a synchronous recv until the test releases it; no sleep timing assumptions.
  const block = async () => {
    const connected = once(server, 'connection', { signal: AbortSignal.timeout(15000) })
    pending = run(host.agent, `import socket\nblocked = socket.create_connection(("127.0.0.1", ${server.address().port}))\nblocked.recv(1)\nblocked.close()\n`)
    return (await connected)[0]
  }
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    child = await createChild()
    assert.match(await sdk(host.agent), /The session runs in its own Python interpreter\./)
    const parentOutput = await run(host.agent, 'import os, sys\nowner = "parent"\nprint(f"pid={os.getpid()}")\nprint(f"prefix={sys.prefix}")\n')
    assert.match(await sdk(child.agent), /The session runs in its own Python interpreter\./, 'a new child must not advertise the parent environment')
    const childOutput = await run(child.agent, 'import os, sys\nowner = "child"\nprint(f"pid={os.getpid()}")\nprint(f"prefix={sys.prefix}")\n')
    const parentPid = pid(parentOutput), childPid = pid(childOutput)
    const parentEnv = parentOutput.match(/prefix=([^\n]+)/)[1], childEnv = childOutput.match(/prefix=([^\n]+)/)[1]
    assert.notEqual(parentEnv, childEnv)
    for (const [agent, own, other] of [[host.agent, parentEnv, childEnv], [child.agent, childEnv, parentEnv]]) {
      const prompt = await sdk(agent)
      assert.ok(prompt.includes(own), 'the prompt must identify this session environment')
      assert.ok(!prompt.includes(other), 'the prompt must not identify another session environment')
    }
    assert.ok(parentPid > 0 && childPid > 0)
    assert.notEqual(parentPid, childPid, 'an unrestricted child must own a separate process')
    let peer = await block()
    try {
      const responsive = await Promise.race([run(child.agent, 'print(owner, os.getpid())\n'), once(peer, 'close').then(() => { throw new Error('parent stopped before the child ran') }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('parent blocked the child interpreter')), 5000) })])
      assert.match(responsive, new RegExp(`child ${childPid}`), 'child state survives across turns while the parent blocks')
    } finally { clearTimeout(timeout); peer.end('x'); await pending }
    assert.match(await run(host.agent, 'print(owner, os.getpid())\n'), new RegExp(`parent ${parentPid}`), 'the same session retains its interpreter')
    peer = await block()
    host.agent.cancel({ kind: 'user' })
    await pending
    assert.match(await sdk(host.agent), /The session runs in its own Python interpreter\./, 'a dead interpreter must not advertise its deleted environment')
    assert.match(await run(child.agent, 'print(owner, os.getpid())\n'), new RegExp(`child ${childPid}`), 'a parent hard kill must preserve the child interpreter')
    const restarted = await run(host.agent, 'import os\nprint("owner" in globals())\nprint(f"pid={os.getpid()}")\n')
    assert.match(restarted, /False/)
    assert.notEqual(pid(restarted), parentPid, 'a synchronous cell requires a hard kill')
    await run(host.agent, 'owner = "restored"\n')
    await child.dispose()
    child = undefined
    assert.match(await run(host.agent, 'print(owner)\n'), /restored/, 'disposing another session must preserve this interpreter')
    child = await createChild()
    assert.match(await sdk(child.agent), /The session runs in its own Python interpreter\./, 'a disposed interpreter must not leak into its replacement prompt')
    const recreated = await run(child.agent, 'import os\nprint("owner" in globals())\nprint(f"pid={os.getpid()}")\n')
    assert.match(recreated, /False/, 'reusing a disposed session identity starts fresh')
    assert.notEqual(pid(recreated), childPid)
    console.log(`PASS: ${streaming ? 'streaming' : 'whole-cell'} parent/child kernels isolate blocking, hard kills, and disposal while retaining session state`)
  } finally {
    clearTimeout(timeout)
    for (const peer of sockets) peer.destroy()
    host.agent.cancel({ kind: 'user' })
    await pending?.catch(() => {})
    await child?.dispose()
    await host.close()
    await new Promise(resolve => server.close(resolve))
  }
}

const ctx = new Context(), waiting = Promise.withResolvers(), release = Promise.withResolvers()
class DelayedProjections extends SessionProjectionRegistry {
  async register(definition) {
    const handle = await super.register(definition)
    waiting.resolve()
    await release.promise
    return handle
  }
}
try {
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(class Policy extends Service { constructor(ctx) { super(ctx, 'sandboxPolicy') } })
  await ctx.plugin(DelayedProjections)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolsService)
  const llm = await ctx.plugin(LlmRuntime)
  const pending = ctx.plugin({ ...plugin, name: 'pending-streaming', apply: (child) => apply(child, { streaming: true }) })
  await waiting.promise
  const disposal = pending.dispose()
  release.resolve()
  await disposal
  await Promise.resolve(pending).catch(() => {})
  assert.equal(ctx.tools.definitions().length, 0)
  const replacement = await ctx.plugin({ ...plugin, name: 'replacement-streaming', apply: (child) => apply(child, { streaming: true }) })
  assert.ok(ctx.tools.definitions().some(tool => tool.name === 'python'))
  await replacement.update({ streaming: true })
  assert.equal(ctx.tools.definitions().filter(tool => tool.name === 'python').length, 1)
  await llm.dispose()
  assert.equal(ctx.tools.definitions().length, 0, 'dependent tools must unload with the LLM service')
  await ctx.plugin(LlmRuntime)
  for (let tries = 0; !ctx.tools.definitions().some(tool => tool.name === 'python'); tries++) {
    assert.ok(tries < 100, 'streaming did not reactivate after its service returned')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await replacement.dispose()
  assert.equal(ctx.tools.definitions().length, 0)
  console.log('PASS: HMR and required-service replacement release and recreate streaming effects')
  console.log('PASS: disposal during projection registration leaves no late tools or stale registrations')
} finally { release.resolve(); await ctx.fiber.dispose() }
