// @vitest-environment node
// Live Share: the host's pages as links (shared/liveShareLink.js,
// liveShare/shareLinks.js), their videos followed (shared/liveShareMedia.js),
// and the host's editor tabs (liveShare/shareTabs.js). What an address may
// carry to a guest (http(s), no user or password, its origin only when
// something in it reads as a secret, local when only the host's side opens
// it); the feed reads each page itself, follows its navigations (in-page
// too), never sends a hidden page, reads videos only while a guest follows
// and only past a real change or every few seconds while one plays; the
// guest re-checks everything; tabs are paths from the project's folder,
// never a hidden or an outside file.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { join } from 'path'
import { linkForGuest, linkTitle, samePage } from '../../shared/liveShareLink'
import { probeMedia, applyMedia, mediaApplyScript, mediaProbeScript, cleanMedia, mediaChanged, DRIFT_S, RESYNC_MS } from '../../shared/liveShareMedia'
import { createLinkFeed, checkLinks, LINK_FEED } from '../liveShare/shareLinks'
import { cleanHostTabs, tabRels, guestTabs, checkTabs } from '../liveShare/shareTabs'

describe('an address as a guest gets it', () => {
  it('the whole address when nothing in it reads as a secret (a video at its time, a search)', () => {
    expect(linkForGuest('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toEqual({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s', local: false, trimmed: false })
    expect(linkForGuest('https://www.google.com/search?q=youtube')).toMatchObject({ url: 'https://www.google.com/search?q=youtube', trimmed: false })
    expect(linkForGuest('https://app.test/#/settings/profile')).toMatchObject({ url: 'https://app.test/#/settings/profile', trimmed: false })
    expect(linkForGuest('https://blog.test/2024-05-01-my-post')).toMatchObject({ trimmed: false })
  })

  it('never a user or a password; http(s) only', () => {
    expect(linkForGuest('https://ada:hunter2@site.test/a').url).toBe('https://site.test/a')
    for (const bad of ['file:///C:/x.txt', 'javascript:alert(1)', 'chrome://settings', 'about:blank', 'data:text/html,hi', '', 'not a url', null]) expect(linkForGuest(bad)).toBe(null)
  })

  it('only the origin when a parameter, a fragment or a path segment reads as a secret', () => {
    for (const raw of [
      'https://mail.example/reset?token=abc123',
      'https://api.test/x?key=1',
      'https://login.test/cb?code=4/0AY0e',
      'https://site.test/?password=x',
      'https://site.test/?client_secret=y',
      'https://site.test/?auth=z',
      'https://s3.test/f?X-Amz-Signature=deadbeef',
      'https://app.test/cb#access_token=ya29.a0Af',
      'https://share.test/s/9f8e7d6c5b4a39281706f5e4d3c2b1a0',
      'https://docs.google.com/document/d/1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT/edit',
      'https://site.test/invite/q7w8e9r0t1y2'
    ]) {
      const got = linkForGuest(raw)
      expect(got.trimmed, raw).toBe(true)
      expect(got.url, raw).toBe(`${new URL(raw).origin}/`)
    }
    // A parameter merely named like one is not ("author").
    expect(linkForGuest('https://news.test/list?author=ada&page=2').trimmed).toBe(false)
  })

  it('local: only the host side opens it (still sent, never opened by the guest)', () => {
    for (const raw of ['http://localhost:5173/', 'http://127.0.0.1:8080/x', 'http://192.168.1.20/', 'http://10.0.0.5/', 'http://nas.local/', 'http://[::1]:3000/', 'http://intranet/']) expect(linkForGuest(raw).local, raw).toBe(true)
    expect(linkForGuest('https://example.com/').local).toBe(false)
  })

  it('a title is one line, masked, cut', () => {
    expect(linkTitle('  Inbox\n(3)\u200b ', (x) => x.replace('Inbox', 'Mail'))).toBe('Mail (3)')
    expect(linkTitle('x'.repeat(500))).toHaveLength(200)
    expect(samePage('https://a.example.com/p?x=1', 'https://a.example.com/p/?y=2')).toBe(true)
    expect(samePage('https://a.example.com/p', 'https://a.example.com/q')).toBe(false)
  })
})

