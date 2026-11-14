import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function harness() {
  let bundle
  const stops = [], definitions = new Map(), views = new Map(), listeners = new Set(), slots = new Map(), slotListeners = new Map(), factories = new Map(), profile = { arrayVisits: 0 }
  const notify = (subscribers) => { for (const listener of [...subscribers ?? []]) listener() }
  const own = (dispose) => { stops.push(dispose); return dispose }
  const events = { entries: () => [...definitions.values()], subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) }, register(definition) {
    assert.ok(!definitions.has(definition.kind), `duplicate definition ${definition.kind}`); definitions.set(definition.kind, definition); notify(listeners)
    return () => { if (definitions.get(definition.kind) === definition) { definitions.delete(definition.kind); notify(listeners) } }
  } }
  const slotService = {
    entries: (name) => slots.get(name) ?? [], entriesOfSlot: (name) => slots.get(name) ?? [],
    subscribe(name, listener) { if (!slotListeners.has(name)) slotListeners.set(name, new Set()); slotListeners.get(name).add(listener); return () => slotListeners.get(name).delete(listener) },
    inject(_name, setup) { const result = setup(); if (result?.next) for (const _ of result) {} },
    register(options, component) {
      const entry = { options: { key: options.key, priority: options.priority }, component, children: options.children, inject: options.inject }
      slots.set(options.name, [...slots.get(options.name) ?? [], entry]); notify(slotListeners.get(options.name))
      return own(() => { slots.set(options.name, (slots.get(options.name) ?? []).filter(item => item !== entry)); notify(slotListeners.get(options.name)) })
    },
    registerFactory(options, component) {
      assert.ok(!factories.has(options.name)); const entry = { options, component }; factories.set(options.name, entry)
      return own(() => { if (factories.get(options.name) === entry) factories.delete(options.name) })
    },
  }
  const target = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const ctx = { slots: slotService, uiConversation: { events, views: { register(definition) { assert.ok(!views.has(definition.target)); views.set(definition.target, definition); return () => views.delete(definition.target) } },
    binding(sessionId) { assert.equal(sessionId, 'session'); return { target(name) { assert.equal(name, 'py-codeact-source'); return target } } },
  }, effect: setup => own(setup()), inject(services, setup) { if (services.includes('uiConversation')) setup(ctx) } }
  const sandbox = createContext({ window: { __ModuleLoader__: { load: value => { bundle = value } } }, document: { querySelector: () => null }, profile })
  // Count copied array entries, rather than relying on machine-dependent elapsed time to catch quadratic delta retention.
  runInContext('Array.prototype[Symbol.iterator] = function* () { for (let i = 0; i < this.length; i++) { profile.arrayVisits++; yield this[i] } }', sandbox)
  runInContext(source, sandbox); bundle.factory(() => ({ createElement() {} })).apply(ctx)
  return { events, definitions, views, target, slots: slotService, factories, profile, close() { while (stops.length) stops.pop()?.(); assert.equal(listeners.size, 0); assert.equal(views.size, 0); for (const set of slotListeners.values()) assert.equal(set.size, 0) } }
}
function native(kind = 'tool-call') {
  const starts = [], updates = []
  return { kind, target: kind === 'tool-call' ? 'chat' : 'trajectory', starts, updates,
    match: event => event.type === 'tool/call' ? { id: event.data.callId, role: 'start' } : event.type === 'tool/result' && event.surfaceOp === 'append' ? { id: event.data.message.source.callId, role: 'update' } : null,
    start(_context, match) { starts.push(match); return Object.freeze({}) },
    update(context, match) { updates.push(match); return context.state }, buildViewNode: () => null,
  }
}
const event = (type, data) => ({ type, data })
const delta = (seq, argumentsDelta, name) => ({ event: { ...event('assistant/live-chunk', { chunk: { type: 'tool-call-delta', id: 'parent', argumentsDelta, name } }), seq }, role: 'start', location: { kind: 'unresolved' } })

