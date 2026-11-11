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

    function CodeActCard({ toolName, block, inspect, t }) {
      const [expanded, setExpanded] = React.useState(false)

      const settled = 'kind' in block
      const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
      let args
      if (!block.args?.text && argsRaw) try { args = JSON.parse(argsRaw) } catch { args = undefined }
      // Native argument readers publish partial fields while the model is still generating the call.
      const code = block.args?.text ? (block.args.text('code') ?? '') : (typeof args?.code === 'string' ? args.code : argsRaw)
      const description = block.args?.text?.('description') ?? args?.description
      // The description is the row's summary — that is why the tool makes it required. Fall back to the first line of code only when it is absent.
      const summary = typeof description === 'string' && description.trim() !== ''
        ? description
        : (code.split('\n')[0] ?? '')

      const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok'
      const output = settled ? resultText(block) || null : null
      const failureLine = state === 'error' && output !== null ? (output.split('\n').find((line) => line.trim() !== '') ?? null) : null
      const summaryText = failureLine ?? summary
      const expandable = code !== '' || output !== null
      // Early hosts lack these dictionary entries and return the key verbatim.
      const outputLabel = t('row.output'), inspectLabel = t('row.inspect')

      const body = h(React.Fragment, null, [
        code === '' ? null : h('div', { className: css('bodyScroll'), key: 'code' },
          h(ui.CodeBlock, { code, lang: 'python', className: css('codeBody'), copyLabel: t('copy'), copiedLabel: t('copied'),
            toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } })),
        output === null ? null : h('div', { className: css('ioCard'), key: 'io' },
          h('div', { className: css('ioSection') }, [
            h('span', { className: css('ioLabel'), key: 'l' }, outputLabel === 'row.output' ? 'OUT' : outputLabel),
            h('span', { className: css('ioText'), key: 't', 'data-error': state === 'error' || undefined }, output),
          ])),
        inspect === undefined ? null : h('button', {
          type: 'button', className: css('inspectButton'), onClick: inspect, key: 'inspect',
        }, [h(InspectIcon, { key: 'i' }), inspectLabel === 'row.inspect' ? 'Inspect' : inspectLabel]),
      ])

      // Mirror the shipped row's state signalling. Without the dot, an interrupted cell is pixel-identical to a successful one — `failureLine` is null for `stopped`, so it does not even get the error colouring, and `data-state` is invisible. The hidden label is what assistive tech gets: both the dot and the running sweep are colour-only.
      const status = state === 'ok' ? null : t({ running: 'row.running', error: 'row.failed', stopped: 'row.stopped' }[state])
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

    const settingsLocales = {
      en: {
        streaming: 'Streaming execution',
        hint: 'Execute stable statements once as Python arrives. Requires a compatible DSH 0.2.2+ host in code mode. Changes apply to the next model step without resetting the session; explicit preset settings override this switch. Turn off for IPython magics and automatic expression display.',
        loading: 'Loading settings…',
        unavailable: 'CodeAct settings are unavailable.',
        readOnly: 'These settings are read-only.',
        notSaved: 'The setting was not saved. Try again.',
        saveFailed: 'Could not save the setting. Try again.',
      },
      zh: {
        streaming: '流式执行',
        hint: '在 Python 代码生成过程中执行已稳定的语句，每条只执行一次。需要兼容的 DSH 0.2.2+，并使用 code 模式。更改从下一次模型请求起生效，不会重置会话；预设中的显式配置优先于此开关。使用 IPython 魔法命令或自动显示表达式结果时，请关闭此项。',
        loading: '正在加载设置…',
        unavailable: 'CodeAct 设置不可用。',
        readOnly: '这些设置为只读。',
        notSaved: '设置未保存，请重试。',
        saveFailed: '无法保存设置，请重试。',
      },
    }

    function StreamingSettings({ useSettings, setStreaming, t }) {
      const state = useSettings((snapshot) => snapshot)
      const [saving, setSaving] = React.useState(false)
      // Keep keys in state so an existing error follows a live language change.
      const [error, setError] = React.useState('')
      const unavailable = state.status === 'loading' ? 'loading' : state.status === 'unavailable' ? 'unavailable' : !state.writable ? 'readOnly' : ''
      async function change(enabled) {
        setSaving(true)
        setError('')
        try { if (!await setStreaming(enabled)) setError('notSaved') }
        catch { setError('saveFailed') }
        finally { setSaving(false) }
      }
      return h('div', { style: { display: 'grid', gap: 12 } }, [
        h('div', { key: 'toggle', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } }, [
          h('span', { key: 'label' }, t('streaming')),
          h(ui.Switch, { key: 'switch', label: t('streaming'), checked: state.value?.streaming === true, disabled: saving || state.status !== 'ready' || !state.writable, onChange: change }),
        ]),
        h('p', { key: 'hint', style: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, t('hint')),
        unavailable ? h('p', { key: 'unavailable', role: 'status', style: { margin: 0 } }, t(unavailable)) : null,
        error ? h('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, t(error)) : null,
      ])
    }

    module.exports = {
      name: 'dsh-py-codeact-client',
      // Declared, not probed: cordis holds `apply` until `slots` exists. Reading `ctx.get('slots')` and returning when it is absent loses the race silently and is never retried — the `python` row falls back to the generic "Tool call" card for the rest of the session with nothing logged.
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
          { name: 'tool.call.toolview', key: 'python', locale: 'conversation' },
          (props) => h(CodeActCard, props),
        ))
        // Settings are optional: older hosts still serve the CodeAct card and YAML configuration.
        ctx.inject(['configForms', 'locale'], (child) => {
          if (!child.configForms.get || !child.configForms.whileServed || !ui.Switch) return
          child.effect(() => child.locale.register('pyCodeAct', settingsLocales))
          const form = child.configForms.get('py-codeact-settings')
          child.effect(() => child.configForms.whileServed(['py-codeact-settings'], () => child.slots.inject('plugins.bundle.config', () => child.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-py-codeact', locale: 'pyCodeAct', inject: () => ({ hooks: { settings: form }, setStreaming: (enabled) => form.set('streaming', enabled) }) },
            (props) => h(StreamingSettings, props),
          ))))
        })
      },
    }

    return module.exports
  },
})
