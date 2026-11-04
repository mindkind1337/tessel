// Pipes for the link: over an ssh2 exec channel (a Duplex stream whose
// `close` ends the channel and the daemon's connection with it), or over any
// Node stream pair, and an in-memory pair for tests.
import { type Duplex, type Readable, type Writable } from 'node:stream'
import { type Pipe } from './link'

/** A pipe over a Duplex such as an ssh2 exec channel. */
export function pipeFromDuplex(stream: Duplex): Pipe {
  return pipeFromStreams(stream, stream, () => stream.destroy())
}

/** A pipe over a readable and a writable (a child process's stdout and stdin), ended by `close`. */
export function pipeFromStreams(reader: Readable, writer: Writable, close: () => void): Pipe {
  let ended = false
  const endListeners: Array<(error?: Error) => void> = []
  const end = (error?: Error): void => {
    if (ended) return
    ended = true
    for (const l of endListeners.splice(0)) l(error)
  }
  reader.on('end', () => end())
  reader.on('close', () => end())
  reader.on('error', (e: Error) => end(e))
  writer.on('error', (e: Error) => end(e))
  if ((writer as unknown) !== (reader as unknown)) writer.on('close', () => end())
  return {
    onData(listener) {
      reader.on('data', (chunk: Buffer | string) => listener(typeof chunk === 'string' ? Buffer.from(chunk) : chunk))
    },
    onEnd(listener) {
      if (ended) listener()
      else endListeners.push(listener)
    },
    write(chunk) {
      if (ended) throw new Error('pipe ended')
      writer.write(chunk)
    },
    close() {
      try {
        close()
      } finally {
        end()
      }
    }
  }
}

class MemoryEnd implements Pipe {
  peer: MemoryEnd | null = null
  private readonly data: Array<(chunk: Buffer) => void> = []
  private readonly ends: Array<(error?: Error) => void> = []
  private done = false

  onData(listener: (chunk: Buffer) => void): void {
    this.data.push(listener)
  }

  onEnd(listener: (error?: Error) => void): void {
    if (this.done) listener()
    else this.ends.push(listener)
  }

  write(chunk: Buffer): void {
    if (this.done) throw new Error('pipe ended')
    // Delivered on a later turn, as a socket would.
    const peer = this.peer
    queueMicrotask(() => peer?.feed(chunk))
  }

  close(): void {
    this.ended()
    const peer = this.peer
    queueMicrotask(() => peer?.ended())
  }

  feed(chunk: Buffer): void {
    if (!this.done) for (const l of this.data) l(chunk)
  }

  ended(error?: Error): void {
    if (this.done) return
    this.done = true
    for (const l of this.ends.splice(0)) l(error)
  }
}

/** Two ends of an in-memory pipe: what one writes, the other reads. */
export function pipePair(): [Pipe, Pipe] {
  const a = new MemoryEnd()
  const b = new MemoryEnd()
  a.peer = b
  b.peer = a
  return [a, b]
}
