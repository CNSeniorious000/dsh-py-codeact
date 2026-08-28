/**
 * Browser half: the `CodeAct` card for the `python` tool.
 *
 * Registers `tool.call.toolview` under `key: 'python'`. That slot is keyed by wire tool name and, per its contract, "registering is additive for your own tool" — it replaces ONLY the card body. `ToolCallBranch` renders `subCalls` as siblings of the slot occupant, so the native SUBTOOL nesting is untouched.
 *
 * Why a client half at all: `toolRowModel` in `dsh-client-ui-tool` ignores the host's `presentCall` view entirely and derives title/summary/body from the tool NAME plus raw args — `TOOL_TITLES[name] ?? VARIANT_TITLES[classifyTool(name)]`, which lands an unknown tool on "Tool call" with its args as JSON. Nothing host-side can change that. Upstream fix proposed in discussion #4724.
 *
 * This mirrors the shipped `ToolRow` rather than restyling: the same exported `DisclosureRow` and `CodeBlock` primitives, the same leading icon, and the same CSS module classes — read off the stylesheet that `dsh-client-ui-tool` already injected, so the card inherits every rule instead of approximating it.
 */

window.__ModuleLoader__.load({
  id: 'dsh-py-codeact',
  factory: (require) => {
    const module = { exports: {} }

    const React = require('react')
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /**
     * The shipped ToolRow class names.
     *
     * CSS-module classes are hash-prefixed per build, so the prefix is recovered from the stylesheet `dsh-client-ui-tool` injects rather than pinned — a version bump changes the hash but not this lookup. Falls back to the bare name, which renders unstyled instead of throwing.
     *
     * The alternative — shipping our own `.module.css`, the way `dsh-client-ui-tool` and `dsh-client-ui-skill` do — needs a bundler this buildless package does not have, and would fork their rules: the card would stop tracking a future dsh restyle and drift out of the parity it was built for. Borrowing keeps it native by construction; the cost is the coupling, which the runtime lookup and the fallback bound.
     */
    const css = (() => {
      const tag = typeof document === 'undefined'
        ? null
        : document.querySelector('style[data-plugin-css="@deepseek-ai/dsh-client-ui-tool/ToolRow.module.css"]')
      const prefix = tag?.textContent?.match(/\.([A-Za-z0-9_-]+?)_root\b/)?.[1]
      return (name) => (prefix === undefined ? name : `${prefix}_${name}`)
    })()

    /** Flatten a settled node's content blocks the way the shipped generic row does. */
    function resultText(block) {
      const parts = []
      for (const content of block.content ?? []) {
        if (content.type === 'text') parts.push(content.text)
        else parts.push(JSON.stringify(content, null, 2))
      }
      if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
      return parts.join('\n')
    }

    function CodeActCard({ toolName, block, inspect }) {
      const [expanded, setExpanded] = React.useState(false)

      const settled = 'kind' in block
      const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
      let args
      try { args = JSON.parse(argsRaw) } catch { args = undefined }
      const code = typeof args?.code === 'string' ? args.code : argsRaw
      // The description is the row's summary — that is why the tool makes it required. Fall back to the first line of code only when it is absent.
      const summary = typeof args?.description === 'string' && args.description.trim() !== ''
        ? args.description
        : (code.split('\n')[0] ?? '')

      const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
      const output = settled ? resultText(block) || null : null
      const failureLine = state === 'error' && output !== null ? (output.split('\n').find((line) => line.trim() !== '') ?? null) : null
      const summaryText = failureLine ?? summary
      const expandable = code !== '' || output !== null

      const body = h(React.Fragment, null, [
        code === '' ? null : h('div', { className: css('bodyScroll'), key: 'code' },
          h(ui.CodeBlock, { code, lang: 'python', className: css('codeBody') })),
        output === null ? null : h('div', { className: css('ioCard'), key: 'io' },
          h('div', { className: css('ioSection') }, [
            h('span', { className: css('ioLabel'), key: 'l' }, 'OUT'),
            h('span', { className: css('ioText'), key: 't', 'data-error': state === 'error' || undefined }, output),
          ])),
        inspect === undefined ? null : h('button', {
          type: 'button', className: css('inspectButton'), onClick: inspect, key: 'inspect',
        }, [h(ui.IconInspectOutline12, { key: 'i' }), 'Inspect']),
      ])

      // Mirror the shipped row's state signalling. Without the dot, an interrupted cell is pixel-identical to a successful one — `failureLine` is null for `stopped`, so it does not even get the error colouring, and `data-state` is invisible. The hidden label is what assistive tech gets: both the dot and the running sweep are colour-only.
      const status = { running: '运行中', error: '执行失败', stopped: '已中断' }[state] ?? null
      const leading = state === 'error' ? h(ui.StateDot, { state: 'error' })
        : state === 'stopped' ? h(ui.StateDot, { state: 'warning' })
        : h(ui.IconCodeOutline16, { size: 14 })

      return h('div', {
        className: css('root'),
        'data-variant': 'code',
        'data-tool': toolName,
        'data-state': state,
      }, [
        status === null ? null : h('span', { className: css('visuallyHidden'), key: 'status' }, status),
        h(ui.DisclosureRow, {
          key: 'row',
          rowClassName: css('row'),
          leadingClassName: css('leading'),
          titleClassName: css('title'),
          chevronClassName: css('chevron'),
          icon: leading,
          title: 'CodeAct',
          open: expanded && expandable,
          expandable,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => setExpanded((value) => !value),
          collapsedContent: summaryText === '' ? undefined : h(React.Fragment, null, [
            h('span', { className: css('sep'), 'aria-hidden': true, key: 's' }),
            h('span', {
              className: failureLine === null ? css('summary') : `${css('summary')} ${css('errorSummary')}`,
              key: 'x',
            }, summaryText),
          ]),
        }, h('div', { className: css('bodyWrap') }, body)),
      ])
    }

    module.exports = {
      name: 'dsh-py-codeact-client',
      // Declared, not probed: cordis holds `apply` until `slots` exists. Reading `ctx.get('slots')` and returning when it is absent loses the race silently and is never retried — the `python` row falls back to the generic "Tool call" card for the rest of the session with nothing logged.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'python' },
          (props) => h(CodeActCard, props),
        ))
      },
    }

    return module.exports
  },
})
