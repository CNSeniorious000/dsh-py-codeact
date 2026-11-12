import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const component = ({ children }) => children
function elements(node) { return node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(elements)] : [] }

function loadClient(ui, useState = () => [false, () => {}]) {
  let loaded
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
    document: { querySelector: () => null },
  })
  assert.equal(loaded.id, 'dsh-py-codeact')
  const React = {
    Fragment: component,
    useState,
    createElement(type, props, ...children) {
      assert.ok(typeof type === 'function' || typeof type === 'string', `invalid React element: ${String(type)}`)
      return { type, props: { ...props, children } }
    },
  }
  return loaded.factory((name) => name === 'react' ? React : ui)
}

for (const icons of [
  ['IconCodeOutline16', 'IconInspectOutline12'], // pre-0.2 hosts
  ['IconCodeOutlineRegular', 'IconInspectOutlineRegular'], // 0.2.0-rc.1 and 0.2.1-alpha.1
]) {
  const ui = { CodeBlock: component, DisclosureRow: component, StateDot: component }
  for (const name of icons) ui[name] = component
  const client = loadClient(ui)
  let view
  client.apply({ inject() {}, slots: {
    inject(_name, callback) { callback() },
    register(slot, render) {
      assert.equal(slot.locale, 'conversation')
      view = (props) => render({ t: (key) => `en:${key}`, ...props })
    },
  } })
  assert.equal(typeof view, 'function')
  const row = view({ toolName: 'python', block: { argsRaw: JSON.stringify({ code: 'print(1)' }) }, inspect() {} })
  assert.equal(row.type.name, 'CodeActCard')
  const card = row.type(row.props)
  assert.equal(card.props['data-tool'], 'python')
  assert.equal(elements(card).find(node => node.props?.title === 'CodeAct').props.collapsedContent, undefined)
  for (const description of [undefined, '', '   ', 'Read', 'Read streamed arguments']) {
    const codeFirst = view({ toolName: 'python', block: { phase: 'preparing', args: { text: key => ({ code: 'await probe()', description })[key] } } })
    const nodes = elements(codeFirst.type(codeFirst.props)), disclosure = nodes.find(node => node.props?.title === 'CodeAct')
    if (description?.trim()) {
      const summary = elements(disclosure.props.collapsedContent).find(node => node.props?.className === 'summary')
      assert.equal(summary.props.children.join(''), description)
    } else assert.equal(disclosure.props.collapsedContent, undefined, 'code must not become a placeholder description')
    assert.equal(nodes.find(node => node.props?.lang === 'python').props.code, 'await probe()')
  }
  const partial = view({ toolName: 'python', block: { phase: 'preparing', args: { text: (key) => ({ code: 'await probe()', description: 'Read streamed arguments' })[key] } } })
  const preparing = JSON.stringify(partial.type(partial.props))
  assert.match(preparing, /Read streamed arguments/)
  assert.match(preparing, /await probe\(\)/)
  const descriptionOnly = view({ toolName: 'python', block: { phase: 'preparing', argsRaw: '{"description":"Describe first"', args: { text: (key) => key === 'description' ? 'Describe first' : undefined } } })
  const emptySource = JSON.stringify(descriptionOnly.type(descriptionOnly.props))
  assert.match(emptySource, /Describe first/)
  assert.doesNotMatch(emptySource, /"lang":"python"/, 'a description-only native reader must not display raw JSON as Python')
  const legacy = view({ t: (key) => key, toolName: 'python', block: { kind: 'tool', content: [{ type: 'text', text: '1' }] }, inspect() {} })
  const legacyText = JSON.stringify(legacy.type(legacy.props))
  assert.match(legacyText, /"OUT"/)
  assert.match(legacyText, /"Inspect"/)
  assert.doesNotMatch(legacyText, /row\.(output|inspect)/)
  for (const locale of ['en', 'zh']) {
    for (const [state, fields, status] of [
      ['running', {}, 'row.running'],
      ['error', { kind: 'tool', isError: true }, 'row.failed'],
      ['stopped', { kind: 'tool', error: { code: 'interrupted' } }, 'row.stopped'],
      ['ok', { kind: 'tool' }, null],
    ]) {
      const raw = JSON.stringify({ code: 'print(1)', description: 'Keep the model description' })
      const rendered = view({ t: (key) => `${locale}:${key}`, toolName: 'python', block: { argsRaw: raw, call: { argsRaw: raw }, content: [{ type: 'text', text: '1' }], ...fields }, inspect() {} })
      const tree = rendered.type(rendered.props), nodes = elements(tree), json = JSON.stringify(tree)
      assert.equal(tree.props['data-state'], state)
      assert.ok(json.includes('CodeAct'))
      if (state !== 'error') assert.ok(json.includes('Keep the model description'))
      if (status) assert.ok(json.includes(`${locale}:${status}`))
      if (state !== 'running') assert.ok(json.includes(`${locale}:row.output`))
      assert.ok(json.includes(`${locale}:row.inspect`))
      const code = nodes.find((node) => node.props?.lang === 'python').props
      assert.equal(code.copyLabel, `${locale}:copy`)
      assert.equal(code.copiedLabel, `${locale}:copied`)
      assert.equal(code.toolbarLabels.codeLabel, `${locale}:codeBlock.title`)
      assert.equal(code.toolbarLabels.wrapLabel, `${locale}:codeBlock.wrap`)
      assert.equal(code.toolbarLabels.unwrapLabel, `${locale}:codeBlock.unwrap`)
    }
  }
  console.log(`client render: ${icons.join(' + ')} ok`)
}

