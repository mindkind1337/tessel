// Live Share phase 2c in the window (main side: src/main/liveShare.js,
// liveShare/shareLinks.js, shareHistory.js, shareActivity.js), used by
// liveShareWindow.js.
//
// Host: the browser panes of every shared project (all its views: the grid
// and its task copies' Browser tabs), and the pages of the side panel while
// a shared project is on screen, go to main with their page's webContents id
// and your "Hide this page from guests" (setPages; main keeps only the panes
// of the layouts guests get, reads each page's address and title itself and
// sends guests links, never the page). The activity of the projects guests
// follow goes to main while they follow it (feeds), at most every
// ACTIVITY_MS, the newest events of each one (main masks them).
//
// Guest: with "See my browser pages", each of the host's pages is a tab of
// its own in a Live Share project: your own browser on its address (your
// session and cookies, never the host's), following the host's page (a new
// address, its videos playing or paused, liveShareMedia.js) until you go
// somewhere else in it yourself ("Follow host" on the page takes it up
// again). A page that only opens on the host's computer or network
// (localhost, a private address) is a note instead (LiveSharePageView.vue),
// never opened. The Agents tab of a Live Share project lists the host's past
// conversations of it (sessionSource), the Conversations tab and the
// Activity panel show its activity (activitySource, followed while one of
// them is shown) and what its terminal agents said.
import { reactive, watch } from 'vue'
import { t } from './i18n'
import { samePage } from '../../shared/liveShareLink'

// A page's address you changed yourself, this long after following last
// loaded one (a redirect of the address it loaded is not yours).
export const OWN_NAV_MS = 3000

// The activity sent to main at most this often.
export const ACTIVITY_MS = 2000
// Events of a project sent at most (main keeps 500).
const ACTIVITY_EVENTS = 600

function eachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') return fn(node)
  for (const c of node.children || []) eachLeaf(c, fn)
}
function hasLeaf(node, id) {
  let found = false
  eachLeaf(node, (l) => (found = found || l.id === id))
  return found
}