// A page as the host's main process sees it.
function fakeWc(url, title = 'Page', media = []) {
  const ev = new EventEmitter()
  const wc = {
    url,
    title,
    media,
    destroyed: false,
    isDestroyed: () => wc.destroyed,
    getURL: () => wc.url,
    getTitle: () => wc.title,
    on: (e, fn) => ev.on(e, fn),
    once: (e, fn) => ev.once(e, fn),
    removeListener: (e, fn) => ev.removeListener(e, fn),
    listeners: (e) => ev.listenerCount(e),
    emit: (e, ...a) => ev.emit(e, ...a),
    executeJavaScriptInIsolatedWorld: vi.fn(async () => wc.media)
  }
  return wc
}

describe('the host feed of links', () => {
  afterEach(() => vi.useRealTimers())

  function setup(pages) {
    vi.useFakeTimers()
    const byId = new Map(pages.map((p, i) => [i + 1, p]))
    const pushes = []
    const feed = createLinkFeed({ guestById: (id) => byId.get(id) || null, push: (project, data) => pushes.push({ project, data: JSON.parse(JSON.stringify(data)) }), maskTitle: (t) => t.replace(/sk-\w+/g, '••••') })
    const allowed = (project, id, side) => project === 'ws-1' && (side || id.startsWith('pane-'))
    return { feed, pushes, allowed, last: (project = 'ws-1') => pushes.filter((p) => p.project === project).at(-1) }
  }

  it('reads each page itself; a hidden one and one of no layout are never sent; a navigation (in-page too) goes out', async () => {
    const a = fakeWc('https://a.example.com/one', 'One sk-abcdef123')
    const b = fakeWc('https://b.example.com/', 'Two')
    const c = fakeWc('https://c.example.com/', 'Three')
    const { feed, last, allowed } = setup([a, b, c])
    feed.setPages(
      [
        { project: 'ws-1', paneId: 'pane-a', webContentsId: 1 },
        { project: 'ws-1', paneId: 'pane-b', webContentsId: 2, hidden: true },
        { project: 'ws-1', paneId: 'other', webContentsId: 3 },
        { project: 'ws-2', paneId: 'pane-c', webContentsId: 3 },
        { project: 'ws-1', paneId: '../x', webContentsId: 3 }
      ],
      allowed
    )
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data).toEqual({ pages: [{ id: 'pane-a', url: 'https://a.example.com/one', local: false, title: 'One ••••' }] })
    a.url = 'https://a.example.com/two'
    a.emit('did-navigate-in-page', {}, a.url)
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data.pages[0].url).toBe('https://a.example.com/two')
    // Taken off the list: its listeners go.
    feed.setPages([], allowed)
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data).toEqual({ pages: [] })
    expect(a.listeners('did-navigate')).toBe(0)
    feed.stop()
  })

  it('a side panel page is marked side; a destroyed page goes', async () => {
    const s = fakeWc('https://docs.example.com/', 'Docs')
    const { feed, last, allowed } = setup([s])
    feed.setPages([{ project: 'ws-1', paneId: 'web-side1', webContentsId: 1, side: true }], allowed)
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data.pages).toEqual([{ id: 'web-side1', url: 'https://docs.example.com/', local: false, title: 'Docs', side: true }])
    s.destroyed = true
    s.emit('destroyed')
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data.pages).toEqual([])
    feed.stop()
  })

  it('videos are read only while a guest follows, sent on a change, again every few seconds while one plays, never for a local page', async () => {
    const playing = [{ kind: 'video', i: 0, paused: false, ended: false, t: 10, rate: 1 }]
    const a = fakeWc('https://video.example.com/w', 'Video', playing)
    const dev = fakeWc('http://localhost:3000/', 'Dev', playing)
    const { feed, pushes, last, allowed } = setup([a, dev])
    feed.setPages(
      [
        { project: 'ws-1', paneId: 'pane-a', webContentsId: 1 },
        { project: 'ws-1', paneId: 'pane-dev', webContentsId: 2 }
      ],
      allowed
    )
    await vi.advanceTimersByTimeAsync(3000)
    expect(a.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    feed.watch('ws-1', true)
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 50)
    expect(a.executeJavaScriptInIsolatedWorld).toHaveBeenCalled()
    expect(a.executeJavaScriptInIsolatedWorld.mock.calls[0][1][0].code).toBe(mediaProbeScript())
    expect(dev.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(last().data.pages.find((p) => p.id === 'pane-a').media).toEqual(playing)
    expect(last().data.pages.find((p) => p.id === 'pane-dev').media).toBeUndefined()
    // Playing on as expected: no push each second...
    const count = pushes.length
    for (let s = 1; s <= 3; s++) {
      a.media = [{ ...playing[0], t: 10 + s }]
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(pushes.length).toBe(count)
    // ...but every few seconds, so a guest that drifted is put back.
    for (let s = 4; s <= 6; s++) {
      a.media = [{ ...playing[0], t: 10 + s }]
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(pushes.length).toBeGreaterThan(count)
    // A pause or a jump: at once.
    const before = pushes.length
    a.media = [{ ...playing[0], paused: true, t: 16 }]
    await vi.advanceTimersByTimeAsync(1000 + LINK_FEED.pushMs)
    expect(pushes.length).toBe(before + 1)
    expect(last().data.pages.find((p) => p.id === 'pane-a').media[0].paused).toBe(true)
    // Nobody follows: reading stops.
    feed.watch('ws-1', false)
    const reads = a.executeJavaScriptInIsolatedWorld.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(a.executeJavaScriptInIsolatedWorld.mock.calls.length).toBe(reads)
    // Hidden: what it played is forgotten.
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 1, hidden: true }], allowed)
    await vi.advanceTimersByTimeAsync(LINK_FEED.pushMs + 10)
    expect(last().data.pages).toEqual([])
    feed.stop()
  })

  it('a page that does not answer is never waited on', async () => {
    const a = fakeWc('https://video.example.com/w', 'Video')
    a.executeJavaScriptInIsolatedWorld = vi.fn(() => new Promise(() => {}))
    const { feed, allowed } = setup([a])
    feed.setPages([{ project: 'ws-1', paneId: 'pane-a', webContentsId: 1 }], allowed)
    feed.watch('ws-1', true)
    await vi.advanceTimersByTimeAsync(LINK_FEED.probeTimeoutMs + LINK_FEED.mediaIdleMs + 1100)
    expect(a.executeJavaScriptInIsolatedWorld.mock.calls.length).toBeGreaterThanOrEqual(2)
    feed.stop()
  })

  it('the guest checks the host links again (its own rules)', () => {
    const got = checkLinks({
      pages: [
        { id: 'pane-a', url: 'https://ada:pw@a.example.com/reset?token=1', title: 'A', media: [{ kind: 'video', i: 0, paused: false, ended: false, t: 5, rate: 1 }] },
        { id: '../x', url: 'https://b.example.com/' },
        { id: 'pane-c', url: 'file:///C:/secret.txt' },
        { id: 'pane-d', url: 'http://localhost:1/', media: [{ kind: 'video', i: 0, paused: false, ended: false, t: 5, rate: 1 }] },
        { id: 'pane-e', url: 'https://e.example.com/', media: [{ kind: 'iframe', i: 0 }] }
      ]
    })
    expect(got.pages).toEqual([
      { id: 'pane-a', url: 'https://a.example.com/', local: false, trimmed: true, title: 'A', side: false, media: [{ kind: 'video', i: 0, paused: false, ended: false, t: 5, rate: 1 }] },
      { id: 'pane-d', url: 'http://localhost:1/', local: true, title: '', side: false },
      { id: 'pane-e', url: 'https://e.example.com/', local: false, title: '', side: false }
    ])
    expect(checkLinks({ pages: 'x' })).toBe(null)
    expect(checkLinks({ pages: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, url: 'https://a.example.com/' })) })).toBe(null)
  })
})

