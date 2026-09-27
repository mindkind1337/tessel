import { describe, it, expect } from 'vitest'
import { osc52Text } from '../../../shared/osc52'

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('OSC 52 clipboard', () => {
  it('decodes the text a program copies (UTF-8)', () => {
    expect(osc52Text(`c;${b64('hello world')}`)).toBe('hello world')
    expect(osc52Text(`;${b64('déjà vu')}`)).toBe('déjà vu')
  })
  it('never answers a clipboard read, nor bad data', () => {
    expect(osc52Text('c;?')).toBe(null)
    expect(osc52Text('c;')).toBe(null)
    expect(osc52Text('garbage')).toBe(null)
    expect(osc52Text('c;not base64!!')).toBe(null)
  })
})
