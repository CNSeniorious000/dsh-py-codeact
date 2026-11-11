/**
 * Browser half: the `CodeAct` card for the `python` tool.
 *
 * Registers the Python card and projects early streaming subcalls into the native tool tree. The compatibility views never change session events or execute code.
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

    /** Read-only compatibility projection; these helpers never append events or execute a tool. */
    const identity = (value) => typeof value === 'string' && value.length > 0 ? value : undefined
    const notice = (event) => event.type === 'user/message' && event.data?.source?.kind === 'python-stream' && event.data.source.phase === 'start' && identity(event.data.source.callId) ? event.data.source : undefined
    const dispatch = (event) => event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch'
    const ownedDispatch = (event) => dispatch(event) && Boolean(identity(event.data?.rootCallId) && identity(event.data?.parentCallId) && identity(event.data?.subCallId)?.startsWith(`${event.data.rootCallId}:py:`))
    const rootId = (event) => identity(notice(event)?.callId ?? (dispatch(event) ? event.data?.rootCallId : event.type === 'tool/call' ? event.data?.callId : event.type === 'tool/result' ? event.data?.message?.source?.callId : undefined))
    const liveId = (event) => event.type !== 'assistant/live-chunk' ? undefined : identity(event.data?.chunk?.type === 'tool-call-delta' ? event.data.chunk.id : event.data?.chunk?.type === 'block-end' && event.data.chunk.block?.type === 'tool-call' ? event.data.chunk.block.id : undefined)
    const supported = (native) => ['match', 'start', 'update', 'buildViewNode'].every(key => typeof native?.[key] === 'function')

    /** Map an observed execution to the native view constructor, never to the Session event stream. */
    function displayStart(match, callId = rootId(match.event), name = 'python') {
      const source = notice(match.event), data = match.event.data, location = match.location
      return { ...match, role: 'start', event: { ...match.event, type: 'tool/call', data: {
        callId, name, arguments: '',
        turn: source?.turn ?? (location.kind === 'step' || location.kind === 'turn' ? location.turn.turn : data.turn ?? 0),
        step: source?.step ?? (location.kind === 'step' ? location.step.step : data.step ?? 0),
      },
      // A truncated page can prove ancestry but not the parent's start time. NaN is the native view's unknown-time sentinel; it is never persisted.
      time: source === undefined ? Number.NaN : match.event.time } }
    }

    function delegateContext(context, state = {}, start = state.start) {
      const location = context.matches.find(match => match.event.seq === start?.event.seq)?.location
      return { ...context, state: state.native, start: start === undefined || location === undefined ? start : { ...start, location } }
    }
    function advance(native, context, match, trajectory) {
      const previous = context.state ?? { native: undefined, start: undefined, dispatches: [], owned: false, canonical: false }
      const state = { ...previous, dispatches: dispatch(match.event) ? [...previous.dispatches, match] : previous.dispatches, owned: previous.owned || Boolean(notice(match.event)) || ownedDispatch(match.event),
        canonical: previous.canonical || match.event.type === 'tool/call' }
      if (!trajectory && liveId(match.event) !== undefined) {
        const chunk = match.event.data.chunk
        state.arguments = chunk.type === 'block-end' ? chunk.block.arguments : (previous.arguments ?? '') + (chunk.argumentsDelta ?? '')
        const name = chunk.type === 'block-end' ? chunk.block.name : chunk.name
        state.named = previous.named || chunk.type === 'tool-call-delta' && Boolean(identity(name))
        if (previous.preparing !== undefined) state.preparing = { ...previous.preparing, native: native.update(delegateContext(context, previous.preparing), match) }
        else if (identity(name)) {
          // Providers may announce the name after argument bytes. Give the native reader that existing prefix without altering the actual match timeline.
          const seed = { ...match, event: { ...match.event, data: { ...match.event.data, chunk: { type: 'tool-call-delta', id: liveId(match.event), name, argumentsDelta: state.arguments } } } }
          state.preparing = { start: match, native: native.start({ ...context, state: undefined }, seed, { previous: () => undefined }) }
          if (chunk.type === 'block-end') state.preparing.native = native.update(delegateContext(context, state.preparing), match)
        }
      }
      if (match.event.type === 'tool/call') {
        if (trajectory || state.native === undefined) {
          state.start = match
          state.native = native.start(delegateContext(context, state), match, { previous: () => undefined })
          // A protocol parent may arrive after real child effects; rebuild only display state around its authoritative name, args and timestamp.
          for (const earlier of previous.dispatches) state.native = native.update(delegateContext(context, state), earlier)
        } else state.native = native.update(delegateContext(context, state), match)
        return state
      }
      if (state.native === undefined && (notice(match.event) || ownedDispatch(match.event))) {
        state.start = displayStart(match)
        state.native = native.start(delegateContext(context, state), state.start, { previous: () => undefined })
      }
      if (state.native !== undefined && (dispatch(match.event) || match.event.type === 'tool/result')) state.native = native.update(delegateContext(context, state), match)
      return state
    }

    /** A page may show a descendant before its parent's record. Preserve the evidenced edge without inventing the missing parent's metadata. */
    function withObservedParents(native, context, state, root) {
      const matches = state.dispatches, known = new Set([root.callId, ...matches.map(match => match.event.data.subCallId)])
      const missing = new Map()
      for (const match of matches) if (identity(match.event.data.parentCallId) && !known.has(match.event.data.parentCallId) && !missing.has(match.event.data.parentCallId)) missing.set(match.event.data.parentCallId, match)
      if (missing.size === 0) return root
      const observed = []
      for (const [callId, first] of missing) {
        const start = displayStart(first, callId, ''), shell = { start, native: native.start({ ...context, state: undefined }, start, { previous: () => undefined }) }
        for (const match of matches) shell.native = native.update(delegateContext(context, shell), match)
        const node = native.buildViewNode({ ...delegateContext(context, shell), current: new Map() })
        if (node?.data.root === undefined) continue
        const projected = node.data.root
        // The parent is only observed through its child: even a closed step cannot establish that parent's outcome or direct ancestor.
        observed.push({ phase: 'start', callId, name: '', argsRaw: '', args: projected.args, turn: start.event.data.turn, step: start.event.data.step, time: Number.NaN, subCalls: projected.subCalls })
      }
      return observed.length === 0 ? root : { ...root, subCalls: [...root.subCalls, ...observed] }
    }

    /** Own only Python child records. Native root/assistant/process consumers retain every original event. */
    function chatProjection(native) {
      if (!supported(native)) return undefined
      return {
        kind: 'py-codeact-stream', target: 'chat',
        match(event) {
          if (dispatch(event)) return ownedDispatch(event) ? { id: String(rootId(event)), role: 'start', exclusive: true } : null
          const id = rootId(event) ?? liveId(event)
          return id === undefined ? null : { id: String(id), role: 'start' }
        },
        start: (context, match) => advance(native, context, match, false),
        update: (context, match) => advance(native, context, match, false),
        publication: native.publication,
        buildViewNode(context) {
          const state = context.state
          if (!state?.owned) return null
          const node = native.buildViewNode(delegateContext(context, state))
          if (node == null) return null
          const preparing = state.preparing === undefined ? null : native.buildViewNode({ ...delegateContext(context, state.preparing), current: new Map() })
          let root = withObservedParents(native, context, state, node.data.root)
          if (!state.canonical && preparing?.data.root !== undefined) {
            const metadata = preparing.data.root
            root = { ...root, name: metadata.name, args: metadata.args, ...('kind' in root ? { call: { name: metadata.name, argsRaw: state.arguments ?? '' } } : { argsRaw: state.arguments ?? '' }) }
          }
          return { ...node, kind: 'py-codeact-stream', data: { ...node.data, root }, visibility: state.canonical || state.named && preparing?.visibility === 'visible' ? 'hidden' : node.visibility }
        },
      }
    }

    /** Trajectory has one tool consumer; delegate ordinary calls unchanged, and admit Python's real earlier execution. */
    function trajectoryProjection(native) {
      if (!supported(native)) return undefined
      return {
        kind: 'py-codeact-trajectory', target: 'trajectory',
        match(event) {
          if (rootId(event) === undefined) return null
          const match = native.match(event)
          if (match !== null) return { ...match, role: 'start', exclusive: true }
          const source = notice(event)
          return source === undefined ? null : { id: source.callId, role: 'start' }
        },
        start: (context, match) => advance(native, context, match, true),
        update: (context, match) => advance(native, context, match, true),
        buildViewNode(context) {
          if (context.state === undefined) return null
          const node = native.buildViewNode(delegateContext(context, context.state))
          return node == null || !context.state.owned ? node : { ...node, data: { ...node.data, root: withObservedParents(native, context, context.state, node.data.root) } }
        },
      }
    }

    /** Reuse the native tree through public slot APIs, giving its private child slots independent ownership. */
    function mirrorToolTree(slots) {
      let selected, stopTree = () => {}, sequence = 0
      const dispose = (stops) => { while (stops.length) stops.pop()() }
      function clone(entry, name, factory = false) {
        const renamed = new Map(Object.keys(entry.children ?? {}).map((key) => [key, `py-codeact.history.${++sequence}.${key}`]))
        const children = Object.fromEntries([...renamed].map(([key, target]) => [target, entry.children[key]]))
        const component = (props) => h(entry.component, {
          ...props,
          ...renamed.size ? {
            renderSlot: (key, ...args) => props.renderSlot(renamed.get(key), ...args),
            ...props.renderSlotChain ? { renderSlotChain: (key, ...args) => props.renderSlotChain(renamed.get(key), ...args) } : {},
          } : {},
        })
        const metadata = {
          name, ...factory ? { scope: 'session' } : entry.options,
          ...renamed.size ? { children } : {}, ...entry.inject ? { inject: entry.inject } : {},
          ...entry.locale ? { locale: entry.locale } : {}, ...entry.store ? { store: entry.store } : {}, ...entry.select ? { select: entry.select } : {},
        }
        const stops = []
        try {
          stops.push(factory ? slots.registerFactory(metadata, component) : slots.register(metadata, component))
          for (const [source, target] of renamed) stops.push(mirror(source, target))
          return () => dispose(stops)
        } catch (error) { dispose(stops); throw error }
      }
      function mirror(source, target) {
        const copies = new Map()
        const sync = () => {
          const entries = slots.entriesOfSlot(source)
          for (const [entry, stop] of copies) if (!entries.includes(entry)) { stop(); copies.delete(entry) }
          for (const entry of entries) if (!copies.has(entry)) copies.set(entry, clone(entry, target))
        }
        const unsubscribe = slots.subscribe(source, sync)
        const stop = () => { unsubscribe(); for (const disposeCopy of copies.values()) disposeCopy(); copies.clear() }
        try { sync(); return stop } catch (error) { stop(); throw error }
      }
      const sync = () => {
        const entry = slots.entries('conversation.chat.node').find((candidate) => candidate.options.key === 'tool-call' && candidate.component !== StreamToolTree)
        if (entry === selected) return
        stopTree(); selected = undefined; stopTree = () => {}
        if (entry) { stopTree = clone(entry, 'py-codeact.tool-tree', true); selected = entry }
      }
      const unsubscribe = slots.subscribe('conversation.chat.node', sync)
      const stop = () => { unsubscribe(); stopTree() }
      try { sync(); return stop } catch (error) { stop(); throw error }
    }

    function renderToolTree(props, node) {
      return props.renderFactorySlot('py-codeact.tool-tree', {
        node, cwd: props.cwd, openFile: props.openFile, inspectCall: props.inspectCall, loadImage: props.loadImage, useDisclosure: props.useDisclosure,
      })
    }

    function StreamToolTree(props) {
      const streamed = props.useChat((snapshot) => {
        for (const node of snapshot.nodes.values()) if (node.kind === 'py-codeact-stream' && node.id === props.node.id && node.visibility === 'hidden') return node
        return undefined
      })
      if (!streamed) return renderToolTree(props, props.node)
      const root = props.node.data.root
      const subCalls = [...root.subCalls, ...streamed.data.root.subCalls.filter((child) => !root.subCalls.some((existing) => existing.callId === child.callId))]
      // Execution has already started; keep the native arguments while admitting its observed children.
      return renderToolTree(props, { ...props.node, data: { ...props.node.data, root: { ...root, ...root.phase === 'preparing' ? { phase: 'start', args: streamed.data.root.args, argsRaw: streamed.data.root.argsRaw } : {}, subCalls } } })
    }

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
        respectToolConcurrency: 'Follow tool concurrency policy',
        concurrencyHint: 'Off by default for snappy parallel calls. Turn on to follow official PTC scheduling: only tools whose isConcurrencySafe returns true can overlap, up to 10 per cell; other calls run exclusively, and results commit in order. Older hosts serialize all calls. Applies to the next cell; explicit preset settings override this switch.',
        loading: 'Loading settings…',
        unavailable: 'CodeAct settings are unavailable.',
        readOnly: 'These settings are read-only.',
        notSaved: 'The setting was not saved. Try again.',
        saveFailed: 'Could not save the setting. Try again.',
      },
      zh: {
        streaming: '流式执行',
        hint: '在 Python 代码生成过程中执行已稳定的语句，每条只执行一次。需要兼容的 DSH 0.2.2+，并使用 code 模式。更改从下一次模型请求起生效，不会重置会话；预设中的显式配置优先于此开关。使用 IPython 魔法命令或自动显示表达式结果时，请关闭此项。',
        respectToolConcurrency: '遵循工具并发策略',
        concurrencyHint: '默认关闭，让并行调用保持快速响应。开启后遵循官方 PTC 的调度方式：仅 isConcurrencySafe 返回 true 的工具可并行，每个代码单元最多 10 个，其余调用独占执行，结果按提交顺序处理。旧版宿主会串行执行所有调用。从下一个代码单元起生效；预设中的显式配置优先于此开关。',
        loading: '正在加载设置…',
        unavailable: 'CodeAct 设置不可用。',
        readOnly: '这些设置为只读。',
        notSaved: '设置未保存，请重试。',
        saveFailed: '无法保存设置，请重试。',
      },
    }

    function CodeActSettings({ useSettings, setSetting, t }) {
      const state = useSettings((snapshot) => snapshot)
      const [saving, setSaving] = React.useState(false)
      // Keep keys in state so an existing error follows a live language change.
      const [error, setError] = React.useState('')
      const unavailable = state.status === 'loading' ? 'loading' : state.status === 'unavailable' ? 'unavailable' : !state.writable ? 'readOnly' : ''
      async function change(field, enabled) {
        setSaving(true)
        setError('')
        try { if (!await setSetting(field, enabled)) setError('notSaved') }
        catch { setError('saveFailed') }
        finally { setSaving(false) }
      }
      return h('div', { style: { display: 'grid', gap: 12 } }, [
        ...[['streaming', 'hint'], ['respectToolConcurrency', 'concurrencyHint']].map(([field, hint]) => h('div', { key: field }, [
          h('div', { key: 'toggle', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } }, [
            h('span', { key: 'label' }, t(field)),
            h(ui.Switch, { key: 'switch', label: t(field), checked: state.value?.[field] === true, disabled: saving || state.status !== 'ready' || !state.writable, onChange: (enabled) => change(field, enabled) }),
          ]),
          h('p', { key: 'hint', style: { margin: '8px 0 0', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, t(hint)),
        ])),
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
        ctx.inject(['uiConversation'], (child) => {
          if (!child.uiConversation || !child.slots.registerFactory || !child.slots.entries || !child.slots.entriesOfSlot || !child.slots.subscribe) return
          const events = child.uiConversation.events
          if (!events?.entries || !events.subscribe || !events.register) return
          child.effect(() => {
            const active = new Map()
            let updating = false
            const sync = () => {
              if (updating) return
              updating = true
              try {
                for (const [kind, adapt] of [['tool-call', chatProjection], ['trajectory-tool-call', trajectoryProjection]]) {
                  const native = events.entries().find(definition => definition.kind === kind)
                  if (active.get(kind)?.native === native) continue
                  active.get(kind)?.dispose(); active.delete(kind)
                  const definition = adapt(native)
                  if (definition) active.set(kind, { native, dispose: events.register(definition) })
                }
              } finally { updating = false }
            }
            const unsubscribe = events.subscribe(sync)
            const dispose = () => { unsubscribe(); for (const item of active.values()) item.dispose(); active.clear() }
            try { sync(); return dispose } catch (error) { dispose(); throw error }
          })
          child.effect(() => mirrorToolTree(child.slots))
          child.slots.inject('conversation.chat.node', function* () {
            yield child.slots.register({ name: 'conversation.chat.node', key: 'tool-call', priority: -1 }, StreamToolTree)
            yield child.slots.register({ name: 'conversation.chat.node', key: 'py-codeact-stream' }, (props) => props.node.visibility === 'hidden' ? null : renderToolTree(props, props.node))
          })
        })
        // Settings are optional: older hosts still serve the CodeAct card and YAML configuration.
        ctx.inject(['configForms', 'locale'], (child) => {
          if (!child.configForms.get || !child.configForms.whileServed || !ui.Switch) return
          child.effect(() => child.locale.register('pyCodeAct', settingsLocales))
          const form = child.configForms.get('py-codeact-settings')
          child.effect(() => child.configForms.whileServed(['py-codeact-settings'], () => child.slots.inject('plugins.bundle.config', () => child.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-py-codeact', locale: 'pyCodeAct', inject: () => ({ hooks: { settings: form }, setSetting: (field, enabled) => form.set(field, enabled) }) },
            (props) => h(CodeActSettings, props),
          ))))
        })
      },
    }

    return module.exports
  },
})
