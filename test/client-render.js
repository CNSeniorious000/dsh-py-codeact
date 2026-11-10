import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

for (const icons of [
  ['IconCodeOutline16', 'IconInspectOutline12'], // pre-0.2 hosts
  ['IconCodeOutlineRegular', 'IconInspectOutlineRegular'], // 0.2.0-rc.1 and 0.2.1-alpha.1
]) {
  let loaded
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { loaded = value } } },
    document: { querySelector: () => null },
  })
  assert.equal(loaded.id, 'dsh-py-codeact')
  const component = ({ children }) => children
  const React = {
    Fragment: component,
    useState: () => [false, () => {}],
    createElement(type, props, ...children) {
      assert.ok(typeof type === 'function' || typeof type === 'string', `invalid React element: ${String(type)}`)
      return { type, props: { ...props, children } }
    },
  }
  const ui = { CodeBlock: component, DisclosureRow: component, StateDot: component }
  for (const name of icons) ui[name] = component
  const client = loaded.factory((name) => name === 'react' ? React : ui)
  let view
  client.apply({ slots: {
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