describe('videos followed on the guest copy', () => {
  const doc = (els) => ({ querySelectorAll: () => els })
  const media = (tag, extra = {}) => ({ tagName: tag, paused: true, ended: false, currentTime: 0, playbackRate: 1, play: vi.fn(function () { this.paused = false; return Promise.resolve() }), pause: vi.fn(function () { this.paused = true }), ...extra })

  it('the host reads kind, place, play state, time and speed only', () => {
    const els = [media('VIDEO', { paused: false, currentTime: 12.5, src: 'https://cdn.test/v.mp4?sig=SECRET' }), media('AUDIO', { currentTime: 3 }), media('VIDEO', { playbackRate: 2 })]
    const got = probeMedia(doc(els))
    expect(got).toEqual([
      { kind: 'video', i: 0, paused: false, ended: false, t: 12.5, rate: 1 },
      { kind: 'audio', i: 0, paused: true, ended: false, t: 3, rate: 1 },
      { kind: 'video', i: 1, paused: true, ended: false, t: 0, rate: 2 }
    ])
    expect(JSON.stringify(got)).not.toContain('SECRET')
  })

  it('the guest plays, pauses, sets the speed, and jumps only past the drift', () => {
    const v = media('VIDEO', { currentTime: 10 })
    const a = media('AUDIO', { paused: false, currentTime: 4 })
    applyMedia(doc([v, a]), [{ kind: 'video', i: 0, paused: false, ended: false, t: 11, rate: 1.5 }, { kind: 'audio', i: 0, paused: true, ended: false, t: 4.2, rate: 1 }, { kind: 'video', i: 3, paused: false, ended: false, t: 0, rate: 1 }], DRIFT_S)
    expect(v.play).toHaveBeenCalled()
    expect(v.currentTime).toBe(10) // 1 s off: no jump
    expect(v.playbackRate).toBe(1.5)
    expect(a.pause).toHaveBeenCalled()
    applyMedia(doc([v]), [{ kind: 'video', i: 0, paused: false, ended: false, t: 20, rate: 1.5 }], DRIFT_S)
    expect(v.currentTime).toBe(20) // 10 s off: put back
  })

  it('the script the guest page runs holds only checked numbers, and does the same', () => {
    const code = mediaApplyScript([{ kind: 'video', i: 0, paused: false, ended: false, t: 10, rate: 1, evil: '"); alert(1); ("' }, { kind: 'x' }], 2000)
    expect(code).not.toContain('alert')
    expect(mediaApplyScript([{ kind: 'video', i: 0, paused: false, ended: false, t: 10, rate: 1 }, { kind: 'x' }])).toContain('[]')
    const v = media('VIDEO', { currentTime: 0 })
    // eslint-disable-next-line no-new-func -- the page's own way of running it
    new Function('document', `return ${mediaApplyScript([{ kind: 'video', i: 0, paused: false, ended: false, t: 10, rate: 1 }], 2000)}`)(doc([v]))
    // Played for 2 s since the host read it: 12 s.
    expect(v.currentTime).toBe(12)
    expect(v.play).toHaveBeenCalled()
  })

  it('a change is a play, a pause, a speed or a jump, not time passing', () => {
    const at = (t, paused = false) => [{ kind: 'video', i: 0, paused, ended: false, t, rate: 1 }]
    expect(mediaChanged(at(10), at(11), 1000)).toBe(false)
    expect(mediaChanged(at(10), at(15), 1000)).toBe(true)
    expect(mediaChanged(at(10), at(10, true), 1000)).toBe(true)
    expect(mediaChanged(at(10, true), at(10, true), 5000)).toBe(false)
    expect(mediaChanged([], at(0), 0)).toBe(true)
    expect(cleanMedia([{ kind: 'video', i: 0, t: -1 }])).toBe(null)
    expect(cleanMedia([{ kind: 'video', i: 0, t: 1, rate: 99 }])[0].rate).toBe(1)
    expect(RESYNC_MS).toBe(5000)
  })
})

