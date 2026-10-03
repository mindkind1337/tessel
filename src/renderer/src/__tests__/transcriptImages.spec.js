// The chat view of a terminal agent keeps the image bytes the main process
// sent once (src/main/chat/transcriptView.js sends later reads with keys only).
import { describe, expect, it } from 'vitest'
import { createTranscriptImages } from '../chat/transcriptImages.js'

const A = 'data:image/png;base64,iVBORw0KGgoAAAA'
const B = 'data:image/jpeg;base64,/9j/4AAQSkZJRg'
const KA = 'a'.repeat(24)
const KB = 'b'.repeat(24)
const user = (id, images) => ({ type: 'user', id, text: 'look', images })

describe('transcript view images', () => {
  it('rows keep their images when a later read sends only their keys', () => {
    const keep = createTranscriptImages()
    const first = keep.apply([user('u1', [{ key: KA, name: 'a.png', dataUrl: A }])])
    expect(first).toEqual({ events: [user('u1', [{ key: KA, name: 'a.png', dataUrl: A }])], missing: [] })
    const later = keep.apply([user('u1', [{ key: KA, name: 'a.png' }]), user('u2', [{ key: KB, name: 'b.jpg', dataUrl: B }]), { type: 'assistant', text: 'ok' }])
    expect(later.missing).toEqual([])
    expect(later.events[0].images[0].dataUrl).toBe(A)
    expect(later.events[1].images[0].dataUrl).toBe(B)
    expect(later.events[2]).toEqual({ type: 'assistant', text: 'ok' })
  })

  it('names the keys it lacks, takes them when sent again, and keeps only the latest page', () => {
    const keep = createTranscriptImages()
    const res = keep.apply([user('u1', [{ key: KA, name: 'a.png' }])])
    expect(res.missing).toEqual([KA])
    expect(res.events[0].images[0].dataUrl).toBeUndefined()
    keep.add({ [KA]: A, [KB]: 'javascript:alert(1)' })
    expect(keep.apply([user('u1', [{ key: KA, name: 'a.png' }])]).events[0].images[0].dataUrl).toBe(A)
    // A page without it: let go.
    keep.apply([user('u3', [])])
    expect(keep.size()).toBe(0)
    expect(keep.apply([user('u1', [{ key: KA, name: 'a.png' }])]).missing).toEqual([KA])
  })

  it('an image without a key (the chat pane history) passes as it is', () => {
    const keep = createTranscriptImages()
    const ev = user('u1', [{ name: 'x.png', dataUrl: A }])
    expect(keep.apply([ev]).events[0]).toBe(ev)
  })
})
