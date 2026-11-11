const whitespace = /[ \t\r\n]/
const hexDigit = /^[0-9a-f]$/i
const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** Strict, append-only decoding of { code: string, description: string } tool arguments. */
export class CodeDeltas {
  #state = 'object'
  #role
  #key
  #string = []
  #escape = ''
  #unicode = ''
  #highSurrogate = ''
  #seen = new Set()
  #values = {}
  #raw = []
  #error
  #finished = false

  #fail(message) {
    this.#error = new Error(`Invalid streaming Python arguments: ${message}`)
    throw this.#error
  }

  #assertOpen() {
    if (this.#error) throw this.#error
    if (this.#finished) throw new Error('Streaming Python arguments are already finished')
  }

  #startString(role) {
    this.#role = role
    this.#string = []
    this.#state = 'string'
  }

  #append(character, output) {
    const unit = character.charCodeAt(0)
    // A high surrogate is not a stable source character: a later raw/escaped low surrogate may complete it.
    if (this.#highSurrogate) {
      if (unit < 0xdc00 || unit > 0xdfff) this.#fail('unpaired Unicode surrogate')
      character = this.#highSurrogate + character
      this.#highSurrogate = ''
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      this.#highSurrogate = character
      return
    } else if (unit >= 0xdc00 && unit <= 0xdfff) this.#fail('unpaired Unicode surrogate')
    this.#string.push(character)
    if (this.#role === 'value' && this.#key === 'code') output.push(character)
  }

  #endString() {
    if (this.#highSurrogate) this.#fail('unpaired Unicode surrogate')
    const value = this.#string.join('')
    if (this.#role === 'key') {
      if (value !== 'code' && value !== 'description') this.#fail(`unknown field ${JSON.stringify(value)}`)
      if (this.#seen.has(value)) this.#fail(`duplicate field ${JSON.stringify(value)}`)
      this.#seen.add(value)
      this.#key = value
      this.#state = 'colon'
    } else {
      this.#values[this.#key] = value
      this.#state = 'separator'
    }
    this.#string = []
  }

  #closeObject() {
    if (this.#seen.size !== 2) this.#fail('both code and description are required')
    this.#state = 'end'
  }

  /** Return only newly decoded code characters; no repaired JSON or source is ever produced. */
  feed(delta) {
    this.#assertOpen()
    if (typeof delta !== 'string') this.#fail('argument deltas must be strings')
    if (!delta) return ''
    this.#raw.push(delta)
    const output = []
    // Visit each UTF-16 unit exactly once, even when transport chunks split an astral character.
    for (let index = 0; index < delta.length; index++) {
      const character = delta[index]
      if (this.#state === 'string') {
        if (this.#escape === 'unicode') {
          if (!hexDigit.test(character)) this.#fail('invalid Unicode escape')
          this.#unicode += character
          if (this.#unicode.length === 4) {
            this.#append(String.fromCharCode(Number.parseInt(this.#unicode, 16)), output)
            this.#unicode = ''
            this.#escape = ''
          }
        } else if (this.#escape === 'escape') {
          if (character === 'u') this.#escape = 'unicode'
          else {
            if (!Object.hasOwn(escapes, character)) this.#fail('invalid string escape')
            this.#append(escapes[character], output)
            this.#escape = ''
          }
        } else if (character === '\\') this.#escape = 'escape'
        else if (character === '"') this.#endString()
        else if (character.charCodeAt(0) < 0x20) this.#fail('unescaped control character')
        else this.#append(character, output)
        continue
      }
      if (whitespace.test(character)) continue
      switch (this.#state) {
        case 'object':
          if (character !== '{') this.#fail('expected an object')
          this.#state = 'first-key'
          break
        case 'first-key':
          if (character === '}') { this.#closeObject(); break }
          if (character !== '"') this.#fail('expected a field name')
          this.#startString('key')
          break
        case 'key':
          if (character !== '"') this.#fail('expected a field name')
          this.#startString('key')
          break
        case 'colon':
          if (character !== ':') this.#fail('expected a colon')
          this.#state = 'value'
          break
        case 'value':
          if (character !== '"') this.#fail('field values must be strings')
          this.#startString('value')
          break
        case 'separator':
          if (character === '}') this.#closeObject()
          else if (character === ',') this.#state = 'key'
          else this.#fail('expected a comma or closing brace')
          break
        case 'end': this.#fail('trailing content after the object')
      }
    }
    return output.join('')
  }

  /** Validate the provider's complete argument string. The host, not this decoder, authorizes successful EOF. */
  finish(finalArguments) {
    this.#assertOpen()
    if (typeof finalArguments !== 'string' || finalArguments !== this.#raw.join('')) this.#fail('final arguments differ from received deltas')
    if (this.#state !== 'end') this.#fail('incomplete argument object')
    const parsed = JSON.parse(finalArguments)
    if (parsed.code !== this.#values.code || parsed.description !== this.#values.description) this.#fail('decoded fields differ from final arguments')
    this.#finished = true
    return parsed
  }
}

/** Validate complete arguments with the same rules used before streaming effects. */
export function decodeArguments(source) {
  const decoder = new CodeDeltas()
  decoder.feed(source)
  return decoder.finish(source)
}
