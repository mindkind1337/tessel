// @vitest-environment node
// The recorded sessions of tessel-host (fixtures/sessions/*.jsonl at commit
// 23b62ac, copied to ./fixtures): the frames this client sends must match the
// `client` lines (random identifiers aside), and it must accept every `host`
// line. git and tree are replayed through the real sessions; the terminal
// and editor recordings, which this client does not drive yet, must at least
// decode frame by frame.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '../client'
import { Git, type GitEvent } from '../git'
import { Tree, type TreeEvent } from '../tree'
import { pipePair } from '../pipe'
import { type Pipe } from '../link'
import { decodeFrame } from '../wire'
import { parseClientFrames } from './fakeHost'
import { FrameReader } from '../wire'

interface Line {
  from: 'client' | 'host'
  frame: Record<string, unknown>
}

const load = (name: string): Line[] =>
  fs
    .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)

const encode = (frame: unknown): Buffer => {
  const json = Buffer.from(JSON.stringify(frame))
  const out = Buffer.alloc(4 + json.length)
  out.writeUInt32BE(json.length, 0)
  json.copy(out, 4)
  return out
}

/**
 * Plays the host's side of a recording: each client frame the client sends is
 * compared with the next `client` line, then the `host` lines that follow it
 * are sent. Resolves when the recording is over.
 */
function scriptedHost(lines: Line[], hostEnd: Pipe): { done: Promise<void>; sent: Record<string, unknown>[] } {
  const reader = new FrameReader()
  const sent: Record<string, unknown>[] = []
  let at = 0
  const playHost = (): void => {
    while (at < lines.length && lines[at]!.from === 'host') hostEnd.write(encode(lines[at++]!.frame))
  }
  const done = new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (at >= lines.length) resolve()
    }
    hostEnd.onData((chunk) => {
      let frames: Record<string, unknown>[]
      try {
        frames = parseClientFrames(reader, chunk)
      } catch (e) {
        reject(e)
        return
      }
      for (const frame of frames) {
        sent.push(frame)
        const expected = lines[at]
        if (!expected || expected.from !== 'client') {
          reject(new Error(`unexpected client frame ${JSON.stringify(frame)} at line ${at + 1}`))
          return
        }
        try {
          expect(frame).toEqual(expected.frame)
        } catch (e) {
          reject(e)
          return
        }
        at++
        playHost()
        check()
      }
    })
    playHost()
    check()
  })
  return { done, sent }
}

describe('recorded sessions', () => {
  it('git.jsonl: open the root and the repository, subscribe, apply the status and acknowledge it', async () => {
    const lines = load('git.jsonl')
    const [clientEnd, hostEnd] = pipePair()
    const host = scriptedHost(lines, hostEnd)
    const client = await Client.connect(async () => clientEnd, { capabilities: ['pty', 'tree', 'editor', 'git'] })
    expect(client.info?.version).toBe('0.1.0')
    expect(client.epoch).toBe('0'.repeat(31) + '1')
    const events: GitEvent[] = []
    const git = await Git.open(client, '/home/user/project', [], (e) => events.push(e))
    expect(git.opened.toplevel).toBe('/home/user/project')
    await host.done
    expect(events).toHaveLength(2)
    const first = events[0]!
    const second = events[1]!
    if (first.kind !== 'changed' || second.kind !== 'changed') throw new Error('not status events')
    expect(first.change.reset).toBe(true)
    expect(first.change.upsert[0]).toMatchObject({ kind: 'untracked', xy: '??', path: ['dW50cmFja2VkLnR4dA=='] })
    expect(second.change.reset).toBe(false)
    expect(second.change.upsert[0]).toMatchObject({ kind: 'changed', xy: '.M', path: ['YS50eHQ='] })
    expect(second.change.state.branch?.head).toBe('main')
    client.close()
  })

  it('tree.jsonl: open the root, subscribe, expand it, apply a change and acknowledge it', async () => {
    const lines = load('tree.jsonl')
    const [clientEnd, hostEnd] = pipePair()
    const host = scriptedHost(lines, hostEnd)
    const client = await Client.connect(async () => clientEnd, { capabilities: ['pty', 'tree', 'editor', 'git'] })
    const events: TreeEvent[] = []
    const tree = await Tree.open(client, '/home/user/project', (e) => events.push(e))
    expect(tree.label).toBe('/home/user/project')
    const listing = await tree.expand([])
    expect(listing.watched).toBe(true)
    expect(listing.entries.map((e) => e.label)).toEqual(['README.md', 'src'])
    await host.done
    expect(events).toHaveLength(1)
    const event = events[0]!
    if (event.kind !== 'changed') throw new Error('not a change')
    expect(event.change.added[0]?.label).toBe('new.txt')
    expect(event.change.revision).toBe(1)
    client.close()
  })

  it('terminal.jsonl and editor.jsonl: every host frame decodes, every client frame has a request or an ack', () => {
    for (const name of ['terminal.jsonl', 'editor.jsonl']) {
      const lines = load(name)
      expect(lines.length).toBeGreaterThan(4)
      for (const line of lines) {
        if (line.from === 'host') {
          const frame = decodeFrame(encode(line.frame).subarray(4))
          expect(frame.version).toBe(1)
          expect(frame.reply_to !== undefined || frame.stream !== undefined || frame.error !== undefined).toBe(true)
        } else {
          expect(typeof line.frame.request_id === 'number' || typeof line.frame.ack === 'object').toBe(true)
        }
      }
    }
  })
})
