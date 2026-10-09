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
    // Newer hosts expose the Regular names; retain the size-suffixed fallback for older hosts.
    const CodeIcon = ui.IconCodeOutlineRegular ?? ui.IconCodeOutline16
    const InspectIcon = ui.IconInspectOutlineRegular ?? ui.IconInspectOutline12

    /**
     * The MCP mark, drawn to this icon set's contract so it shares the row's weight: a 16-unit viewBox with a 1-unit stroke, which renders at 14/16 px exactly like every shipped icon.
     *
     * The logo's own grid is 195 units on a 45° axis, so its three arcs are scaled into the 16-unit viewBox and stroked at the inverse of that scale — the row sees the same 0.875px line the rest of the set does. The 45° axis is not a style choice: turning the mark onto the grid's own axes stops it being the MCP logo.
     */
    const MCP_PATHS = [
      'M25 97.8528L92.8823 29.9706C102.255 20.598 117.451 20.598 126.823 29.9706V29.9706C136.196 39.3431 136.196 54.5391 126.823 63.9117L75.5581 115.177',
      'M76.2653 114.47L126.823 63.9117C136.196 54.5391 151.392 54.5391 160.765 63.9117L161.118 64.2652C170.491 73.6378 170.491 88.8338 161.118 98.2063L99.7248 159.6C96.6006 162.724 96.6006 167.789 99.7248 170.913L112.331 183.52',
      'M109.853 46.9411L59.6482 97.1457C50.2757 106.518 50.2757 121.714 59.6482 131.087V131.087C69.0208 140.459 84.2168 140.459 93.5894 131.087L143.794 80.8822',
    ]
    // 15, not 13: the mark sits on a diagonal, so its bounding box reads smaller than an axis-aligned glyph of the same span — 13 rendered ~11.4px against the 13px the shipped icons occupy.
    const MCP_SCALE = 15 / 172.58
    const McpIcon = ({ size = 14 }) => h('svg', {
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    }, h('g', { transform: `translate(8 8) scale(${MCP_SCALE}) translate(-96.57 -103.23)` },
      MCP_PATHS.map((d, i) => h('path', {
        key: i, d, stroke: 'currentColor', 'stroke-width': 1 / MCP_SCALE, 'stroke-linecap': 'round',
      }))))

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

      // Every tool a cell reaches is a subCall of this row, so the cell itself is where MCP names surface — and a keyed toolview can only be registered once its name is known.
      //
      // Polled rather than read once, and deferred to an effect rather than done inline: a session restored by a reload fills `subCalls` IN PLACE on a block the row already holds, so the row is never re-rendered with the names present (its props are the same object), and registering during the render pass would update the store this row is drawn from.
      React.useEffect(() => {
        const claim = () => {
          let found = false
          for (const call of block.subCalls ?? []) {
            const name = subCallName(call)
            if (name !== undefined && name.startsWith('mcp__')) { registerMcpView(name); found = true }
          }
          return found
        }
        if (claim() || typeof requestAnimationFrame !== 'function') return
        let frame = undefined
        let frames = 0
        const tick = () => { if (!claim() && ++frames < 600) frame = requestAnimationFrame(tick) }
        frame = requestAnimationFrame(tick)
        return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
      }, [block])
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
        }, [h(InspectIcon, { key: 'i' }), 'Inspect']),
      ])

      // Mirror the shipped row's state signalling. Without the dot, an interrupted cell is pixel-identical to a successful one — `failureLine` is null for `stopped`, so it does not even get the error colouring, and `data-state` is invisible. The hidden label is what assistive tech gets: both the dot and the running sweep are colour-only.
      const status = { running: '运行中', error: '执行失败', stopped: '已中断' }[state] ?? null
      const leading = state === 'error' ? h(ui.StateDot, { state: 'error' })
        : state === 'stopped' ? h(ui.StateDot, { state: 'warning' })
        : h(CodeIcon, { size: 14 })

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

    /**
     * The wire name of one subCall.
     *
     * A call still running carries it at the top level, but a call restored by a reload is a result node — which keeps the name one level down, under `call`. Reading only the top level leaves every restored cell's MCP rows on the generic icon.
     */
    function subCallName(call) {
      if (typeof call?.name === 'string') return call.name
      return typeof call?.call?.name === 'string' ? call.call.name : undefined
    }

    /** Split `mcp__<server>__<tool>` for the row title; a non-MCP name comes back whole. */
    function mcpLabel(toolName) {
      const rest = toolName.startsWith('mcp__') ? toolName.slice(5) : toolName
      const cut = rest.indexOf('__')
      return cut === -1 ? rest : `${rest.slice(0, cut)}/${rest.slice(cut + 2)}`
    }

    /**
     * The row for one MCP sub-call.
     *
     * `ui-tool` dispatches `tool.call.toolview` by EXACT wire name and falls back to `GenericToolCard` on a miss, so `mcp__<server>__<tool>` renders as the `others` variant — the generic sparkle and the generic title. A keyed registration is the only lever: a keyed hit replaces the row.
     */
    function McpToolCard({ toolName, block, inspect }) {
      const [expanded, setExpanded] = React.useState(false)

      const settled = 'kind' in block
      const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
      let args
      try { args = JSON.parse(argsRaw) } catch { args = undefined }
      // No schema is shared across MCP servers, so the first non-empty string argument is the only summary every one of them can offer.
      const firstArg = args !== null && typeof args === 'object' ? Object.values(args).find((value) => typeof value === 'string' && value !== '') : undefined

      const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
      const output = settled ? resultText(block) || null : null
      const failureLine = state === 'error' && output !== null ? (output.split('\n').find((line) => line.trim() !== '') ?? null) : null
      const summaryText = failureLine ?? (typeof firstArg === 'string' ? (firstArg.split('\n')[0] ?? '') : '')
      const expandable = argsRaw !== '' || output !== null

      const body = h(React.Fragment, null, [
        argsRaw === '' ? null : h('div', { className: css('bodyScroll'), key: 'args' },
          h(ui.CodeBlock, { code: argsRaw, lang: 'json', className: css('codeBody') })),
        output === null ? null : h('div', { className: css('ioCard'), key: 'io' },
          h('div', { className: css('ioSection') }, [
            h('span', { className: css('ioLabel'), key: 'l' }, 'OUT'),
            h('span', { className: css('ioText'), key: 't', 'data-error': state === 'error' || undefined }, output),
          ])),
        inspect === undefined ? null : h('button', {
          type: 'button', className: css('inspectButton'), onClick: inspect, key: 'inspect',
        }, [h(InspectIcon, { key: 'i' }), 'Inspect']),
      ])

      const status = { running: '运行中', error: '执行失败', stopped: '已中断' }[state] ?? null
      const leading = state === 'error' ? h(ui.StateDot, { state: 'error' })
        : state === 'stopped' ? h(ui.StateDot, { state: 'warning' })
        : h(McpIcon, { size: 14 })

      return h('div', {
        className: css('root'),
        'data-variant': 'mcp',
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
          title: mcpLabel(toolName),
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

    /** Wire names already claimed, so a re-render does not re-register — a keyed slot throws on a duplicate key. */
    const claimedMcp = new Set()
    /** Assigned inside the slot injection; a no-op until the slot exists. */
    let registerMcpView = () => {}

    module.exports = {
      name: 'dsh-py-codeact-client',
      // Declared, not probed: cordis holds `apply` until `slots` exists. Reading `ctx.get('slots')` and returning when it is absent loses the race silently and is never retried — the `python` row falls back to the generic "Tool call" card for the rest of the session with nothing logged.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => {
          registerMcpView = (toolName) => {
            if (claimedMcp.has(toolName)) return
            claimedMcp.add(toolName)
            ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, (props) => h(McpToolCard, props))
          }
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'python' },
            (props) => h(CodeActCard, props),
          )
        })
      },
    }

    return module.exports
  },
})
