import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

// Test the published integration surface: registry DSH, a packed plugin, and its actual browser client.
const repository = fileURLToPath(new URL('../', import.meta.url)), version = '0.2.2-rc.1'
// Linux confinement replaces /tmp, so the packed worker and its interpreter must remain outside it.
const requestedDirectory = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(homedir(), '.codeact-web-'))
await mkdir(requestedDirectory, { recursive: true })
const directory = await realpath(requestedDirectory)
const marker = join(directory, '.codeact-web')
if ((await readdir(directory)).length) assert.equal(await readFile(marker, 'utf8'), 'owned\n', 'refusing an unrelated directory')
else await writeFile(marker, 'owned\n')
const env = { ...process.env, DSH_HOME: join(directory, 'home'), AGENTS_HOME: join(directory, 'agents'), DSH_PERMISSION_MODE: 'danger-full-access' }
const children = new Set()
let browser, succeeded = false

async function run(command, args, cwd = directory) {
  console.log(`Running ${command} ${args.join(' ')}`)
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 300000)
  let code
  try { [code] = await once(child, 'exit') } finally { clearTimeout(timer) }
  children.delete(child)
  assert.equal(code, 0, `${command} failed:\n${output}`)
  return output
}

async function until(read, predicate, message, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await delay(50)
  }
  throw new Error(message)
}

