// Live Share: the layout the host's window shows, as plain data for its
// guests, and the tree a guest's window builds back from it. The shape is
// the one src/main/liveShare.js keeps (cleanLayout): splits ({ type: 'split',
// dir, sizes, children }) and panes ({ type: 'leaf', id, view, title, kind,
// agentId, accent }). Pure functions: App sends the one and draws the other.
//
// The host's agent panes whose conversation guests can look at as a chat
// (hostChatsFromWorkspace: where it is, for the host's main only, which never
// sends it to guests), and the guest's own leaves for them: a pane the host
// has in chat mode (no terminal) is kept in a guest's tree like a terminal
// when the guest's window has a leaf for it.
import { reactive } from 'vue'
import { workspaceViews } from './paneViews'
import { isRemotePath, parseRemotePath } from '../../shared/remotePath.js'

const VIEWS = ['editor', 'browser', 'chat']

function hasLeaf(node, id) {
  if (!node || !id) return false
  if (node.type === 'leaf') return node.id === id
  return (node.children || []).some((c) => hasLeaf(c, id))
}

function layoutNode(node) {
  if (!node) return null
  if (node.type === 'leaf') {
    const view = VIEWS.includes(node.kind) ? node.kind : 'terminal'
    return {
      type: 'leaf',
      id: node.id,
      view,
      // Only terminals are shared: the others' names (a file, a page) are not
      // sent, their place is.
      title: view === 'terminal' ? node.paneName || node.title || '' : '',
      kind: node.kind === 'agent' ? 'agent' : 'shell',
      agentId: node.agentId || null,
      accent: node.accent || null
    }
  }
  const children = (node.children || []).map(layoutNode).filter(Boolean)
  if (!children.length) return null
  return { type: 'split', dir: node.dir, sizes: (node.sizes || []).slice(), children }
}

// What the host's window shows: the project shared (a Tessel workspace
// { name, tree, activeId }), the view of it on screen (a project's task
// copies each have their own, paneViews.js: only that one), the tab shown
// there (its grid, 'terminal', or an editor or a browser pane), the task
// copy it is (its branch: guests' note says which), and its fullscreen pane.
function shownView(ws) {
  const views = workspaceViews(ws)
  return views.find((v) => v.active) || views[0] || null
}
function shownTree(ws) {
  const onScreen = shownView(ws)
  return onScreen ? onScreen.tree : ws.tree
}
// The branch of the task copy a view is ('' for the project's own folder).
function copyOf(view) {
  if (!view || view.key === ':main') return ''
  let branch = ''
  const walk = (n) => {
    if (!n || branch) return
    if (n.type === 'leaf') branch = (n.worktree && typeof n.worktree.branch === 'string' && n.worktree.branch) || ''
    else (n.children || []).forEach(walk)
  }
  walk(view.tree)
  return branch
}

export function hostLayoutFromWorkspace(ws, maximizedId = null) {
  if (!ws) return null
  const view = shownView(ws)
  const tree = layoutNode(view ? view.tree : ws.tree)
  const shown = view ? view.shown : 'terminal'
  return {
    project: ws.name || null,
    tree,
    activeId: hasLeaf(tree, ws.activeId) ? ws.activeId : null,
    maximizedId: hasLeaf(tree, maximizedId) ? maximizedId : null,
    shown: shown === 'terminal' || hasLeaf(tree, shown) ? shown : null,
    copy: copyOf(view) || null
  }
}

// The host's editor tabs of a project (host-only: main keeps the ones inside
// the project's folder that guests may see, liveShare/shareTabs.js): the
// files of its editor panes, in tree order (a diff or a commit's version is
// not a file), and the file on screen (the editor shown, its current file).
export function hostTabsFromWorkspace(ws) {
  const files = []
  let active = null
  if (!ws || !ws.tree) return { files, active }
  const view = shownView(ws)
  const walk = (n) => {
    if (!n) return
    if (n.type !== 'leaf') return (n.children || []).forEach(walk)
    if (n.kind !== 'editor') return
    for (const f of n.files || []) if (f && !f.diff && typeof f.path === 'string' && !isRemotePath(f.path) && !files.includes(f.path) && files.length < 64) files.push(f.path)
    if (view && view.shown === n.id && typeof n.activePath === 'string' && files.includes(n.activePath)) active = n.activePath
  }
  walk(ws.tree)
  return { files, active }
}

// The agents whose conversation file Tessel reads (src/main/chat/
// transcriptView.js TRANSCRIPT_VIEW_AGENTS): their panes' conversations can
// be shown to guests.
export const GUEST_CHAT_AGENTS = ['claude', 'openclaude', 'codex', 'cursor', 'antigravity', 'grok', 'omp']
// On an SSH host only these (src/main/chat/remoteTranscripts.js): the host's
// own chat view reads the same two there.
export const GUEST_REMOTE_CHAT_AGENTS = ['claude', 'codex']
const isLocalDir = (p) => typeof p === 'string' && !!p && !isRemotePath(p)
// A folder inside (or equal to) another: Windows folders without case.
const dirWithin = (p, top, win) => {
  const norm = (x) => {
    const v = String(x).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
    return win ? v.toLowerCase() : v
  }
  const a = norm(p)
  const b = norm(top)
  return !!b && (a === b || a.startsWith(`${b}/`))
}
// A folder on an SSH host, as its own path (guests' chats name files by it).
const hostDir = (p) => {
  const parsed = typeof p === 'string' ? parseRemotePath(p) : null
  return parsed && parsed.path.startsWith('/') ? parsed.path : null
}

