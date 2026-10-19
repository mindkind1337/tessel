// Live Share phase 2c in the window (main side: src/main/liveShare.js,
// liveShare/sharePageFeed.js, shareHistory.js, shareActivity.js), used by
// liveShareWindow.js.
//
// Host: the browser panes of every shared project (all its views: the grid
// and its task copies' Browser tabs) go to main with their page's
// webContents id and your "Hide this page from guests" (setPages; main keeps
// only the panes of the layouts guests get, never a page of the side
// panel); which of your pages guests watch comes back (pagesWatched: the eye
// on the page). The activity of the projects guests follow goes to main
// while they follow it (feeds), at most every ACTIVITY_MS, the newest
// events of each one (main masks them).
//
// Guest: the host's browser panes are leaves of their own in a Live Share
// project (pageLeaf: LiveSharePageView.vue) while you may see its pages; a
// page view watches its page only while it is on screen (pageSource), and
// sends your clicks and keys with "Use my browser pages". The Agents tab of
// a Live Share project lists the host's past conversations of it
// (sessionSource), the Conversations tab and the Activity panel show its
// activity (activitySource, followed while one of them is shown) and what
// its terminal agents said.
import { reactive, watch } from 'vue'
import { t } from './i18n'
import { personName } from './liveShareAccess'

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
  // Host: what main says guests follow and watch.
  const feeds = reactive({ activity: [], pagesWatched: [] })
  // Guest: the activity that came (project -> { events, teams }), and who
  // follows each project's (project -> count).
  const activity = reactive({})
  const following = new Map()
  // Guest: the host's pages shown here (local pane id -> leaf).
  const pageLeaves = new Map()
  const frameListeners = new Set()
  const eventListeners = new Set()
  const stops = []
  const offs = []

  // --- Host: pages --------------------------------------------------------------
  function pagesNow() {
    const out = []
    for (const ws of sharedWss()) {
      eachLeaf(ws.tree, (leaf) => {
        if (leaf.kind !== 'browser') return
        const id = deps.pageGuest ? deps.pageGuest(leaf.id) : null
        if (Number.isSafeInteger(id)) out.push({ project: ws.id, paneId: leaf.id, webContentsId: id, hidden: leaf.hiddenFromGuests === true })
      })
    }
    return out
  }
  // A page of yours while sharing: whether it is in a project you share,
  // whether you hide it from guests, and who watches it.
  function pageShare(paneId) {
    if (!hostSharing() || !paneId) return null
    const ws = sharedWss().find((w) => hasLeaf(w.tree, paneId))
    if (!ws) return null
    const leaf = deps.findLeaf(paneId)
    const entry = (feeds.pagesWatched || []).find((p) => p && p.id === paneId)
    const inNow = (state.host.guests || []).filter((g) => g.state === 'joined')
    const watchers = entry && Array.isArray(entry.guests) ? entry.guests.map((g) => inNow.find((x) => x.id === g.id)).filter(Boolean).map(personName) : []
    return { project: ws.id, hidden: !!(leaf && leaf.hiddenFromGuests === true), watchers }
  }
  function setPageHidden(paneId, hidden) {
    const leaf = deps.findLeaf(paneId)
    if (!leaf || leaf.kind !== 'browser') return false
    if (hidden) leaf.hiddenFromGuests = true
    else delete leaf.hiddenFromGuests
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
    feeds.pagesWatched = s && Array.isArray(s.pagesWatched) ? s.pagesWatched : []
  }

  // --- Guest: pages ---------------------------------------------------------------
  // A host's browser pane here (the same leaf each time, so its view stays).
  function pageLeaf(l, project, session) {
    let leaf = pageLeaves.get(l.id)
    if (leaf && leaf.liveShare.session === session) {
      leaf.liveShare.project = project
      return leaf
    }
    const host = state.guest.host || ''
    leaf = reactive({
      type: 'leaf',
      id: l.id,
      shellId: 'liveshare',
      shellName: host || t('liveShare.title', 'Live Share'),
      title: t('liveShare.page.title', 'Browser page'),
      kind: 'shell',
      agentId: null,
      agentCommand: null,
      accent: null,
      worktree: null,
      backend: 'liveshare',
      pid: null,
      startDir: null,
      sessionId: null,
      // No terminal: the host's page, as frames (LiveSharePageView.vue), in
      // a tab of its own as on the host's screen (paneViews.js isTabLeaf);
      // pageTitle and pageUrl: what its last frame said (its tab's name).
      liveShare: { session, project, cols: 0, rows: 0, kind: 'shell', agentId: null, canType: false, host, terminal: false, page: true, chat: null, view: 'page', pageTitle: '', pageUrl: '' },
      gen: 0,
      launchedAt: Date.now(),
      exitedAtStart: false,
      restoredText: '',
      broadcast: false
    })
    pageLeaves.set(l.id, leaf)
    return leaf
  }
  // A right the host gave, exactly (a host from before rights gives no page).
  const right = (r) => !!(state.guest.rights && state.guest.rights[r] === true)
  // The host's pages are shown with "See my browser pages" (a host whose
  // Tessel does not share them yet: its page views say so).
  const showsPages = () => right('pagesView')
  // The pages no longer in any of the host's layouts go.
  function syncPages(ids) {
    for (const id of [...pageLeaves.keys()]) if (!ids.has(id)) pageLeaves.delete(id)
    for (const leaf of pageLeaves.values()) leaf.liveShare.host = state.guest.host || ''
  }
  // A page view's source: its state, watching (only while it is on screen),
  // input, frames and news. id: the pane's id here.
  function pageSource(id) {
    const a = api()
    if (!a || typeof a.pageWatch !== 'function') return null
    return {
      info() {
        const g = state.guest
        const leaf = pageLeaves.get(id)
        return {
          host: g.host || '',
          joined: g.state === 'joined',
          ended: !(g.state === 'joined' || g.state === 'reconnecting'),
          outdated: g.state === 'joined' && !(Array.isArray(g.features) && g.features.includes('pages')),
          canView: right('pagesView'),
          canUse: right('pagesView') && right('pagesUse'),
          project: leaf ? leaf.liveShare.project : null
        }
      },
      watch: (on) => Promise.resolve(a.pageWatch({ id, on })).catch(() => ({ ok: false, code: 'offline' })),
      input: (events) => a.pageInput && a.pageInput({ id, events }),
      onFrame(cb) {
        const fn = (m) => m && m.id === id && cb(m)
        frameListeners.add(fn)
        return () => frameListeners.delete(fn)
      },
      onEvent(cb) {
        const fn = (m) => m && m.id === id && cb(m)
        eventListeners.add(fn)
        return () => eventListeners.delete(fn)
      }
    }
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
    if (!m || m.topic !== 'activity' || typeof m.project !== 'string' || !m.data || !Array.isArray(m.data.events)) return false
    if ((state.guest.projects || []).some((p) => p.id === m.project) && following.has(m.project)) activity[m.project] = withWs(m.project, m.data)
    return true
  }

  function endGuest() {
    pageLeaves.clear()
    following.clear()
    for (const k of Object.keys(activity)) delete activity[k]
  }
  // A project the host no longer shows you: its activity goes.
  function syncProjects(ids) {
    for (const k of Object.keys(activity)) if (!ids.has(k)) delete activity[k]
    for (const k of [...following.keys()]) if (!ids.has(k)) following.delete(k)
  }

  function init(a) {
    if (a.onFeeds) offs.push(a.onFeeds((m) => (feeds.activity = m && Array.isArray(m.activity) ? m.activity : [])))
    if (a.onPagesWatched) offs.push(a.onPagesWatched((list) => (feeds.pagesWatched = Array.isArray(list) ? list : [])))
    if (a.onPageFrame) offs.push(a.onPageFrame((m) => frameListeners.forEach((fn) => fn(m))))
    if (a.onPageEvent) offs.push(a.onPageEvent((m) => eventListeners.forEach((fn) => fn(m))))
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

  return { feeds, activity, init, dispose, onHost, onPush, pageShare, setPageHidden, pageLeaf, showsPages, syncPages, pageSource, sessionSource, activitySource, endGuest, syncProjects }
}