describe('the host editor tabs', () => {
  const root = join('C:\\', 'work', 'site')
  const info = { root, real: root }
  it('only the files inside the project, as paths from it, without what is hidden by its name', () => {
    const tabs = cleanHostTabs({ files: [join(root, 'src', 'a.js'), join(root, '.env'), join(root, '.git', 'config'), join(root, '.tessel', 'team', 'tok', 'inbox.json'), join('C:\\', 'other', 'x.js'), join(root, 'src', 'a.js'), 42], active: join(root, 'src', 'a.js') })
    expect(tabs.files).toHaveLength(5)
    const rels = tabRels(tabs, info, { hideIgnored: true })
    expect(rels).toEqual({ rels: ['src/a.js'], active: 'src/a.js' })
    // The setting off: secret names show, .git and .tessel never.
    expect(tabRels(tabs, info, { hideIgnored: false }).rels).toEqual(['src/a.js', '.env'])
    expect(tabRels(tabs, null, {})).toEqual({ rels: [], active: null })
    // Git-ignored ones (the scope's check) go too.
    expect(guestTabs({ rels: ['src/a.js', 'dist/out.js'], active: 'dist/out.js' }, new Set(['dist/out.js']))).toEqual({ tabs: ['src/a.js'], active: null })
  })
  it('the guest takes only paths of the known shape', () => {
    expect(checkTabs({ tabs: ['src/a.js', '../x', 'C:/y', 'a\\b', 'src/a.js', 7], active: '../x' })).toEqual({ tabs: ['src/a.js'], active: null })
    expect(checkTabs({ tabs: 'x' })).toBe(null)
  })
})
