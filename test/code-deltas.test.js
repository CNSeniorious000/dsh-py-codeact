import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { CodeDeltas } from '../lib/code-deltas.js'

function decode(parts) {
  const decoder = new CodeDeltas()
  let code = ''
  for (const part of parts) code += decoder.feed(part)
  return { code, args: decoder.finish(parts.join('')) }
}

describe('irreversible JSON code deltas', () => {
  const examples = [
    { code: '', description: '' },
    { code: "await foo(1)\nfor value in (2, 3):\n    await bar(value)\n", description: 'Execute code' },
    { code: 'value = "backslash \\ quote \\" slash /"\r\n\t\b\f', description: 'Escapes \\"' },
    { code: "print('你好 😺 𝄞')\n", description: 'Unicode 🌍' },
  ]
  for (const example of examples) {
    for (const order of ['code-first', 'description-first']) {
      const args = order === 'code-first' ? example : { description: example.description, code: example.code }
      const raw = ` \t${JSON.stringify(args)}\r\n`
      test(`${order}: all two-part splits ${JSON.stringify(example.code)}`, () => {
        for (let split = 0; split <= raw.length; split++) assert.deepEqual(decode([raw.slice(0, split), '', raw.slice(split)]), { code: example.code, args })
      })
      test(`${order}: every UTF-16 unit ${JSON.stringify(example.code)}`, () => {
        assert.deepEqual(decode(raw.split('')), { code: example.code, args })
      })
    }
  }

  test('emits code before its string, object and model response close', () => {
    const decoder = new CodeDeltas()
    const first = '{"description":"Early effect","code":"await foo(1)\\n'
    assert.equal(decoder.feed(first), 'await foo(1)\n')
    assert.equal(decoder.feed('await bar(2)"}'), 'await bar(2)')
    assert.equal(decoder.finish(first + 'await bar(2)"}').code, 'await foo(1)\nawait bar(2)')
  })

  test('holds partial escapes and surrogate pairs until their meanings are fixed', () => {
    const decoder = new CodeDeltas()
    const parts = ['{"code":"', '\\', 'u', 'd8', '3d', '\\u', 'de', '3a', '\\', 'n', '","description":"cat"}']
    assert.deepEqual(parts.map((part) => decoder.feed(part)), ['', '', '', '', '', '', '', '😺', '', '\n', ''])
    assert.deepEqual(decoder.finish(parts.join('')), { code: '😺\n', description: 'cat' })
  })

  test('accepts escaped field names without treating them as different keys', () => {
    const raw = '{"co\\u0064e":"\\u0061\\/\\b\\f\\n\\r\\t\\\\\\\"","de\\u0073cription":"ok"}'
    assert.deepEqual(decode(raw.split('')), { code: JSON.parse(raw).code, args: JSON.parse(raw) })
  })

  test('holds raw and mixed raw/escaped surrogate pairs', () => {
    for (const pair of [['\ud83d', '\ude3a'], ['\ud83d', '\\ude3a'], ['\\ud83d', '\ude3a']]) {
      const decoder = new CodeDeltas()
      const parts = ['{"code":"', ...pair, '","description":"ok"}']
      assert.deepEqual(parts.map((part) => decoder.feed(part)), ['', '', '😺', ''])
      assert.equal(decoder.finish(parts.join('')).code, '😺')
    }
  })

  test('randomized valid arguments match native JSON decoding at every emitted prefix', () => {
    let seed = 83479
    const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
    const characters = [...'ab "\\/\n\r\t\b\f\0😺𝄞汉é']
    const makeString = () => Array.from({ length: random(100) }, () => characters[random(characters.length)]).join('')
    const quote = (value) => JSON.stringify(value).replace(/[^\x00-\x7f]/g, (character) => random(2) ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}` : character)
    for (let attempt = 0; attempt < 256; attempt++) {
      const code = makeString(), description = makeString()
      const entries = [`"co\\u0064e":${quote(code)}`, `"description":${quote(description)}`]
      if (random(2)) entries.reverse()
      const raw = `{${entries.join(',')}}`, decoder = new CodeDeltas()
      let emitted = ''
      for (let offset = 0; offset < raw.length;) {
        const size = random(9) + 1
        emitted += decoder.feed(raw.slice(offset, offset += size))
        assert.equal(code.startsWith(emitted), true)
      }
      assert.equal(emitted, code)
      assert.deepEqual(decoder.finish(raw), JSON.parse(raw))
    }
  })

  const invalid = [
    '[]', 'null', 'true', '{code:"x","description":"ok"}', '{"code":1,"description":"ok"}', '{"code":null,"description":"ok"}',
    '{"code":{},"description":"ok"}', '{"code":"x","description":false}', '{"code":"x","extra":"y","description":"ok"}',
    '{"code":"x","code":"y","description":"ok"}', '{"code":"x","co\\u0064e":"y","description":"ok"}',
    '{"description":"a","description":"b","code":"x"}', '{"code":"x"}', '{"description":"ok"}', '{}',
    '{"code":"x","description":"ok",}', '{"code":"x","description":"ok"}{}', '{"code":"x","description":"ok"}// comment',
    '{"code":"\\x41","description":"ok"}', '{"code":"\\u12xz","description":"ok"}', '{"code":"\n","description":"ok"}',
    '{"code":"\\ud83d","description":"ok"}', '{"code":"\\ude3a","description":"ok"}', '{"code":"\\ud83dA","description":"ok"}',
    '{"code":"\ud83d","description":"ok"}', '{"code":"\ude3a","description":"ok"}', '{"code":"x" "description":"ok"}',
    '{"code" "x","description":"ok"}', '\ufeff{"code":"x","description":"ok"}',
  ]
  for (const raw of invalid) test(`rejects malformed arguments ${JSON.stringify(raw)}`, () => {
    assert.throws(() => decode(raw.split('')))
  })

  test('rejects every incomplete prefix at finalization', () => {
    const raw = '{"description":"hello","code":"print(\\\"😺\\\")\\n"}'
    for (let end = 0; end < raw.length; end++) {
      const decoder = new CodeDeltas(), prefix = raw.slice(0, end)
      decoder.feed(prefix)
      assert.throws(() => decoder.finish(prefix), /incomplete/)
    }
  })

  test('a late protocol failure preserves the original failure and never emits a replacement', () => {
    const decoder = new CodeDeltas()
    assert.equal(decoder.feed('{"code":"await foo(1)\\n",'), 'await foo(1)\n')
    let failure
    try { decoder.feed('"code":"await foo(2)"}') } catch (error) { failure = error }
    assert.match(failure.message, /duplicate/)
    assert.throws(() => decoder.feed('anything'), error => error === failure)
    assert.throws(() => decoder.finish('{}'), error => error === failure)
  })

  test('final arguments must exactly match received raw JSON, even for equivalent objects', () => {
    const decoder = new CodeDeltas()
    decoder.feed('{"code":"a","description":"ok"}')
    assert.throws(() => decoder.finish('{"code":"\\u0061","description":"ok"}'), /differ/)
  })

  test('missing final arguments, non-string deltas and reuse after finish are rejected', () => {
    assert.throws(() => new CodeDeltas().feed(undefined), /strings/)
    const decoder = new CodeDeltas(), raw = '{"code":"x","description":"ok"}'
    decoder.feed(raw)
    assert.deepEqual(decoder.finish(raw), { code: 'x', description: 'ok' })
    assert.throws(() => decoder.feed(''), /already finished/)
    assert.throws(() => decoder.finish(raw), /already finished/)
    const missing = new CodeDeltas()
    missing.feed(raw)
    assert.throws(() => missing.finish(), /differ/)
  })
})
