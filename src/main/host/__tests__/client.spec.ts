// @vitest-environment node
// The link and the client: requests and their replies, the in-flight budget,
// timeouts, streams in order (older dropped, a jump flagged, acknowledgments
// after the handler), a lost connection, and reconnection with the sessions
// resumed on the same daemon or a restarted one.
import { describe, it, expect, vi } from 'vitest'
import { Client, type ConnectionState } from '../client'
import { Link, Opening, type StreamItem } from '../link'
import { Git, type GitEvent } from '../git'
import { Tree, type TreeEvent } from '../tree'
import { pipePair } from '../pipe'
import { HostError, LinkError, SLOW_HOST } from '../wire'
import { FakeHost, fakeConnector, type Script } from './fakeHost'

const EPOCH_A = 'a'.repeat(32)
const EPOCH_B = 'b'.repeat(32)
const ROOT = 'c'.repeat(32)
const REPO = 'd'.repeat(32)
const STREAM = 'e'.repeat(32)
const STREAM2 = 'f'.repeat(32)

const basics: Script = (kind, body) => {
  switch (kind) {
    case 'ping':
      return { ok: 'pong' }
    case 'root.open':
      return { ok: 'root.opened', body: { root: ROOT, label: (body as { path: string }).path, limits: { max_watches: 8192, exclusions: [] } } }
    case 'git.open':
      return { ok: 'git.opened', body: { repo: REPO, toplevel: '/p', features: { untracked_cache: false, fsmonitor: false, git_version: 'git version 2.43.0' } } }
    case 'git.subscribe':
      return { ok: 'git.subscribed', body: { stream: STREAM, revision: 0 } }
    case 'git.refresh':
    case 'tree.collapse':
    case 'tree.unsubscribe':
    case 'git.unsubscribe':
      return { ok: 'done' }
    case 'tree.subscribe':
      return { ok: 'tree.subscribed', body: { stream: STREAM2, revision: 0 } }
    case 'tree.expand':
      return { ok: 'tree.listing', body: { path: (body as { path: string[] }).path, revision: 0, entries: [], watched: true, excluded: false, truncated: false } }
    default:
      return { error: 'unsupported_kind' }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const until = async (test: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await tick()
  }
}

async function openLink(script: Script = basics, epoch = EPOCH_A): Promise<{ link: Link; host: FakeHost }> {
  const [clientEnd, hostEnd] = pipePair()
  const host = new FakeHost(hostEnd, epoch, script)
  const link = await Link.open(async () => clientEnd, ['tree', 'git'], SLOW_HOST, 1000)
  return { link, host }
}

describe('link', () => {
  it('says hello first and matches replies to requests', async () => {
    const { link, host } = await openLink()
    expect(host.seen[0]).toMatchObject({ request_id: 1, kind: 'hello', body: { versions: [1], capabilities: ['tree', 'git'], budgets: SLOW_HOST } })
    expect(link.hello.host_epoch).toBe(EPOCH_A)
    const [a, b] = await Promise.all([link.request('ping', undefined, 1000), link.request('root.open', { path: '/x' }, 1000)])
    expect(a.kind).toBe('pong')
    expect(b.body).toMatchObject({ label: '/x' })
    expect(host.seen.slice(1).map((s) => s.request_id)).toEqual([2, 3])
    link.shutdown()
  })

  it('a refusal is a HostError with its code; a timeout and a lost connection are LinkErrors', async () => {
    const { link, host } = await openLink((kind, body, id, h) => (kind === 'slow' ? null : kind === 'nope' ? { error: 'not_found' } : basics(kind, body, id, h)))
    await expect(link.request('nope', undefined, 1000)).rejects.toMatchObject({ name: 'HostError', code: 'not_found', retryable: false })
    await expect(link.request('slow', undefined, 30)).rejects.toMatchObject({ name: 'LinkError', reason: 'timeout' })
    const pending = link.request('slow', undefined, 5000)
    host.drop()
    await expect(pending).rejects.toMatchObject({ reason: 'connection_lost' })
    expect(link.alive).toBe(false)
    await expect(link.request('ping', undefined, 1000)).rejects.toBeInstanceOf(LinkError)
  })

  it('no more than in_flight requests wait for the host at once; the next go when one is answered', async () => {
    const held: number[] = []
    const [clientEnd, hostEnd] = pipePair()
    const host = new FakeHost(hostEnd, EPOCH_A, (kind, body, id, h) => {
      if (kind === 'hold') {
        held.push(id)
        return null
      }
      return basics(kind, body, id, h)
    })
    const link = await Link.open(async () => clientEnd, ['git'], { ...SLOW_HOST, in_flight: 2 }, 1000)
    const requests = [1, 2, 3].map(() => link.request('hold', undefined, 5000))
    await until(() => held.length === 2)
    await tick()
    expect(held).toHaveLength(2)
    host.reply(held[0]!, 'done')
    await until(() => held.length === 3)
    host.reply(held[1]!, 'done')
    host.reply(held[2]!, 'done')
    await Promise.all(requests)
    link.shutdown()
  })

  it('streams: events in order, an older one dropped, a jump flagged as a gap, each acknowledged after its handler', async () => {
    const { link, host } = await openLink()
    const got: StreamItem[] = []
    let release: () => void = () => {}
    const slow = new Promise<void>((r) => (release = r))
    // Events before the claim wait as orphans and are delivered first, in order.
    host.event(STREAM, 1, 'git.changed', { n: 1 })
    await tick()
    link.register(STREAM, async (item) => {
      got.push(item)
      if (item.seq === 1) await slow
    })
    host.event(STREAM, 2, 'git.changed', { n: 2 })
    host.event(STREAM, 2, 'git.changed', { n: 'again' })
    host.event(STREAM, 1, 'git.changed', { n: 'older' })
    host.event(STREAM, 5, 'git.changed', { n: 5 })
    await tick()
    await tick()
    expect(host.seen.filter((s) => s.ack)).toHaveLength(0)
    release()
    await until(() => got.length === 3)
    expect(got.map((g) => [g.seq, g.gap])).toEqual([
      [1, false],
      [2, false],
      [5, true]
    ])
    await until(() => host.seen.filter((s) => s.ack).length === 3)
    expect(host.seen.filter((s) => s.ack).map((s) => s.ack!.seq)).toEqual([1, 2, 5])
    link.shutdown()
  })

  it('a frame breaking the contract ends the link', async () => {
    const { link, host } = await openLink()
    const closed = new Promise<void>((r) => link.onClose(r))
    const bad = Buffer.alloc(4)
    bad.writeUInt32BE(2 * 1024 * 1024, 0)
    host.raw(bad)
    await closed
    expect(link.alive).toBe(false)
  })

  it('opening: no hello in time is a timeout and the pipe is closed; a cancel abandons it', async () => {
    const [clientEnd, hostEnd] = pipePair()
    let hostClosed = false
    hostEnd.onEnd(() => (hostClosed = true))
    await expect(Link.open(async () => clientEnd, ['git'], SLOW_HOST, 30)).rejects.toMatchObject({ reason: 'timeout' })
    await tick()
    expect(hostClosed).toBe(true)
    const opening = new Opening()
    const never = Link.open(() => new Promise(() => {}), ['git'], SLOW_HOST, 5000, opening)
    opening.cancel()
    await expect(never).rejects.toMatchObject({ reason: 'connection_lost' })
  })

  it('a refused hello is the host’s error', async () => {
    const [clientEnd, hostEnd] = pipePair()
    hostEnd.onData(() => {
      const body = Buffer.from('{"version":1,"reply_to":1,"error":{"code":"unsupported_version","retryable":false}}')
      const out = Buffer.alloc(4 + body.length)
      out.writeUInt32BE(body.length, 0)
      body.copy(out, 4)
      hostEnd.write(out)
    })
    await expect(Link.open(async () => clientEnd, ['git'], SLOW_HOST, 1000)).rejects.toMatchObject({ name: 'HostError', code: 'unsupported_version' })
  })
})

describe('client', () => {
  it('connects, asks host.info once, and answers requests; a request while reconnecting is connection_lost', async () => {
    const c = fakeConnector(() => EPOCH_A, basics)
    const client = await Client.connect(c.connect, { connectTimeout: 1000, requestTimeout: 1000, maxBackoff: 50 })
    expect(client.info?.arch).toBe('x86_64')
    expect(c.hosts[0]!.seen.map((s) => s.kind)).toEqual(['hello', 'host.info'])
    expect(client.state).toEqual({ kind: 'connected', epoch: EPOCH_A })
    expect((await client.ask<{ label: string }>('root.open', { path: '/p' })).label).toBe('/p')
    await expect(client.ask('nope')).rejects.toBeInstanceOf(HostError)
    client.close()
    expect(client.state).toEqual({ kind: 'closed' })
    await expect(client.ask('ping')).rejects.toMatchObject({ reason: 'connection_lost' })
  })

  it('reconnects after a drop with a growing pause, and resumes a git session on the same daemon (subscribe again)', async () => {
    const c = fakeConnector(() => EPOCH_A, basics)
    const client = await Client.connect(c.connect, { connectTimeout: 1000, requestTimeout: 2000, maxBackoff: 50 })
    const states: ConnectionState[] = []
    client.onState((s) => states.push(s))
    const events: GitEvent[] = []
    const git = await Git.open(client, '/p', [], (e) => events.push(e))
    expect(git.opened.repo).toBe(REPO)
    c.hosts[0]!.event(STREAM, 1, 'git.changed', { revision: 1, reset: true, upsert: [], removed: [], state: { complete: true, stale: false, truncated: false, slow: false, coverage_complete: true, duration_ms: 1 } })
    await until(() => events.length === 1)
    c.hosts[0]!.drop()
    await until(() => events.length === 2)
    expect(events[1]).toEqual({ kind: 'disconnected' })
    await until(() => c.hosts.length === 2 && client.state.kind === 'connected')
    expect(states.map((s) => s.kind)).toEqual(['reconnecting', 'connected'])
    // The same daemon: subscribed again, the root and repository not reopened.
    await until(() => c.hosts[1]!.seen.some((s) => s.kind === 'git.subscribe'))
    expect(c.hosts[1]!.seen.map((s) => s.kind)).toEqual(['hello', 'git.subscribe'])
    c.hosts[1]!.event(STREAM, 1, 'git.changed', { revision: 1, reset: true, upsert: [], removed: [], state: { complete: true, stale: false, truncated: false, slow: false, coverage_complete: true, duration_ms: 1 } })
    await until(() => events.length === 3)
    client.close()
  })

  it('a restarted daemon (another epoch): the tree opens its root again by path, subscribes, relists what was expanded', async () => {
    let epoch = EPOCH_A
    const c = fakeConnector(() => epoch, basics)
    const client = await Client.connect(c.connect, { connectTimeout: 1000, requestTimeout: 2000, maxBackoff: 50 })
    const events: TreeEvent[] = []
    const tree = await Tree.open(client, '/p', (e) => events.push(e))
    await tree.expand([])
    await tree.expand(['c3Jj'])
    epoch = EPOCH_B
    c.hosts[0]!.drop()
    await until(() => client.state.kind === 'restarted')
    expect(client.state).toEqual({ kind: 'restarted', previous: EPOCH_A, current: EPOCH_B })
    await until(() => events.filter((e) => e.kind === 'relisted').length === 2)
    expect(c.hosts[1]!.seen.map((s) => s.kind)).toEqual(['hello', 'root.open', 'tree.subscribe', 'tree.expand', 'tree.expand'])
    expect(events[0]).toEqual({ kind: 'disconnected' })
    client.close()
  })

  it('retrying waits through a reconnection; a request that takes too long overall gives up', async () => {
    const c = fakeConnector(() => EPOCH_A, basics)
    const client = await Client.connect(c.connect, { connectTimeout: 1000, requestTimeout: 1500, maxBackoff: 50 })
    c.hosts[0]!.drop()
    const answer = await client.retrying(() => client.ask<{ kind: string }>('ping'))
    expect(answer).toBeUndefined() // pong has no body
    expect(c.hosts.length).toBe(2)
    client.close()
    await expect(client.retrying(() => client.ask('ping'))).rejects.toMatchObject({ reason: 'connection_lost' })
  })

  it('close during a reconnection abandons it and stays closed', async () => {
    vi.useRealTimers()
    let attempts = 0
    const c = fakeConnector(() => EPOCH_A, basics)
    const connector = async (signal: AbortSignal): Promise<Awaited<ReturnType<typeof c.connect>>> => {
      attempts++
      if (attempts === 1) return c.connect(signal)
      return new Promise(() => {})
    }
    const client = await Client.connect(connector, { connectTimeout: 200, requestTimeout: 500, maxBackoff: 50 })
    c.hosts[0]!.drop()
    await until(() => client.state.kind === 'reconnecting')
    client.close()
    expect(client.state).toEqual({ kind: 'closed' })
    await new Promise((r) => setTimeout(r, 300))
    expect(client.state).toEqual({ kind: 'closed' })
    expect(attempts).toBe(2)
  })
})