async function rows(path) {
  try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

async function exists(path) {
  try { await readFile(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

async function stop(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) { children.delete(child); return }
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
  try { await exited } finally { clearTimeout(timer); children.delete(child) }
}

async function start(caseDirectory) {
  const child = spawn(process.execPath, [join(directory, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: caseDirectory, env: { ...env, DSH_HOME: join(caseDirectory, 'home'), CODEACT_WEB_CASE: caseDirectory }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('error', error => { output += String(error) })
  const url = await until(() => {
    assert.ok(child.exitCode === null && child.signalCode === null, `DSH exited before startup:\n${output}`)
    return output.match(/dsh web: (http:\/\/\S+)/)?.[1]
  }, Boolean, `DSH did not start; see ${join(caseDirectory, 'host.log')}`).catch(async error => {
    await writeFile(join(caseDirectory, 'host.log'), output)
    throw error
  })
  return { child, url, async close() { await stop(child); await writeFile(join(caseDirectory, 'host.log'), output) } }
}

async function expand(page, closed = false) {
  if (closed) await page.locator('[data-turn-process]').first().waitFor({ state: 'visible' })
  for (const selector of ['[data-turn-process]', '[data-process-activity]']) {
    for (const control of await page.locator(`${selector}[aria-expanded="false"]`).all()) if (await control.isVisible()) await control.click()
  }
}

async function inspect(page, callId) {
  const child = page.locator(`[data-chat-call-id="${callId}"]`)
  await child.locator('[data-sample="bash"]').click()
  await child.getByRole('button', { name: 'Inspect', exact: true }).click()
  const selected = page.locator('tr[aria-selected="true"]')
  await selected.filter({ hasText: 'bash' }).waitFor()
  const key = await selected.getAttribute('data-trajectory-row-key')
  assert.ok(key && decodeURIComponent(key).includes(callId), 'Inspect selected another call')
  await page.getByRole('complementary', { name: 'Event details' }).waitFor()
  await page.getByRole('tab', { name: 'Result', exact: true }).click()
  await page.getByRole('region', { name: 'Rendered result', exact: true }).getByText(/CODEACT_INSPECT/).waitFor()
  return key
}

try {
  await run('bun', ['pm', 'pack', '--destination', directory], repository)
  const plugin = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  const packed = join(directory, `dsh-py-codeact-${plugin.version}.tgz`)
  const tarball = `codeact-${createHash('sha256').update(await readFile(packed)).digest('hex')}.tgz`
  await cp(packed, join(directory, tarball))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    ...Object.fromEntries(Object.keys(plugin.peerDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-')).map(name => [name, version])),
    '@deepseek-ai/dsh': version, '@deepseek-ai/cordis': '4.1.0', '@deepseek-ai/schemastery': '3.19.0', 'dsh-py-codeact': `file:./${tarball}`, playwright: '1.61.1',
  } }))
  // DSH's package manager installs private copies, never links to a global Bun cache or installation.
  await run('pnpm', ['install', '--ignore-scripts', '--store-dir', join(directory, 'store'), '--package-import-method', 'copy', '--node-linker', 'hoisted', '--registry', 'https://registry.npmjs.org'])
  const require = createRequire(join(directory, 'package.json'))
  const identities = {}
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-client-ui-trajectory', 'dsh-py-codeact']) {
    const manifest = await realpath(require.resolve(`${name}/package.json`))
    assert.ok(manifest.startsWith(directory + sep), `${name} resolved outside the isolated install`)
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    if (name.startsWith('@deepseek-ai/')) assert.equal(metadata.version, version)
    const entry = join(dirname(manifest), name === '@deepseek-ai/dsh' ? 'lib/bin.js' : 'lib/client.js')
    identities[name] = { version: metadata.version, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') }
  }
  await writeFile(join(directory, 'installed.json'), JSON.stringify(identities, null, 2))
  await cp(new URL('./web-fixture.js', import.meta.url), join(directory, 'fixture.js'))
  const { chromium } = require('playwright')
  await run(process.execPath, [join(dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'])
  browser = await chromium.launch()

  const failures = []
  let approvalCommandVisible
  for (const mode of ['whole', 'stream', 'stop', 'approval-whole', 'approval']) {
    const streaming = !['whole', 'approval-whole'].includes(mode), needsApproval = mode.startsWith('approval')
    const caseDirectory = join(directory, mode), profile = join(caseDirectory, 'home/profiles/web')
    await rm(caseDirectory, { recursive: true, force: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-py-codeact'] } } }))
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
      ...['session-title-llm', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai'].map(id => ({ id, disabled: true })),
      { id: 'directory-picker', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'workspace-controller', config: { documentsDirectory: caseDirectory } },
      { id: 'sandbox-policy', config: { mode: needsApproval ? 'workspace-write' : 'danger-full-access', workspaceRoot: caseDirectory } },
      { id: 'approval', config: { policy: 'ask' } },
      { id: 'agent-default-model', config: { provider: 'codeact-web', model: 'controlled' } },
      { id: 'agent-preset-registry', config: { default: 'codeact-web' } },
      { id: 'py-codeact-settings', config: { streaming } },
      { id: 'ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } },
      { insert: [
        { id: 'codeact-web-fixture', name: join(directory, 'fixture.js') },
        { id: 'preset-codeact-web', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'codeact-web', name: 'CodeAct', plugins: [
          { name: '@deepseek-ai/dsh-tool-bash', config: { enableRunInBackground: false } }, { name: 'dsh-py-codeact', config: { mode: 'code' } },
        ] } },
      ] },
    ]))
    let host = await start(caseDirectory)
    let page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.goto(host.url)
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill('Verify the CodeAct web fixture.')
      await input.press('Enter')
      await until(() => exists(join(caseDirectory, 'prefix-ready')), Boolean, 'provider prefix was not delivered')
      const effects = () => rows(join(caseDirectory, 'effects.jsonl'))
      const inspectedCall = () => rows(join(caseDirectory, 'bash.jsonl')).then(calls => calls.find(call => call.type === 'tool/ptc-dispatch' && call.arguments.command === 'printf CODEACT_INSPECT'))
      let inspected, selectedKey
      if (!streaming) assert.deepEqual(await effects(), [], 'whole-cell mode executed before provider EOF')
      else await until(effects, values => values.length === 1, 'the streaming prefix did not execute')
      await expand(page)
      const card = page.locator('[data-tool="python"]')
      await card.getByText('CodeAct', { exact: true }).waitFor()
      await card.getByText('Verify incremental execution', { exact: true }).waitFor()
      if (streaming) {
        const owner = page.locator('[data-chat-call-id="codeact-web-call"]'), [first] = await effects()
        assert.equal(await owner.count(), 1, 'the streaming parent must not split into separate cards')
        await owner.locator('[data-tool="python"]').getByText('CodeAct', { exact: true }).waitFor()
        await owner.locator(`[data-chat-call-id="${first.callId}"]`).waitFor()
        inspected = await until(inspectedCall, Boolean, 'native bash did not settle before provider EOF')
        assert.equal(inspected.isError, false)
        selectedKey = await inspect(page, inspected.subCallId)
      }
      const approval = page.locator('[data-approval-key]'), command = 'printf CODEACT_APPROVED >> approval-effects'
      let approvalKey
      if (needsApproval && streaming) {
        await approval.getByRole('button', { name: 'Allow once', exact: true }).waitFor()
        approvalKey = await approval.getAttribute('data-approval-key')
        assert.equal(await exists(join(caseDirectory, 'approval-effects')), false)
      }
      if (mode === 'stop') await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
      else await writeFile(join(caseDirectory, 'release'), '')
      if (needsApproval) {
        await until(() => exists(join(caseDirectory, 'parent-ready')), Boolean, 'the complete parent call was not committed')
        await approval.getByRole('button', { name: 'Allow once', exact: true }).waitFor()
        if (approvalKey) assert.equal(await approval.getAttribute('data-approval-key'), approvalKey)
        await approval.getByText(/Verify native approval with a marker in the test directory/).waitFor()
        const visible = await approval.getByText(command, { exact: true }).isVisible()
        // The official host currently omits nested commands. Streaming must preserve the whole-cell approval presentation.
        if (!streaming) approvalCommandVisible = visible
        else assert.equal(visible, approvalCommandVisible, 'streaming changed native approval command visibility')
        assert.equal(await exists(join(caseDirectory, 'approval-effects')), false, 'the command executed before approval')
        await approval.getByRole('button', { name: 'Allow once', exact: true }).click()
      }
      const settled = await until(() => rows(join(caseDirectory, 'settled.json')), values => values.length === 1, 'the turn did not settle')
      assert.equal(settled[0].reason.kind, mode === 'stop' ? 'aborted' : 'completed')
      assert.deepEqual((await effects()).map(({ value }) => value), mode === 'stop' ? ['FIRST'] : ['FIRST', 'LAST'])
      assert.equal(new Set((await effects()).map(({ callId }) => callId)).size, (await effects()).length)
      const [firstDispatch] = await rows(join(caseDirectory, 'probe-starts.jsonl'))
      assert.equal(firstDispatch.callId, (await effects())[0].callId)
      if (mode === 'stop') assert.equal(await exists(join(caseDirectory, 'parent-ready')), false)
      else assert.equal(firstDispatch.seq < JSON.parse(await readFile(join(caseDirectory, 'parent-ready'), 'utf8')).seq, streaming, 'execution order must match the streaming setting')
      assert.equal((await rows(join(caseDirectory, 'requests.jsonl'))).length, mode === 'stop' ? 1 : 2)
      if (selectedKey) assert.equal(await page.locator('tr[aria-selected="true"]').getAttribute('data-trajectory-row-key'), selectedKey, 'parent arrival or cancellation lost the selected child')
      if (needsApproval) assert.equal(await readFile(join(caseDirectory, 'approval-effects'), 'utf8'), 'CODEACT_APPROVED')
      if (mode === 'stop') assert.equal(await exists(join(caseDirectory, 'approval-effects')), false, 'Stop executed the pending command')
      await page.getByRole('tab', { name: 'Chat', exact: true }).click()
      await expand(page, true)
      if (mode !== 'stop') {
        await card.getByText('CodeAct', { exact: true }).click()
        await card.getByText(/CODEACT_WEB_COUNTER 1/).waitFor()
      }
      inspected ??= await until(inspectedCall, Boolean, 'native bash did not settle')
      if (!selectedKey) selectedKey = await inspect(page, inspected.subCallId)
      const previous = await effects(), requests = await rows(join(caseDirectory, 'requests.jsonl'))
      await page.close()
      await host.close()
      host = await start(caseDirectory)
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(host.url)
      await page.getByText('Verify the CodeAct web fixture.', { exact: true }).first().click()
      await expand(page, true)
      // An aborted prefix has no persisted complete arguments; its known Python parent and children still survive.
      await page.locator('[data-tool="python"]').getByText('CodeAct', { exact: true }).waitFor()
      if (mode !== 'stop') await page.getByText('Verify incremental execution', { exact: true }).waitFor()
      assert.equal(await inspect(page, inspected.subCallId), selectedKey, 'cold history changed the inspected call identity')
      assert.deepEqual(await effects(), previous, 'cold restoration replayed side effects')
      assert.deepEqual(await rows(join(caseDirectory, 'requests.jsonl')), requests, 'cold restoration unexpectedly requested a model')
      assert.deepEqual(errors, [], 'the actual Web client raised an exception')
      console.log(`PASS official DSH ${version}: ${mode}`)
    } catch (error) {
      await page.screenshot({ path: join(caseDirectory, 'failure.png'), fullPage: true }).catch(() => {})
      await writeFile(join(caseDirectory, 'browser.txt'), await page.locator('body').innerText().catch(() => ''))
      failures.push(new Error(`${mode}: ${error.message}`, { cause: error }))
      console.error(`FAIL official DSH ${version}: ${mode}: ${error.message}`)
    } finally { await page.close(); await host.close() }
  }
  if (failures.length) throw new AggregateError(failures, 'official DSH Web regression')
  succeeded = true
} finally {
  await browser?.close()
  await Promise.all([...children].map(stop))
  if (!process.argv[2] && succeeded) await rm(directory, { recursive: true, force: true })
  else console.log(`Web test artifacts: ${directory}`)
}
