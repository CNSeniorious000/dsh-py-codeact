import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'codeact-web-fixture'
export const inject = ['llm', 'tools', 'sessions', 'workspaceRegistry']

export async function apply(ctx) {
  const directory = process.env.CODEACT_WEB_CASE
  assert.ok(directory, 'the fixture needs its own case directory')
  await ctx.workspaceRegistry.initializeDefault(async () => directory)
  const record = (file, value) => appendFile(join(directory, file), JSON.stringify(value) + '\n')
  let requests = 0
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') return writeFile(join(directory, 'settled.json'), JSON.stringify({ sessionId: session.id, reason: event.data.reason }))
    if (event.type === 'tool/call') return writeFile(join(directory, 'parent-ready'), JSON.stringify({ seq: event.seq }))
    if (event.type === 'tool/ptc-dispatch-start' && event.data.name === 'fixture_probe') return record('probe-starts.jsonl', { seq: event.seq, callId: event.data.subCallId })
    if (event.type.startsWith('approval/')) return record('approvals.jsonl', { type: event.type, ...event.data })
    if (['tool/ptc-dispatch-start', 'tool/ptc-dispatch'].includes(event.type) && event.data.name === 'bash') return record('bash.jsonl', { type: event.type, ...event.data })
  })
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'fixture_probe', description: 'Record one test effect.', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ value }, exec) {
      assert.ok(exec.parent, 'a Python subcall must retain its execution parent')
      await record('effects.jsonl', { value, callId: exec.callId, rootCallId: exec.rootCallId })
      return value
    },
  })))
  class FixtureAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'CodeAct test' } }
    async listModels(provider) { return [{ provider, id: 'controlled', name: 'CodeAct test' }] }
    async *stream(request) {
      assert.equal(request.purpose, undefined, 'the test must not issue auxiliary model requests')
      await record('requests.jsonl', { request: ++requests, sessionId: request.sessionId })
      if (requests === 2) {
        yield { type: 'text-delta', index: 0, text: 'CODEACT_WEB_DONE' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      assert.equal(requests, 1, 'unexpected retry or replay')
      const encode = text => JSON.stringify(text).slice(1, -1)
      const delta = argumentsDelta => ({ type: 'tool-call-delta', index: 0, id: 'codeact-web-call', name: basename(directory) === 'custom-stop' ? 'execute_python' : 'python', argumentsDelta })
      const approval = basename(directory).startsWith('approval')
      const prefix = "from __dsh__.tools import fixture_probe, bash\nweb_counter = globals().get('web_counter', 0) + 1\nawait fixture_probe(value='FIRST')\n"
        + "await bash(command='printf CODEACT_INSPECT', description='Print the CodeAct inspection marker')\n"
        + (approval ? "await bash(command='printf CODEACT_APPROVED >> approval-effects', description='Write the CodeAct approval marker', sandbox_permissions='danger-full-access', justification='Verify native approval with a marker in the test directory.')\n" : '')
      const suffix = "await fixture_probe(value='LAST')\nprint('CODEACT_WEB_COUNTER', web_counter)\n"
      yield delta('{"description":"Verify incremental execution","code":"' + encode(prefix))
      await writeFile(join(directory, 'prefix-ready'), '')
      // The browser releases provider EOF only after observing the prefix's real effects.
      const signal = AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(120000)])
      while (true) {
        signal.throwIfAborted()
        try { await readFile(join(directory, 'release')); break } catch (error) { if (error.code !== 'ENOENT') throw error }
        await delay(25, undefined, { signal })
      }
      yield delta(encode(suffix) + '"}')
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['codeact-web'], new FixtureAdapter()))
}
