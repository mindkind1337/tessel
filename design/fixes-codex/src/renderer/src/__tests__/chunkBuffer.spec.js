import { describe, it, expect } from 'vitest'
import { ChunkBuffer } from '../../../shared/chunkBuffer'

describe('ChunkBuffer', () => {
  it('keeps everything under the limit', () => {
    const b = new ChunkBuffer(100)
    b.push('hello ')
    b.push('world')
    expect(b.text()).toBe('hello world')
    expect(b.length).toBe(11)
  })

  it('keeps only the most recent characters over the limit', () => {
    const b = new ChunkBuffer(10)
    for (let i = 0; i < 20; i++) b.push(String(i % 10))
    expect(b.text()).toBe('0123456789')
    expect(b.length).toBe(10)
  })

  it('cuts inside the oldest chunk when needed', () => {
    const b = new ChunkBuffer(8)
    b.push('abcdef')
    b.push('ghij')
    expect(b.text()).toBe('cdefghij')
  })

  it('handles one huge chunk', () => {
    const b = new ChunkBuffer(5)
    b.push('0123456789')
    expect(b.text()).toBe('56789')
  })

  it('unshift puts older text in front (and still respects the limit)', () => {
    const b = new ChunkBuffer(12)
    b.push('new')
    b.unshift('old-')
    expect(b.text()).toBe('old-new')
    b.unshift('much-older-')
    // 'much-older-old-new' is 18 characters: the oldest 6 are dropped.
    expect(b.text()).toBe('lder-old-new')
    expect(b.length).toBe(12)
  })

  it('is fast with many small chunks', () => {
    const b = new ChunkBuffer(200_000)
    const chunk = 'x'.repeat(2400)
    const t0 = performance.now()
    for (let i = 0; i < 20000; i++) b.push(chunk)
    const ms = performance.now() - t0
    expect(b.length).toBe(200_000)
    expect(ms).toBeLessThan(500)
  })
})
