// Live Share: the host's browser pages as links for its guests (with "See my
// browser pages"; nothing streams: no picture, no input). For each page of a
// shared project (a browser pane of its layout, and the side panel's pages
// while that project is on the host's screen) that the host does not hide
// from guests: its address as liveShareLink.js lets it go (http(s), no user
// or password, only the origin when something in it reads as a secret;
// local: it only opens on the host's computer or network), its title
// (secrets masked), and the state of its videos and sounds
// (liveShareMedia.js). The guest's Tessel opens the address in its own
// browser tab and follows it.
//
// Everything is read here from the page itself (its webContents: its
// address, title, navigations, in-page ones included: a single-page app's
// pushState or a hash change), never taken from the window's word. The
// window only says which pages there are and which the host hides.
//
// Media are read only for the pages a guest has on screen and follows
// (watchMedia: its 'media' subscription, one page at a time per guest),
// every MEDIA_POLL_MS (MEDIA_IDLE_MS while the page has none), in an
// isolated world of the page. A read that does not answer within
// PROBE_TIMEOUT_MS is not waited on, but no other read of that page starts
// until it settles, and the page is asked less and less often while it
// hangs (up to HUNG_MAX_MS). A project's links go out
// when they changed, at most every PUSH_MS, and while something plays every
// RESYNC_MS (liveShareMedia.js).
import { linkForGuest, linkTitle } from '../../shared/liveShareLink.js'
import { mediaProbeScript, cleanMedia, mediaChanged, anyPlaying, RESYNC_MS } from '../../shared/liveShareMedia.js'

export const LINK_FEED = Object.freeze({ listed: 64, pushMs: 250, mediaPollMs: 1000, mediaIdleMs: 3000, probeTimeoutMs: 1500, hungMaxMs: 60000, pagesPerProject: 32 })
const ID = /^[\w-]{1,80}$/
const MEDIA_WORLD = 1996
const NAV_EVENTS = ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-finish-load']