// deps (liveShareWindow.js's, plus): pageGuest(paneId) -> the webContents id
// of its page (reactive, browser/pageHost.js) or null; activityOf(wsId) ->
// { events, teams } (the project's activity: its own events, its panes' and
// its teams'); activityRev() -> changes when the activity log does.
// core: { api, state, hostSharing, sharedWss, isShared, guestWs }.
export function createLiveShareFeeds(deps, core) {
  const { api, state, hostSharing, sharedWss, isShared, guestWs } = core
  // Host: what main says guests follow.
  const feeds = reactive({ activity: [] })
  // Guest: the activity that came (project -> { events, teams }), and who
  // follows each project's (project -> count).
  const activity = reactive({})
  const following = new Map()
  // Guest: the host's pages as links (project -> { pages }), each one's tab
  // here (local pane id -> leaf: your browser on it, or a note), and the
  // ones you hid (local pane ids).
  const links = reactive({})
  const pageLeaves = new Map()
  const pageWatches = new Map() // local pane id -> stop()
  const hiddenPages = new Set()
  let mediaSeq = 0
  const stops = []
  const offs = []

  // --- Host: pages --------------------------------------------------------------
  // The side panel's pages ([{ id, hiddenFromGuests }]) go with the shared
  // project on screen (they belong to no project): none while another is.
  function sidePagesNow() {
    const cur = deps.currentWs ? deps.currentWs() : null
    if (!cur || !isShared(cur.id) || typeof deps.sidePages !== 'function') return []
    const list = deps.sidePages()
    return (Array.isArray(list) ? list : []).filter((b) => b && typeof b.id === 'string').map((b) => ({ project: cur.id, page: b }))
  }
  function pagesNow() {
    const out = []
    for (const ws of sharedWss()) {
      eachLeaf(ws.tree, (leaf) => {
        if (leaf.kind !== 'browser') return
        const id = deps.pageGuest ? deps.pageGuest(leaf.id) : null
        if (Number.isSafeInteger(id)) out.push({ project: ws.id, paneId: leaf.id, webContentsId: id, hidden: leaf.hiddenFromGuests === true })
      })
    }
    for (const { project, page } of sidePagesNow()) {
      const id = deps.pageGuest ? deps.pageGuest(page.id) : null
      if (Number.isSafeInteger(id)) out.push({ project, paneId: page.id, webContentsId: id, hidden: page.hiddenFromGuests === true, side: true })
    }
    return out
  }
  const sidePage = (paneId) => {
    const list = typeof deps.sidePages === 'function' ? deps.sidePages() : []
    return (Array.isArray(list) ? list : []).find((b) => b && b.id === paneId) || null
  }
  // A page of yours while sharing: whether guests may get it (in a project
  // you share, or of the side panel while one is on screen) and whether you
  // hide it from them.
  function pageShare(paneId) {
    if (!hostSharing() || !paneId) return null
    const ws = sharedWss().find((w) => hasLeaf(w.tree, paneId))
    if (ws) {
      const leaf = deps.findLeaf(paneId)
      return { project: ws.id, hidden: !!(leaf && leaf.hiddenFromGuests === true), watchers: [] }
    }
    const side = sidePagesNow().find((x) => x.page.id === paneId)
    return side ? { project: side.project, hidden: side.page.hiddenFromGuests === true, watchers: [] } : null
  }
  function setPageHidden(paneId, hidden) {
    const leaf = deps.findLeaf(paneId)
    const page = leaf && leaf.kind === 'browser' ? leaf : sidePage(paneId)
    if (!page) return false
    if (hidden) page.hiddenFromGuests = true
    else delete page.hiddenFromGuests
    return true
  }

  // --- Host: activity -------------------------------------------------------------
  let activityTimer = 0
  let activityAt = 0
  function sendActivity() {
    activityTimer = 0
    activityAt = Date.now()
    const a = api()
    if (!a || !a.setActivity || !hostSharing()) return
    const list = (feeds.activity || []).filter((id) => isShared(id))
    if (!list.length) return
    a.setActivity(
      list.map((project) => {
        const got = deps.activityOf ? deps.activityOf(project) : null
        const events = got && Array.isArray(got.events) ? got.events.slice(-ACTIVITY_EVENTS) : []
        return { project, events, teams: got && Array.isArray(got.teams) ? got.teams : [] }
      })
    )
  }
  function activityChanged() {
    if (activityTimer) return
    activityTimer = setTimeout(sendActivity, Math.max(0, activityAt + ACTIVITY_MS - Date.now()))
  }

  function onHost(s) {
    feeds.activity = s && s.feeds && Array.isArray(s.feeds.activity) ? s.feeds.activity : []
  }

  // --- Guest: pages, as links -------------------------------------------------------
  // A right the host gave, exactly (a host from before rights gives no page).
  const right = (r) => !!(state.guest.rights && state.guest.rights[r] === true)
  // The host's pages are shown with "See my browser pages".
  const showsPages = () => right('pagesView')
  const linkOf = (project, id) => {
    const got = links[project]
    return got ? got.pages.find((x) => x.id === id) || null : null
  }
  // A host's page here: your browser on its address (the same leaf each
  // time, so its page stays), or a note for an address that only works on
  // the host's side; null when you may not see it, it is hidden, or you hid
  // it.
  function pageLeaf(l, project, session) {
    const link = linkOf(project, l.id)
    return link && !hiddenPages.has(l.id) && showsPages() ? linkLeaf(link, project, session) : null
  }
  // The side panel's pages of the host's (no pane of its layout): tabs too.
  function sideLeaves(project, session) {
    const got = links[project]
    if (!got || !showsPages()) return []
    return got.pages.filter((x) => x.side && !hiddenPages.has(x.id)).map((x) => linkLeaf(x, project, session))
  }
  function linkLeaf(link, project, session) {
    const host = state.guest.host || ''
    let leaf = pageLeaves.get(link.id)
    const kind = link.local ? 'note' : 'browser'
    if (leaf && (leaf.liveShare.session !== session || leaf.liveShare.linkKind !== kind)) {
      dropPage(link.id)
      leaf = null
    }
    if (!leaf) {
      const base = { session, project, host, link: true, linkKind: kind, following: true, hostUrl: link.url, setAt: Date.now(), local: link.local, trimmed: !!link.trimmed, side: !!link.side, pageTitle: link.title, pageUrl: link.url, media: null }
      leaf = link.local
        ? reactive({
            // An address only the host's side opens: a note, never a page.
            type: 'leaf',
            id: link.id,
            shellId: 'liveshare',
            shellName: host || t('liveShare.title', 'Live Share'),
            title: link.title || t('liveShare.page.title', 'Browser page'),
            kind: 'shell',
            agentId: null,
            agentCommand: null,
            accent: null,
            worktree: null,
            backend: 'liveshare',
            pid: null,
            startDir: null,
            sessionId: null,
            liveShare: { ...base, cols: 0, rows: 0, kind: 'shell', agentId: null, canType: false, terminal: false, page: true, chat: null, view: 'page' },
            gen: 0,
            launchedAt: Date.now(),
            exitedAtStart: false,
            restoredText: '',
            broadcast: false
          })
        : reactive({
            // Your own browser on the host's page's address.
            type: 'leaf',
            kind: 'browser',
            id: link.id,
            title: link.title || '',
            url: link.url,
            zoom: null,
            focusAddress: 0,
            audible: false,
            muted: false,
            broadcast: false,
            backend: 'liveshare',
            liveShare: base
          })
      pageLeaves.set(link.id, leaf)
      if (!link.local) watchOwnNav(leaf)
    }
    applyLink(leaf, link, project)
    return leaf
  }
  // The host's page changed (an address, a title, its videos): followed by
  // your tab while it follows.
  function applyLink(leaf, link, project) {
    const ls = leaf.liveShare
    ls.project = project
    ls.host = state.guest.host || ''
    ls.pageTitle = link.title
    ls.pageUrl = link.url
    ls.trimmed = !!link.trimmed
    if (leaf.kind === 'browser') {
      if (!leaf.url || leaf.url === 'about:blank') leaf.title = link.title || leaf.title
      if (link.url !== ls.hostUrl) {
        ls.hostUrl = link.url
        if (ls.following) {
          ls.setAt = Date.now()
          leaf.url = link.url
        }
      }
      // Its videos and sounds, played as the host's (only while following,
      // on the same page).
      if (link.media && ls.following && samePage(leaf.url, link.url)) ls.media = { seq: ++mediaSeq, items: link.media, at: Date.now() }
    } else leaf.title = link.title || t('liveShare.page.title', 'Browser page')
  }
  // Your tab went somewhere else than the host's page (an address you typed,
  // a link you clicked, back or forward: not a redirect of the one following
  // loaded): it stops following that page.
  function watchOwnNav(leaf) {
    const stop = watch(
      () => leaf.url,
      (url) => {
        const ls = leaf.liveShare
        if (!ls.following || !url || samePage(url, ls.hostUrl)) return
        if (Date.now() - ls.setAt > OWN_NAV_MS) ls.following = false
      }
    )
    pageWatches.set(leaf.id, stop)
  }
  function dropPage(id) {
    pageWatches.get(id)?.()
    pageWatches.delete(id)
    pageLeaves.delete(id)
  }
  // "Follow host" on one of the host's pages: back to its address.
  function followPage(id) {
    const leaf = pageLeaves.get(id)
    if (!leaf || leaf.kind !== 'browser') return false
    leaf.liveShare.following = true
    leaf.liveShare.setAt = Date.now()
    leaf.url = leaf.liveShare.hostUrl
    return true
  }
  // Every page of a project follows the host's again, the ones you hid back.
  function followAll(project) {
    for (const leaf of pageLeaves.values()) {
      if (leaf.liveShare.project !== project) continue
      hiddenPages.delete(leaf.id)
      if (leaf.kind === 'browser') followPage(leaf.id)
    }
    for (const x of (links[project] && links[project].pages) || []) hiddenPages.delete(x.id)
  }
  // One of the host's pages closed here: hidden on your screen only.
  function hidePage(id) {
    if (!pageLeaves.has(id)) return false
    hiddenPages.add(id)
    return true
  }
  // What a page's note says (an address the host's side only opens):
  // { host, url, title } or null.
  function pageNote(id) {
    const leaf = pageLeaves.get(id)
    if (!leaf || leaf.kind === 'browser') return null
    return { host: leaf.liveShare.host || state.guest.host || '', url: leaf.liveShare.pageUrl || '', title: leaf.liveShare.pageTitle || '', ended: !(state.guest.state === 'joined' || state.guest.state === 'reconnecting') }
  }
  // The pages no longer in any of the host's layouts, nor of its side
  // panel, go.
  function syncPages(ids) {
    const side = new Set()
    for (const got of Object.values(links)) for (const x of got.pages) if (x.side) side.add(x.id)
    for (const id of [...pageLeaves.keys()]) if (!ids.has(id) && !side.has(id)) dropPage(id)
    for (const leaf of pageLeaves.values()) leaf.liveShare.host = state.guest.host || ''
  }

  // --- Guest: past conversations and activity ------------------------------------
  // Why a host project's history is not there: 'ok', 'no-access',
  // 'outdated-host' (the host's Tessel does not share it), 'ended'.
  function hostState(project) {
    const s = state.guest
    const inSession = s.state === 'joined' || s.state === 'reconnecting'
    if (!inSession) return 'ended'
    if (!(s.projects || []).some((p) => p.id === project)) return 'no-access'
    return s.state === 'joined' && !(Array.isArray(s.features) && s.features.includes('history')) ? 'outdated-host' : 'ok'
  }
  // The Agents tab of a Live Share project: the host's past conversations
  // of it (read only).
  function sessionSource(project) {
    if (!project) return null
    const a = api()
    return {
      project,
      host: state.guest.host || '',
      state: hostState(project),
      async list({ limit } = {}) {
        if (!a || !a.sessions) return { ok: false, code: 'offline' }
        return Promise.resolve(a.sessions({ op: 'list', project, args: { limit } })).catch(() => ({ ok: false, code: 'offline' }))
      },
      async details(ref) {
        if (!a || !a.sessions) return { ok: false }
        return Promise.resolve(a.sessions({ op: 'details', project, args: { ref } })).catch(() => ({ ok: false }))
      }
    }
  }
  // The Conversations tab and the Activity panel of a Live Share project:
  // the host's activity of it (followed while follow(true)), and what its
  // terminal agents said.
  function activitySource(project) {
    if (!project) return null
    const a = api()
    const got = activity[project]
    return {
      project,
      host: state.guest.host || '',
      state: hostState(project),
      events: got ? got.events : [],
      teams: got ? got.teams : [],
      loaded: !!got,
      follow: (on) => followActivity(project, on),
      async terminal({ from, known } = {}) {
        if (!a || !a.sessions) return { ok: false }
        return Promise.resolve(a.sessions({ op: 'terminal', project, args: { from, known } })).catch(() => ({ ok: false }))
      }
    }
  }
  function followActivity(project, on) {
    const a = api()
    const n = (following.get(project) || 0) + (on ? 1 : -1)
    if (n > 0) following.set(project, n)
    else following.delete(project)
    const was = on ? n - 1 : n + 1
    if (!a || typeof a.subscribe !== 'function' || (was > 0) === n > 0) return
    Promise.resolve(a.subscribe({ topic: 'activity', project, on: n > 0 }))
      .then((r) => {
        if (n > 0 && r && r.ok && r.data && Array.isArray(r.data.events) && following.has(project)) activity[project] = withWs(project, r.data)
      })
      .catch(() => {})
  }
  // The host's events, in this window's Live Share project.
  function withWs(project, data) {
    const ws = guestWs(state.guest.session, project)
    const wsId = ws ? ws.id : project
    return { events: data.events.map((e) => ({ ...e, wsId })), teams: Array.isArray(data.teams) ? data.teams : [] }
  }
  function onPush(m) {
    // The host's pages of a project, as links (none: the right went).
    if (m && m.topic === 'links' && typeof m.project === 'string') {
      const pages = m.data && Array.isArray(m.data.pages) ? m.data.pages : []
      if ((state.guest.projects || []).some((p) => p.id === m.project) && showsPages()) links[m.project] = { pages }
      else delete links[m.project]
      return true
    }
    if (!m || m.topic !== 'activity' || typeof m.project !== 'string' || !m.data || !Array.isArray(m.data.events)) return false
    if ((state.guest.projects || []).some((p) => p.id === m.project) && following.has(m.project)) activity[m.project] = withWs(m.project, m.data)
    return true
  }

  function endGuest() {
    for (const id of [...pageLeaves.keys()]) dropPage(id)
    hiddenPages.clear()
    for (const k of Object.keys(links)) delete links[k]
    following.clear()
    for (const k of Object.keys(activity)) delete activity[k]
  }
  // A project the host no longer shows you: its activity goes.
  function syncProjects(ids) {
    for (const k of Object.keys(activity)) if (!ids.has(k)) delete activity[k]
    for (const k of [...following.keys()]) if (!ids.has(k)) following.delete(k)
    for (const k of Object.keys(links)) if (!ids.has(k)) delete links[k]
    // "See my browser pages" taken away: the pages go.
    if (!showsPages()) for (const k of Object.keys(links)) delete links[k]
  }

  function init(a) {
    if (a.onFeeds) offs.push(a.onFeeds((m) => (feeds.activity = m && Array.isArray(m.activity) ? m.activity : [])))
    stops.push(
      // Your browser panes in the shared projects, for main (its check
      // against the layouts guests get), at once and whenever they change.
      watch(
        () => (hostSharing() ? JSON.stringify(pagesNow()) : ''),
        (text) => {
          if (text && a.setPages) a.setPages(JSON.parse(text))
        },
        { immediate: true }
      ),
      // The activity of the projects guests follow, while they do.
      watch(
        () => (hostSharing() && (feeds.activity || []).length ? `${feeds.activity.join(',')}|${deps.activityRev ? deps.activityRev() : 0}` : ''),
        (key) => key && activityChanged(),
        { immediate: true }
      )
    )
  }
  function dispose() {
    for (const off of offs.splice(0)) if (typeof off === 'function') off()
    for (const stop of stops.splice(0)) stop()
    clearTimeout(activityTimer)
  }

  return { feeds, activity, links, init, dispose, onHost, onPush, pageShare, setPageHidden, pageLeaf, sideLeaves, showsPages, syncPages, followPage, followAll, hidePage, pageNote, sessionSource, activitySource, endGuest, syncProjects }
}