// The agent panes of the project's view on screen whose conversation guests
// can look at as a chat: a terminal agent, or a pane in chat mode (terminal:
// false), whose conversation is known: of this computer, or of an SSH host
// (Claude Code, Codex: read over the connection, as the host's own chat view
// does). Where it is (the agent, its session, its account or SSH host) and the
// project's folders (paths outside them are hidden from guests) are for the
// host's main only. A terminal agent with no conversation to send is listed
// too, with the reason (reason: 'agent' | 'none'), so the guest's chat
// button says why it cannot open instead of being missing.
export function hostChatsFromWorkspace(ws) {
  if (!ws) return []
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type !== 'leaf') return (n.children || []).forEach(walk)
    const chat = n.kind === 'chat'
    if (!(n.kind === 'agent' || chat) || typeof n.agentId !== 'string') return
    const remote = !!(n.remoteHostId || (typeof n.cwd === 'string' && isRemotePath(n.cwd)))
    const readable = remote ? !n.detected && GUEST_REMOTE_CHAT_AGENTS.includes(n.agentId) && typeof n.remoteHostId === 'string' : GUEST_CHAT_AGENTS.includes(n.agentId)
    const known = typeof n.sessionId === 'string' && !!n.sessionId
    if (!readable || !known) {
      // A pane in chat mode is a chat already; only terminals get the note.
      if (chat) return
      out.push({ id: n.id, agentId: n.agentId, terminal: true, title: '', reason: !readable ? 'agent' : 'none' })
      return
    }
    // The project's folder, and the pane's own folders only when inside it:
    // a pane opened elsewhere (the home folder, another repository) never
    // makes that folder's paths readable to guests (main checks it again).
    const top = remote ? (ws.remote && typeof ws.remote.path === 'string' && ws.remote.path.startsWith('/') ? ws.remote.path : null) : isLocalDir(ws.cwd) ? ws.cwd : null
    const paneDirs = remote
      ? [hostDir(n.cwd), hostDir(n.startDir), hostDir(n.projectDir), n.remotePath].filter((p) => typeof p === 'string' && p.startsWith('/'))
      : [n.startDir, n.cwd, n.projectDir, n.worktree && n.worktree.path].filter(isLocalDir)
    const roots = top ? [top, ...paneDirs.filter((p) => dirWithin(p, top, !remote))] : []
    out.push({
      id: n.id,
      agentId: n.agentId,
      sessionId: n.sessionId,
      ...(remote ? { hostId: n.remoteHostId } : {}),
      ...(!remote && (typeof n.accountId === 'string' || n.accountId === null) ? { accountId: n.accountId } : {}),
      terminal: !chat,
      // A pane in chat mode has no name in the layout (only terminals do).
      title: chat ? n.paneName || n.title || '' : '',
      roots: [...new Set(roots)]
    })
  }
  walk(shownTree(ws))
  return out
}

// A guest's tree from the host's layout (its pane ids already this window's).
// getLeaf(layoutLeaf) gives the pane to show there (the same reactive leaf
// each time, so its terminal is not opened again) or null. Only terminals are
// shared: other panes are left out, the panes beside them share their room,
// and a split left with one pane is that pane. A split's id comes from where
// it is in the host's tree, so building again after each change of the host
// gives the same ids and Vue keeps the terminals (SplitNode's :key). null
// when nothing is left. pages: the guest may see the host's browser pages
// (its "See my browser pages"): a browser pane is kept too (getLeaf gives
// the guest's own browser on its address, or null when the host sent no
// link for it: hidden, or not one the guest may see).
export function buildGuestTree(layout, getLeaf, { pages = false } = {}) {
  const build = (node, path) => {
    if (!node) return null
    // A terminal, or a pane in chat mode the guest's window shows as a chat.
    if (node.type === 'leaf') return node.view === 'terminal' || node.view === 'chat' || (pages && node.view === 'browser') ? getLeaf(node) || null : null
    const kept = []
    ;(node.children || []).forEach((c, i) => {
      const built = build(c, `${path}-${i}`)
      if (built) kept.push({ node: built, size: Number(node.sizes && node.sizes[i]) || 0 })
    })
    if (!kept.length) return null
    if (kept.length === 1) return kept[0].node
    const total = kept.reduce((sum, k) => sum + k.size, 0)
    const sizes = kept.map((k) => (total > 0 ? (k.size / total) * 100 : 100 / kept.length))
    const id = `ls-split-${path}` // i18n-ignore
    return reactive({ type: 'split', id, dir: node.dir === 'col' ? 'col' : 'row', sizes, children: kept.map((k) => k.node) })
  }
  return build(layout && layout.tree, 'r')
}
