import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const component = ({ children }) => children

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
    register(_slot, render) { view = render },
  } })
  assert.equal(typeof view, 'function')
  const row = view({ toolName: 'python', block: { argsRaw: JSON.stringify({ code: 'print(1)' }) }, inspect() {} })
  assert.equal(row.type.name, 'CodeActCard')
  const card = row.type(row.props)
  assert.equal(card.props['data-tool'], 'python')
  const partial = view({ toolName: 'python', block: { phase: 'preparing', args: { text: (key) => ({ code: 'await probe()', description: 'Read streamed arguments' })[key] } } })
  const preparing = JSON.stringify(partial.type(partial.props))
  assert.match(preparing, /Read streamed arguments/)
  assert.match(preparing, /await probe\(\)/)
  const descriptionOnly = view({ toolName: 'python', block: { phase: 'preparing', argsRaw: '{"description":"Describe first"', args: { text: (key) => key === 'description' ? 'Describe first' : undefined } } })
  const emptySource = JSON.stringify(descriptionOnly.type(descriptionOnly.props))
  assert.match(emptySource, /Describe first/)
  assert.doesNotMatch(emptySource, /"lang":"python"/, 'a description-only native reader must not display raw JSON as Python')
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
const form = {
  getSnapshot: () => snapshot,
  set(field, value) { writes.push([field, value]); return new Promise((resolve, reject) => { finish = resolve; fail = reject }) },
}
const ctx = {
  effect: (callback) => callback(),
  inject(_services, callback) { callback(ctx) },
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
const injected = slots.get('plugins.bundle.config').inject()
assert.equal(injected.hooks.settings, form)
const settings = views.get('plugins.bundle.config')({ view: 'page', useSettings: (select) => select(injected.hooks.settings.getSnapshot()), setStreaming: injected.setStreaming })
function render() { cursor = 0; return settings.type(settings.props) }
function elements(node) { return node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(elements)] : [] }
const toggle = () => elements(render()).find((node) => node.type === ui.Switch)
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
const rejected = toggle().props.onChange(false)
finish(false)
await rejected
assert.equal(toggle().props.checked, true)
assert.match(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), /not saved/)
const failed = toggle().props.onChange(false)
fail(new Error('offline'))
await failed
assert.match(elements(render()).find((node) => node.props?.role === 'alert').props.children.join(), /Could not save/)
snapshot = { ...snapshot, writable: false }
assert.equal(toggle().props.disabled, true)
snapshot = { ...snapshot, writable: true, status: 'unavailable' }
assert.equal(toggle().props.disabled, true)
console.log('client settings: accepted values, pending writes, refusals, errors and unavailable forms ok')
