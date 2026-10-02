// Captures all PTY output into per-id ring buffers so a TerminalPane can replay
// its history when it is (re)mounted (e.g. after a split re-parents it in the
// component tree). The PTY itself lives in the terminal host and is never
// killed on unmount, so the session survives layout changes.
//
// Output is kept as a list of chunks with a running length: adding a chunk is
// O(1), and old chunks are dropped whole. (Concatenating one big string and
// slicing it on every chunk copied up to 200 KB per chunk, which stalled the
// window when agents printed a lot.)

import { ChunkBuffer } from '../../shared/chunkBuffer'

const MAX = 200_000 // ~200 KB of recent output kept per pane
const buffers = new Map() // id -> ChunkBuffer
let started = false

function bufferFor(id) {
  let b = buffers.get(id)
  if (!b) {
    b = new ChunkBuffer(MAX)
    buffers.set(id, b)
  }
  return b
}

export function startCapture() {
  if (started || !window.shellApi) return
  started = true
  window.shellApi.onData(({ id, data }) => bufferFor(id).push(data))
}

// Pre-fill a pane's history (output replayed from the terminal host) before
// the pane mounts.
export function seedBuffer(id, text) {
  if (!text) return
  bufferFor(id).unshift(text)
}

export function getBuffer(id) {
  const b = buffers.get(id)
  return b ? b.text() : ''
}

export function dropBuffer(id) {
  buffers.delete(id)
}