test('production adapter claims only its child events in Chat and follows native registration lifetimes', () => {
  const h = harness(), original = native(), stop = h.events.register(original), definition = h.definitions.get('py-codeact-stream')
  const child = event('tool/ptc-dispatch-start', { rootCallId: 'parent', parentCallId: 'parent', subCallId: 'parent:py:child' })
  assert.equal(definition.match(child).exclusive, true)
  assert.equal(definition.match({ ...child, data: { ...child.data, subCallId: 'another-child' } }), null)
  assert.equal(definition.match(event('tool/call', { callId: 'parent', name: 'python' })).exclusive, undefined)
  assert.equal(definition.match(delta(1, '{', 'python').event).exclusive, undefined)
  assert.ok(h.views.has('py-codeact-source')); assert.equal(h.definitions.get('py-codeact-source').match(child).exclusive, false)
  for (const entry of h.slots.entries('conversation.chat.node')) assert.equal(entry.inject('session').hooks.pyCodeActSource, h.target)
  const stopView = h.slots.register({ name: 'conversation.chat.node', key: 'tool-call' }, function NativeTree() {})
  assert.ok(h.factories.has('py-codeact.tool-tree')); stopView(); assert.equal(h.factories.size, 0)
  stop(); assert.equal(h.definitions.has('py-codeact-stream'), false)
  const replacement = native(); h.events.register(replacement); assert.notEqual(h.definitions.get('py-codeact-stream'), definition)
  h.events.register(native('trajectory-tool-call')); assert.ok(h.definitions.has('py-codeact-trajectory'))
  h.close(); assert.deepEqual([...h.definitions.keys()], ['tool-call', 'trajectory-tool-call']); assert.equal(h.factories.size, 0)
})

test('production delegates plan and question events while retaining them in its independent source', () => {
  const h = harness(); h.events.register(native())
  for (const [kind, name] of [['submitted-plan', 'exit_plan_mode'], ['answered-user-question', 'ask_user_question']]) {
    const original = { ...native(kind), target: 'chat', match: event => event.data.name === name ? { id: event.data.subCallId, role: 'start' } : null }
    const stop = h.events.register(original), child = event('tool/ptc-dispatch-start', { rootCallId: 'parent', parentCallId: 'parent', subCallId: 'parent:py:child', name })
    assert.equal(h.definitions.get('py-codeact-stream').match(child), null)
    assert.equal(h.definitions.get('py-codeact-source').match(child).exclusive, false)
    const delegated = h.definitions.get(`py-codeact-${kind}`); assert.equal(delegated.match(child).exclusive, true)
    assert.equal(delegated.start, original.start); assert.equal(delegated.update, original.update); assert.equal(delegated.buildViewNode, original.buildViewNode)
    assert.equal(delegated.match({ ...child, data: { ...child.data, subCallId: 'another-child' } }), null)
    stop(); assert.equal(h.definitions.has(`py-codeact-${kind}`), false); assert.equal(h.definitions.get('py-codeact-stream').match(child).exclusive, true)
  }
  const result = { ...event('tool/result', { message: { source: { callId: 'parent' } } }), surfaceOp: 'replace' }
  for (const kind of ['py-codeact-stream', 'py-codeact-source']) {
    assert.equal(h.definitions.get(kind).match(result), null)
    assert.equal(h.definitions.get(kind).match({ ...result, surfaceOp: 'append' }).id, 'parent')
  }
  const unsupported = { ...native('submitted-plan'), target: 'chat', buildViewNode: undefined, match: () => ({ id: 'child', role: 'start' }) }, stop = h.events.register(unsupported)
  const child = event('tool/ptc-dispatch-start', { rootCallId: 'parent', parentCallId: 'parent', subCallId: 'parent:py:child', name: 'exit_plan_mode' })
  assert.equal(h.definitions.get('py-codeact-stream').match(child)?.exclusive, true); assert.equal(h.definitions.has('py-codeact-submitted-plan'), false); stop()
  h.close()
})

test('production preparation passes late-name and block-end prefixes to native readers', () => {
  for (const fullBlock of [false, true]) {
    const h = harness(), original = native(); h.events.register(original)
    const definition = h.definitions.get('py-codeact-stream'), first = delta(1, '{"code":"print('), matches = [first]
    let state = definition.start({ matches, state: undefined }, first)
    const next = fullBlock ? { ...delta(2, ''), event: { ...event('assistant/live-chunk', { chunk: { type: 'block-end', block: { type: 'tool-call', id: 'parent', name: 'python', arguments: '{"code":"print(1)"}' } } }), seq: 2 } } : delta(2, '1)"}', 'python')
    matches.push(next); state = definition.update({ matches, state }, next)
    assert.equal(original.starts.length, 1); assert.equal(original.starts[0].event.data.chunk.argumentsDelta, '{"code":"print(1)"}')
    assert.equal(first.event.data.chunk.name, undefined); h.close()
  }
})

