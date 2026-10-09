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
    useEffect: (fn) => fn(),
    createElement(type, props, ...children) {
      assert.ok(typeof type === 'function' || typeof type === 'string', `invalid React element: ${String(type)}`)
      return { type, props: { ...props, children } }
    },
  }
  const ui = { CodeBlock: component, DisclosureRow: component, StateDot: component }
  for (const name of icons) ui[name] = component
  const client = loaded.factory((name) => name === 'react' ? React : ui)
  const registered = new Map()
  client.apply({ slots: {
    inject(_name, callback) { callback() },
    register(slot, render) { registered.set(slot.key, render) },
  } })
  assert.deepEqual([...registered.keys()], ['python'])

  const row = registered.get('python')({ toolName: 'python', block: { argsRaw: JSON.stringify({ code: 'print(1)' }) }, inspect() {} })
  assert.equal(row.type.name, 'CodeActCard')
  const card = row.type(row.props)
  assert.equal(card.props['data-tool'], 'python')

  // An MCP call is a subCall of the cell that made it, and the cell is where its name reaches the client — so the settled row claims the key on its own.
  const mcpCall = { name: 'mcp__gh__github_code_search', callId: 'c1' }
  const settled = {
    kind: 'result',
    call: { name: 'python', argsRaw: JSON.stringify({ code: 'await github_code_search(directory_name="x")' }) },
    subCalls: [mcpCall],
    content: [],
  }
  const settledRow = registered.get('python')({ toolName: 'python', block: settled, inspect() {} })
  settledRow.type(settledRow.props)
  assert.ok(registered.has('mcp__gh__github_code_search'), 'the cell claimed its MCP subCall key')
  const mcpRow = registered.get('mcp__gh__github_code_search')({ toolName: mcpCall.name, block: mcpCall, inspect() {} })
  assert.equal(mcpRow.type.name, 'McpToolCard')
  console.log(`client render: ${icons.join(' + ')} ok`)
}