// guestById(webContentsId) -> webContents | null (browserGuest.js pageById:
// a browser page of the window). push(project, data): the project's links
// for its guests ({ pages }). maskTitle(text): the share's secret masking.
// -> { setPages(list, allowed), watch(project, on), links(project), stop() }
export function createLinkFeed({ guestById, push, maskTitle = (x) => x, timers = globalThis, clock = Date.now, log = null } = {}) {
  // page id -> { project, webContentsId, hidden, side, wc, off, media, mediaAt, probing, nextProbe }
  let listed = new Map()
  const projects = new Map() // project -> { json, sentAt, timer, mediaSentAt }
  const watched = new Set()
  // Pages whose media a guest follows: page id -> how many guests.
  const mediaWatched = new Map()
  let pollTimer = null

  const alive = (wc) => !!wc && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())
  function listen(entry) {
    const wc = entry.wc
    if (!alive(wc) || typeof wc.on !== 'function') return
    const changed = () => listed.get(entry.id) === entry && schedule(entry.project)
    const gone = () => {
      if (listed.get(entry.id) !== entry) return
      listed.delete(entry.id)
      schedule(entry.project)
    }
    for (const ev of NAV_EVENTS) wc.on(ev, changed)
    wc.once?.('destroyed', gone)
    entry.off = () => {
      for (const ev of NAV_EVENTS) wc.removeListener?.(ev, changed)
      wc.removeListener?.('destroyed', gone)
    }
  }
  function unlisten(entry) {
    try {
      entry.off?.()
    } catch {
      // gone
    }
    entry.off = null
  }

  // One page as its guests get it, or null (hidden, gone, nothing to send).
  function linkOf(entry) {
    if (entry.hidden || !alive(entry.wc)) return null
    let raw
    let title
    try {
      raw = entry.wc.getURL()
      title = entry.wc.getTitle()
    } catch {
      return null
    }
    const link = linkForGuest(raw)
    if (!link) return null
    return {
      id: entry.id,
      url: link.url,
      local: link.local,
      ...(link.trimmed ? { trimmed: true } : {}),
      title: linkTitle(title, maskTitle),
      ...(entry.side ? { side: true } : {}),
      // A page that only opens on the host's computer: nothing of it plays
      // on the guest's side.
      ...(!link.local && mediaWatched.has(entry.id) && entry.media && entry.media.length ? { media: entry.media } : {})
    }
  }
  function links(project) {
    const pages = []
    for (const entry of listed.values()) {
      if (entry.project !== project || pages.length >= LINK_FEED.pagesPerProject) continue
      const l = linkOf(entry)
      if (l) pages.push(l)
    }
    return { pages }
  }

  // A project's links go out when they changed, PUSH_MS apart at most.
  function schedule(project) {
    let p = projects.get(project)
    if (!p) projects.set(project, (p = { json: null, sentAt: 0, timer: null, mediaSentAt: 0 }))
    if (p.timer) return
    const wait = Math.max(0, p.sentAt + LINK_FEED.pushMs - clock())
    p.timer = timers.setTimeout(() => flush(project), wait)
    p.timer?.unref?.()
  }
  function flush(project, force = false) {
    let p = projects.get(project)
    if (!p) projects.set(project, (p = { json: null, sentAt: 0, timer: null, mediaSentAt: 0 }))
    if (p.timer) timers.clearTimeout(p.timer)
    p.timer = null
    const data = links(project)
    const json = JSON.stringify(data)
    if (!force && json === p.json) return
    p.json = json
    p.sentAt = clock()
    if (data.pages.some((l) => l.media && anyPlaying(l.media))) p.mediaSentAt = p.sentAt
    try {
      push(project, data)
    } catch (err) {
      log?.warn?.(`live share links: ${err && err.message}`) // i18n-ignore
    }
  }

  // --- Media, while a guest follows the project ------------------------------------
  function isLocal(entry) {
    try {
      const link = linkForGuest(entry.wc.getURL())
      return !link || link.local
    } catch {
      return true
    }
  }
  function probe(entry) {
    const wc = entry.wc
    if (entry.probing || !alive(wc) || typeof wc.executeJavaScriptInIsolatedWorld !== 'function') return
    entry.probing = true
    let timer = null
    let late = false
    // Not answered in time: given up on for now (asked again later, less
    // often each time), but this read stays the page's only one.
    timer = timers.setTimeout(() => {
      late = true
      entry.hung = (entry.hung || 0) + 1
      entry.nextProbe = clock() + Math.min(LINK_FEED.hungMaxMs, LINK_FEED.mediaIdleMs * 2 ** entry.hung)
    }, LINK_FEED.probeTimeoutMs)
    timer?.unref?.()
    Promise.resolve()
      .then(() => wc.executeJavaScriptInIsolatedWorld(MEDIA_WORLD, [{ code: mediaProbeScript() }]))
      .catch(() => undefined)
      .then((got) => {
        timers.clearTimeout(timer)
        entry.probing = false
        if (late || got === undefined || listed.get(entry.id) !== entry) return
        entry.hung = 0
        took(entry, cleanMedia(got) || [])
      })
  }
  function took(entry, media) {
    const now = clock()
    entry.nextProbe = now + (media.length ? LINK_FEED.mediaPollMs : LINK_FEED.mediaIdleMs)
    const elapsed = now - (entry.mediaAt || now)
    const before = entry.media
    entry.media = media
    entry.mediaAt = now
    const p = projects.get(entry.project)
    // A play, a pause, a jump: at once; while it plays, again every
    // RESYNC_MS so a guest that drifted is put back.
    if (mediaChanged(before, media, elapsed)) schedule(entry.project)
    else if (anyPlaying(media) && p && now - p.mediaSentAt >= RESYNC_MS) {
      if (!p.timer) {
        p.timer = timers.setTimeout(() => flush(entry.project, true), 0)
        p.timer?.unref?.()
      }
    }
  }
  function poll() {
    pollTimer = null
    if (!mediaWatched.size) return
    const now = clock()
    for (const entry of listed.values()) {
      if (!mediaWatched.has(entry.id) || entry.hidden || (entry.nextProbe || 0) > now) continue
      // A page only the host's side opens: nothing of it plays on a guest's.
      if (isLocal(entry)) continue
      probe(entry)
    }
    pollTimer = timers.setTimeout(poll, Math.min(LINK_FEED.mediaPollMs, 1000))
    pollTimer?.unref?.()
  }
  function startPoll() {
    if (!pollTimer && mediaWatched.size) poll()
  }

  return {
    // The window's list: [{ project, paneId, webContentsId, hidden, side }];
    // allowed(project, paneId, side): the project is shared and the page is
    // one of its layout's browser panes (or a side panel page, side).
    setPages(list, allowed) {
      const next = new Map()
      const wcs = new Set()
      for (const item of Array.isArray(list) ? list.slice(0, LINK_FEED.listed) : []) {
        if (!item || typeof item.paneId !== 'string' || !ID.test(item.paneId) || !Number.isSafeInteger(item.webContentsId)) continue
        if (next.has(item.paneId) || wcs.has(item.webContentsId)) continue
        let ok
        try {
          ok = !!allowed(item.project, item.paneId, item.side === true)
        } catch {
          ok = false
        }
        if (!ok) continue
        const wc = guestById(item.webContentsId)
        if (!alive(wc)) continue
        const was = listed.get(item.paneId)
        const same = was && was.wc === wc
        const entry = same ? was : { id: item.paneId, wc, off: null, media: null, mediaAt: 0, probing: false, nextProbe: 0 }
        entry.project = item.project
        entry.webContentsId = item.webContentsId
        entry.hidden = item.hidden === true
        entry.side = item.side === true
        // Hidden now: what it played is forgotten (nothing of it goes out).
        if (entry.hidden) entry.media = null
        if (!same) listen(entry)
        next.set(item.paneId, entry)
        wcs.add(item.webContentsId)
      }
      const touched = new Set()
      for (const [id, entry] of listed) {
        touched.add(entry.project)
        if (next.get(id) !== entry) unlisten(entry)
      }
      for (const entry of next.values()) touched.add(entry.project)
      listed = next
      for (const project of touched) schedule(project)
      startPoll()
    },
    // A guest follows a project's links (the first) or none does any more.
    watch(project, on) {
      if (on) watched.add(project)
      else watched.delete(project)
      if (on) flush(project, true)
    },
    // A guest has one of the project's pages on screen and follows it (on),
    // or no longer: its videos are read while at least one does.
    watchMedia(project, pageId, on) {
      const entry = listed.get(pageId)
      const n = (mediaWatched.get(pageId) || 0) + (on ? 1 : -1)
      if (n > 0) mediaWatched.set(pageId, n)
      else mediaWatched.delete(pageId)
      if (!on && n <= 0 && entry) {
        entry.media = null
        schedule(entry.project)
      }
      if (on && entry && entry.project === project) entry.nextProbe = 0
      startPoll()
    },
    // A project's links now ({ pages }), for a guest that starts following.
    links,
    stop() {
      for (const entry of listed.values()) unlisten(entry)
      listed = new Map()
      for (const p of projects.values()) if (p.timer) timers.clearTimeout(p.timer)
      projects.clear()
      watched.clear()
      mediaWatched.clear()
      if (pollTimer) timers.clearTimeout(pollTimer)
      pollTimer = null
    }
  }
}

// The guest's side: a host's links, checked (a host is not trusted with what
// it sends): each address made again by linkForGuest (so the rules are the
// guest's own), ids of the known shape, titles cut. -> { pages } | null.
export function checkLinks(data, maskTitle = (x) => x) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.pages) || data.pages.length > LINK_FEED.pagesPerProject) return null
  const pages = []
  for (const p of data.pages) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id) || pages.some((x) => x.id === p.id)) continue
    const link = linkForGuest(p.url)
    if (!link) continue
    const media = !link.local && p.media !== undefined ? cleanMedia(p.media) : null
    pages.push({ id: p.id, url: link.url, local: link.local, ...(link.trimmed || p.trimmed === true ? { trimmed: true } : {}), title: linkTitle(p.title, maskTitle), side: p.side === true, ...(media && media.length ? { media } : {}) })
  }
  return { pages }
}