test('production preparation does not copy a growing history for every argument delta', () => {
  const h = harness(), original = native(); h.events.register(original)
  const definition = h.definitions.get('py-codeact-stream'), matches = []; let state
  h.profile.arrayVisits = 0
  for (let i = 0; i < 2000; i++) { const match = delta(i, 'x', 'python'); matches.push(match); state = (i ? definition.update : definition.start)({ matches, state }, match) }
  assert.ok(h.profile.arrayVisits < 16000, `copied ${h.profile.arrayVisits} array entries for 2000 deltas`)
  assert.equal(original.starts.length, 1); assert.equal(original.updates.length, 1999); h.close()
})

test('production source retains many child dispatches without repeatedly copying prior history', () => {
  const h = harness(), original = native(); h.events.register(original)
  const definition = h.definitions.get('py-codeact-source'), matches = []; let state
  h.profile.arrayVisits = 0
  for (let i = 0; i < 2000; i++) {
    const match = { event: { ...event('tool/ptc-dispatch-start', { rootCallId: 'parent', parentCallId: 'parent', subCallId: `parent:py:${i}` }), seq: i }, role: 'start', location: { kind: 'unresolved' } }
    matches.push(match); state = (i ? definition.update : definition.start)({ matches, state }, match)
  }
  assert.ok(h.profile.arrayVisits < 16000, `copied ${h.profile.arrayVisits} array entries for 2000 dispatches`)
  assert.equal(original.starts.length, 1); assert.equal(original.updates.length, 2000); h.close()
})

test('production preserves observed names, leaves unknown names blank and lets canonical calls take over', () => {
  for (const kind of ['tool-call', 'trajectory-tool-call']) for (const name of ['py', 'python']) for (const durable of [false, true]) for (const legacy of [false, true]) {
    const h = harness(), original = { ...native(kind),
      start: (_context, match) => ({ name: match.event.data.name ?? match.event.data.chunk?.name ?? '', subCalls: [], args: {} }),
      update: (context, match) => match.event.type === 'tool/call' ? { ...context.state, name: match.event.data.name } : context.state,
      buildViewNode: context => context.state ? { data: { root: context.state }, visibility: 'visible' } : null,
    }
    h.events.register(original)
    const definition = h.definitions.get(kind === 'tool-call' ? 'py-codeact-source' : 'py-codeact-trajectory')
    const location = { kind: 'step', step: { turn: 1, step: 1 }, turn: { turn: 1 } }, matches = [], current = new Map(); let state
    const accept = (event, at = location) => {
      assert.equal(definition.match(event).id, 'parent')
      const match = { event, role: 'start', location: at }; matches.push(match)
      const context = { id: 'parent', state, matches, start: matches[0], current }
      state = (matches.length === 1 ? definition.start : definition.update)(context, match)
      return definition.buildViewNode({ ...context, state }).data.root.name
    }
    const source = { kind: 'python-stream', phase: 'start', callId: 'parent', turn: 1, step: 1 }
    const admission = legacy ? event('user/message', { source }) : event('developer/message', { turn: 1, step: 1, message: { source, content: [] } })
    assert.equal(accept({ ...admission, seq: 0 }), '')
    const observed = durable ? { ...event('assistant/attempt', { stream: [{ type: 'tool-call-chunks', id: 'parent' }, { type: 'tool-call-chunks', id: 'parent', name }] }), seq: 1 } : delta(1, '{}', name).event
    assert.equal(accept(observed), name)
    assert.equal(accept({ ...event('assistant/attempt', { stream: [{ type: 'tool-call-chunks', id: 'parent', name: 'unrelated' }] }), seq: 2 }, { ...location, step: { turn: 1, step: 2 } }), name)
    assert.equal(accept({ ...event('tool/call', { callId: 'parent', name: 'canonical', arguments: '{}' }), seq: 3 }), 'canonical')
    h.close()
  }
})