// Native form writes must settle before the toggle reflects a newly accepted value.
const state = []
let cursor = 0
const ui = { Switch() {} }
const client = loadClient(ui, (initial) => {
  const index = cursor++
  if (!(index in state)) state[index] = initial
  return [state[index], (value) => { state[index] = value }]
})
let snapshot = { status: 'ready', writable: true, value: {} }, finish, fail
const writes = [], views = new Map(), slots = new Map()
let dictionaries, language = 'en'
const form = {
  getSnapshot: () => snapshot,
  set(field, value) { writes.push([field, value]); return new Promise((resolve, reject) => { finish = resolve; fail = reject }) },
}
const ctx = {
  effect: (callback) => callback(),
  inject(_services, callback) { callback(ctx) },
  locale: { register(namespace, locales) { assert.equal(namespace, 'pyCodeAct'); dictionaries = locales; return () => {} } },
  slots: {
    inject(_name, callback) { return callback() },
    register(slot, view) { slots.set(slot.name, slot); views.set(slot.name, view); return () => views.delete(slot.name) },
  },
  configForms: {
    get(id) { assert.equal(id, 'py-codeact-settings'); return form },
    whileServed(ids, register) { assert.equal(ids.join(), 'py-codeact-settings'); return register() },
  },
}
client.apply(ctx)
assert.ok(views.has('tool.call.toolview'))
assert.equal(slots.get('plugins.bundle.config').locale, 'pyCodeAct')
assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
const injected = slots.get('plugins.bundle.config').inject()
assert.equal(injected.hooks.settings, form)
const settings = views.get('plugins.bundle.config')({ view: 'page', useSettings: (select) => select(injected.hooks.settings.getSnapshot()), setSetting: injected.setSetting, t: (key) => dictionaries[language][key] })
function render() { cursor = 0; return settings.type(settings.props) }
const toggle = () => elements(render()).find((node) => node.type === ui.Switch)
const concurrencyToggle = () => elements(render()).filter((node) => node.type === ui.Switch)[1]
assert.equal(concurrencyToggle().props.checked, false)
assert.match(JSON.stringify(render()), /official PTC/)
assert.equal(toggle().props.checked, false)
assert.equal(toggle().props.disabled, false)
const changing = toggle().props.onChange(true)
assert.deepEqual(writes, [['streaming', true]])
assert.equal(toggle().props.checked, false)
assert.equal(toggle().props.disabled, true)
snapshot = { ...snapshot, value: { streaming: true } }
finish(true)
await changing
assert.equal(toggle().props.checked, true)
assert.equal(toggle().props.disabled, false)
const concurrencyChange = concurrencyToggle().props.onChange(true)
assert.deepEqual(writes.at(-1), ['respectToolConcurrency', true])
assert.equal(concurrencyToggle().props.checked, false)
snapshot = { ...snapshot, value: { streaming: true, respectToolConcurrency: true } }
finish(true)
await concurrencyChange
assert.equal(concurrencyToggle().props.checked, true)
const rejected = toggle().props.onChange(false)
finish(false)
await rejected
assert.equal(toggle().props.checked, true)
assert.match(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), /not saved/)
language = 'zh'
assert.equal(toggle().props.label, '流式执行')
assert.equal(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), '设置未保存，请重试。')
language = 'en'
const failed = toggle().props.onChange(false)
fail(new Error('offline'))
await failed
assert.match(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), /Could not save/)
language = 'zh'
assert.equal(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), '无法保存设置，请重试。')
snapshot = { ...snapshot, writable: false }
assert.equal(toggle().props.disabled, true)
assert.equal(elements(render()).find((node) => node.props?.role === 'status').props.children.join(), '这些设置为只读。')
snapshot = { ...snapshot, writable: true, status: 'unavailable' }
assert.equal(toggle().props.disabled, true)
assert.equal(elements(render()).find((node) => node.props?.role === 'status').props.children.join(), 'CodeAct 设置不可用。')
snapshot = { ...snapshot, status: 'loading' }
assert.equal(elements(render()).find((node) => node.props?.role === 'status').props.children.join(), '正在加载设置…')
console.log('client settings: accepted values, pending writes, refusals, errors and unavailable forms ok')
