// Live Share: others join your Tessel from their own Tessel and see what
// you see (the projects you share, their layouts, their terminals and agents
// live), type in your panes, open new terminals and agents, and close panes.
//
// Host: Share starts a server on 127.0.0.1 (liveShare/shareHost.js) and a
// Cloudflare quick tunnel to it (liveShare/shareTunnel.js), with a first
// invitation. Each invitation (liveShare/shareAccess.js) is an invite code of
// its own: the share's address with the invitation's path, and a secret that
// encrypts everything (liveShare/shareCrypto.js); with a label, a lifetime
// (an hour, a day, a week, or none), optional uses, and the projects and
// rights its guests are offered (liveShare:createInvite, updateInvite,
// revokeInvite, rotateInvite, duplicateInvite). You share one project or
// several (chosen when you start; added or taken out at any time:
// liveShare:share). Each guest still waits for your yes (the prompt comes
// with its invitation's projects and rights), unless it is someone you trust
// (liveShare/shareTrust.js, kept in liveshare-trusted.json: its identity key,
// the projects and rights it gets); what each person, trusted person or
// invitation gets changes at any time, one project or right at a time
// (liveShare:access), a guest offline too. Guests get each pane's screen as
// it is, never its scrollback (visibleScreen). A share is kept until the host
// presses Stop sharing (which ends the tunnel and every guest's view; trust
// stays): quitting Tessel, a restart (an update, a crash, a new version in
// development) or a reboot only pause it, and the next Tessel starts it again
// by itself (resumeSharing: its invitations and codes, its keys, the same
// projects, the people let in; removed people stay out, expired invitations
// stay expired). The tunnel the last Tessel left is taken back when it still
// runs; otherwise (a reboot, its port still taken after a minute) a new
// tunnel starts, with a new address, retried until it works (no network yet
// after a reboot, say). A tunnel that stops while sharing is started again the
// same way. Each time its address is known, the share says it, sealed and
// signed, on a public relay (liveShare/shareRendezvous.js: ntfy.sh, one topic
// per code, derived from its secret), so guests whose address went dead find
// the new one (codes are TS2: the last address, the secret and the share's
// key; TS1 codes still work). A share saved before invitations is taken back
// with its one code, as a root invitation.
//
// Guest: Join with the code connects (liveShare/shareGuest.js), with this
// Tessel's identity key (made once, kept in liveshare-identity.json: what a
// host trusts); each of the host's projects it sees becomes a Live Share
// project in the window, with the host's panes. They are not terminals of this computer:
// pty:attach/write/kill of their ids come here (isGuestPane), their output
// goes through the window's usual pty:data and pty:exit, and they are never
// saved with the layout. A connection that drops is taken up again with this
// guest's reconnect key (shareGuest.js: it signs the new connection; no new
// question), for as long as this guest stays in the session (until it
// leaves, or the host stops sharing or removes it): when its address no
// longer answers, the host's newest one is asked of the relay
// (shareRendezvous.js), and a first join whose code's address is dead asks it
// too. Quitting, restarting or rebooting this Tessel joins the session again
// (resumeGuest).
//
// Phase 2 (liveShare/shareChannel.js): a guest also sees the host's Files,
// editor, Changes and Tasks of each project it sees, and, with the rights
// (edit, git, tasks), changes them. The host's window gives each shared
// project's folder with its layout (host-only); a guest's request goes to
// shareRequests.js with that folder, the guest's rights and the share's
// setting "Hide ignored and secret files from guests" (on by default, kept
// in liveshare-settings.json), and a change of a task card goes to the
// host's window (liveShare:hostRequest 'task', answered with
// liveShare:taskDone), which checks again and makes it. While guests follow
// a project's files, its folder is watched (one watch per project, apart
// from the window's own), and the files open in their editors too. Every
// change a guest makes is a toast in the host's window and a line in the
// Live Share dialog's "Recent guest actions" (liveShare:guestAction, the
// status's actions). On the guest's side, the window's calls with lshare://
// paths come here (guestFs) and go to the host; its news come back as the
// window's usual explorer:changed and editor:changed, and a board as
// liveShare:push.
//
// Phase 2b (liveShare/sharePanels.js): the guest's headers, sidebar and
// Dashboard show what each of the host's panes runs and how it is (model and
// effort, state, task, its team, its task copy): the host's window sends them
// (liveShare:paneAgents), its guests get a copy at most once a second per
// project ('agents'). A guest's header lists a pane's sub-agents (read here
// from the pane's conversation, which stays here), its Tasks history tab the
// project's finished tasks (liveShare:history from the window; the costs in
// dollars only with the usage right), its Timeline the host's Local History
// of a file, and its review a task branch's changes (shareRequests.js). A
// guest with the usage right sees the host's usage (liveShare/shareUsage.js:
// readings the host already has, never one taken for it).
// Phase 2c: a guest also sees each project's past agent conversations
// (Agent Session History) and what its terminal agents said (requests,
// liveShare/shareHistory.js: masked, no session id, account, folder or
// file), its activity (the Conversations tab and the Activity panel: the
// host's window sends the activity of the projects guests follow,
// liveShare/shareActivity.js masks it, pushed on 'activity'), and, with "See
// my browser pages", its browser pages as links (liveShare/shareLinks.js:
// the host's window lists the pages of its shared projects with their
// webContents, checked here against the layouts; each page's address, title
// and the state of its videos are read here from the page and pushed on
// 'links'; the guest opens the address in its own browser, nothing of the
// host's page streams). The host's window hides a page from guests on the
// host's word (the list's hidden). The host's editor tabs of a project (the
// files inside its folder its Files tab shows) go out on 'tabs'
// (liveShare/shareTabs.js).
//
// Conversations (liveShare/shareChat.js): a guest can look at a host's agent
// pane as a chat, read only, on its own screen (the host's pane, its mode,
// its terminal and its agent never change). The host's window says which of
// its panes have a conversation to show, and where it is (liveShare:layouts'
// chats: the agent, its session, its account and the project's folders; kept
// here, never sent to guests); guests get those panes by name only. The
// first guest watching one opens its conversation file here (chatViews: a
// transcript reader of its own, never the window's), and every read goes
// out to the guests watching it, made smaller first (guestChatPayload). A
// guest's window asks for a pane's conversation (liveShare:chatWatch) and
// gets it with liveShare:chat. A pane the host has in chat mode (no terminal)
// is one of those panes too: the guest's window shows it as a chat, and says
// there is no terminal to show.
import os from 'os'
import { join } from 'path'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { createShareHost, cleanAgents, isAgentId } from './liveShare/shareHost.js'
import { cleanProjectIds, cleanName, isProjectId, MAX_PROJECTS } from './liveShare/shareGrant.js'
import { createTrustStore, isTrustId, trustId, MAX_TRUSTED, MAX_TRUSTED_PROJECTS } from './liveShare/shareTrust.js'
import { cleanRights, isRightId } from '../shared/liveShareRights'
import { cleanAgentRule, effectiveAgentRule, paneTypeAllowed, agentAllowed, modelAllowed, allowedModels, ruleRestricts, isModelId } from '../shared/liveShareAgents'
import { listProcesses, agentsInTrees, KNOWN_AGENT_IDS } from './agentDetect'
import { createShareGuest } from './liveShare/shareGuest.js'
import { encodeInvite, decodeInvite, newSecret, newSigningKey, exportSigningKey, importSigningKey } from './liveShare/shareCrypto.js'
import { ensureCloudflared, startTunnel, waitReachable, waitRegistered, tunnelLogTail, endLeftoverTunnel, tunnelState, stopTunnelPid, stopTunnelLater, processState } from './liveShare/shareTunnel.js'
import { createSessionFile, createKeptFile } from './liveShare/sharePersist.js'
import { createPublisher, rendezvousKeys, newestAddress, withBase, isTunnelUrl, REPUBLISH_MS } from './liveShare/shareRendezvous.js'
import { OFFLINE_KEEP_MS } from './liveShare/shareAccess.js'
import { pidRunning as pidAlive } from './processTree.js'
import { trimBuffer, HOST_BUFFER_BYTES } from './ptyProtocol.js'
import { guestChatPayload, cleanChatPanes, cleanChatMessage, mergeChatEvents, CHAT_REASONS, chatRootsWithin, mapChatTexts } from './liveShare/shareChat.js'
import { TRANSCRIPT_VIEW_AGENTS, validViewId } from './chat/transcriptView.js'
import { validRemoteTranscript } from './chat/remoteTranscripts.js'
import { TOPICS, subKey } from './liveShare/shareChannel.js'
import { createShareRequests, SHARE_OPS } from './liveShare/shareRequests.js'
import { createShareScope, hiddenByName, relFrom, DEFAULT_SHARE_SETTINGS, assertNoHostPaths } from './liveShare/shareScope.js'
import { cleanRoots } from './liveShare/shareChat.js'
import { createGuestFs } from './liveShare/guestFs.js'
import { TASK_OPS, taskArgs, guestTasks, checkTasks, isTaskId } from './liveShare/shareTasks.js'
import { PANEL_OPS, HISTORY_LIMITS, guestPanes, createAgentsFeed, guestChildren, checkPanes, checkChildren, hostHistory, guestHistory, checkHistory, needsFigures, checkUsage, hostTaskCopies, checkReviewInfo, checkReviewDiff } from './liveShare/sharePanels.js'
import { parseLsharePath, lshareRoot, lsharePath, cleanRel } from '../shared/liveSharePath'
import { createShareHistory, HISTORY_OPS, listArgs, isRef, checkSessionList, checkSessionDetails, checkTerminal } from './liveShare/shareHistory.js'
import { guestActivity, checkActivity, mapActivityTexts } from './liveShare/shareActivity.js'
import { createLinkFeed, checkLinks } from './liveShare/shareLinks.js'
import { cleanHostTabs, tabRels, guestTabs, checkTabs } from './liveShare/shareTabs.js'
import { maskSecrets } from './liveShare/shareChat.js'
import { hideHiddenNames } from './liveShare/shareHiddenText.js'
import { PASTE_OPS, createPasteUploads, isPaneId, isImageFile, newUploadId, splitParts } from './liveShare/sharePaste.js'
import { runAsGuest } from './gitSafety'
import { watchProject as watchProjectFolder } from './explorer'
import { createFileWatcher } from './editorFiles'
import { t } from './i18n'

const ATTACH_WAIT_MS = 20000
const LAYOUT_DEPTH = 16
const LAYOUT_CHILDREN = 32
const LAYOUT_PANES = 64
// A host's terminals shown in a guest's window at most, all its projects
// together (each one a terminal here, waiting for its screen).
const GUEST_PANES = 128
// Conversations a guest's window watches at once, and how often one asks
// for all of a conversation again (its copy no longer lined up) in a minute.
const GUEST_CHATS = 8
const GUEST_RESYNCS_PER_MINUTE = 4
// A conversation file not there (yet), or its reader given to another: read
// again after this long (doubled each time, up to a minute), while guests
// watch it, a dozen times at most (then once the pane's conversation changes,
// or a guest starts watching it again).
const FEED_RETRY_MS = 5000
const FEED_RETRY_MAX_MS = 60000
const FEED_REOPEN_MS = 30000
const FEED_TRIES = 12
// A conversation nobody watches any more stays read this long (a guest
// switching its chat on and off must not read the SSH file again each time),
// and a pane's reader is opened at most this often a minute.
const FEED_LINGER_MS = 45000
const FEED_OPENS_PER_MINUTE = 4
const ACCOUNT_ID = /^[\w.-]{1,80}$/
// A guest's view of a project's files: changes go out this often at most,
// and more paths than this are "read everything again".
const PUSH_MS = 250
const FS_PATHS = 256
// What each change a guest makes is, for the audit.
const ACTION_KINDS = Object.freeze({
  'fs.write': 'save',
  'fs.create': 'create',
  'fs.rename': 'rename',
  'fs.trash': 'trash',
  'notes.save': 'notes',
  'scm.stage': 'stage',
  'scm.unstage': 'unstage',
  'scm.discard': 'discard',
  'scm.commit': 'commit',
  'tasks.add': 'taskAdd',
  'tasks.move': 'taskMove',
  'tasks.edit': 'taskEdit',
  'tasks.remove': 'taskRemove',
  'tasks.answer': 'taskAnswer',
  'paste.image': 'pasteImage'
})
// The topics a guest's window may follow itself (the others are main's), or
// ask main the last news of (agents, usage: main follows them itself).
const WINDOW_TOPICS = new Set(['tasks', 'agents', 'usage', 'activity', 'tabs', 'links'])

// A shared project's folder as the host's window gives it: a local absolute
// path (never sent anywhere), or null.
export function cleanRoot(root) {
  if (typeof root !== 'string' || !root || root.length > 1024 || /^[a-z][a-z0-9+.-]*:\/\//i.test(root)) return null
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\u0000-\u001f]/.test(root)) return null
  return /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('/') || /^\\\\[^\\?.]/.test(root) ? root : null
}

// The host window's agent panes that have a conversation to show (its
// layouts' chats): { id, agentId, sessionId, accountId, terminal, title,
// roots (the project's folders) }. Only this Tessel reads them.
export function cleanHostChats(list) {
  const out = []
  for (const c of (Array.isArray(list) ? list : []).slice(0, LAYOUT_PANES)) {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || out.some((x) => x.id === c.id)) continue
    const base = { id: c.id, terminal: c.terminal !== false, title: str(c.title) }
    // An agent pane with no conversation to send: guests see why.
    if (CHAT_REASONS.includes(c.reason)) {
      if (typeof c.agentId === 'string' && /^[\w-]{1,40}$/.test(c.agentId)) out.push({ ...base, agentId: c.agentId, reason: c.reason, roots: [] })
      continue
    }
    // An agent on an SSH host: its file there, read over the connection.
    if (c.hostId != null) {
      if (!validRemoteTranscript(c.agentId, c.hostId, c.sessionId)) continue
      out.push({ ...base, agentId: c.agentId, sessionId: c.sessionId, hostId: c.hostId, roots: cleanHostRoots(c.roots) })
      continue
    }
    if (!TRANSCRIPT_VIEW_AGENTS.includes(c.agentId) || !validViewId(c.agentId, c.sessionId)) continue
    const accountId = c.accountId === null || (typeof c.accountId === 'string' && ACCOUNT_ID.test(c.accountId)) ? c.accountId : undefined
    out.push({ ...base, agentId: c.agentId, sessionId: c.sessionId, accountId, roots: cleanHostRoots(c.roots) })
  }
  return out
}
const cleanHostRoots = (roots) => (Array.isArray(roots) ? roots : []).filter((r) => typeof r === 'string' && r.length <= 1024).slice(0, 8)

export const defaultShareName = () => {
  try {
    return os.userInfo().username || os.hostname()
  } catch {
    return os.hostname()
  }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '')

// What the window says it shows, kept to plain, bounded data: a tree of
// splits ({ type: 'split', dir, sizes, children }) and panes ({ type:
// 'leaf', id, view, title, kind, agentId, accent }), the active and the
// fullscreen pane, the tab shown and the task copy, the project's name. null
// when it is not that.
export function cleanLayout(layout) {
  if (!layout || typeof layout !== 'object') return null
  let leaves = 0
  const node = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > LAYOUT_DEPTH) return null
    if (n.type === 'split') {
      const children = (Array.isArray(n.children) ? n.children.slice(0, LAYOUT_CHILDREN) : []).map((c) => node(c, depth + 1)).filter(Boolean)
      if (!children.length) return null
      if (children.length === 1) return children[0]
      const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((s) => Number.isFinite(s) && s >= 0) ? n.sizes.map(Number) : children.map(() => 100 / children.length)
      return { type: 'split', dir: n.dir === 'col' ? 'col' : 'row', sizes, children }
    }
    if (n.type !== 'leaf' || typeof n.id !== 'string' || !/^[\w-]{1,80}$/.test(n.id) || ++leaves > LAYOUT_PANES) return null
    return {
      type: 'leaf',
      id: n.id,
      view: ['terminal', 'editor', 'browser', 'chat'].includes(n.view) ? n.view : 'terminal',
      title: str(n.title),
      kind: n.kind === 'agent' ? 'agent' : 'shell',
      agentId: str(n.agentId, 40) || null,
      accent: /^#[0-9a-f]{3,8}$/i.test(n.accent || '') ? n.accent : null
    }
  }
  const tree = node(layout.tree, 0)
  const ids = new Set()
  const walk = (n) => (n.type === 'leaf' ? ids.add(n.id) : n.children.forEach(walk))
  if (tree) walk(tree)
  return {
    project: str(layout.project) || null,
    tree,
    activeId: ids.has(layout.activeId) ? layout.activeId : null,
    maximizedId: ids.has(layout.maximizedId) ? layout.maximizedId : null,
    // The tab on the host's screen: its grid ('terminal') or one of its
    // editor or browser panes; and the task copy shown (its branch), or null
    // for the project's own folder.
    shown: layout.shown === 'terminal' || ids.has(layout.shown) ? layout.shown : null,
    copy: str(layout.copy, 120) || null
  }
}

export function layoutLeaves(layout) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach(walk)
  }
  walk(layout && layout.tree)
  return out
}

// Where a full-screen program's screen starts in a serialized screen.
const ALT_SCREEN = '\x1b[?1049h\x1b[H'

// What a guest gets of a pane: its screen as it is now, without the
// scrollback above it (the terminal host's snapshot has thousands of lines of
// history). The snapshot is drawn on an invisible terminal of the pane's size
// that keeps no scrollback, and that screen is written out again. While a
// full-screen program shows (the alternate screen), only its screen: the
// normal screen hidden under it is history too. '' when it can't (the guest
// then sees the output from now on).
export function visibleScreen(data, cols, rows) {
  const text = typeof data === 'string' ? data : ''
  if (!text) return Promise.resolve('')
  return new Promise((resolve) => {
    let vt = null
    const done = (out) => {
      try {
        vt?.dispose()
      } catch {
        /* gone */
      }
      resolve(out)
    }
    try {
      vt = new HeadlessTerminal({
        cols: Math.max(2, Math.min(1000, cols | 0 || 80)),
        rows: Math.max(1, Math.min(500, rows | 0 || 24)),
        scrollback: 0,
        allowProposedApi: true
      })
      const ser = new SerializeAddon()
      vt.loadAddon(ser)
      vt.write(text, () => {
        try {
          const all = ser.serialize({ scrollback: 0 })
          if (vt.buffer.active.type !== 'alternate') return done(all)
          // The addon writes the normal screen, then this switch and the
          // alternate screen (and the modes after it): from the switch on.
          const at = all.lastIndexOf(ALT_SCREEN)
          done(at >= 0 ? all.slice(at) : '')
        } catch {
          done('')
        }
      })
    } catch {
      done('')
    }
  })
}

// A host pane's id in this window: unique per joined session, and a valid
// pane id (pane-..., [\w-], at most 80).
export function guestPaneId(session, remoteId) {
  return `pane-ls${session}-${String(remoteId).replace(/^pane-/, '').replace(/[^\w-]/g, '_')}`.slice(0, 80)
}
// A host's browser page's id in this window: a link's (lnk-...), never one a
// terminal or a chat of the host could have (pane-ls...).
export function linkPaneId(session, remoteId) {
  return `lnk-ls${session}-${String(remoteId).replace(/^pane-/, '').replace(/[^\w-]/g, '_')}`.slice(0, 80)
}

// What a share's start says when cloudflared failed (shareTunnel.js
// TunnelError), in the user's language.
function tunnelErrorText(err) {
  const detail = (err && err.detail) || ''
  switch (err && err.code) {
    case 'download':
      return t('main.liveShare.err.download', 'cloudflared could not be downloaded ({{detail}}).', { detail })
    case 'checksum':
      return t('main.liveShare.err.checksum', 'The cloudflared download does not match its published checksum: it was not used.')
    case 'timeout':
      return t('main.liveShare.err.timeout', 'Cloudflare did not give a tunnel address in time. Try again.')
    case 'stopped':
      return t('main.liveShare.err.stopped', 'cloudflared stopped before giving an address ({{detail}}).', { detail })
    case 'start':
      return t('main.liveShare.err.start', 'cloudflared could not start ({{detail}}).', { detail })
    default:
      return (err && err.message) || String(err)
  }
}

// How a joined session's connection can end and be taken up again (the
// network, the host's Tessel or this one restarting); any other end is final.
const RECONNECT_REASONS = new Set(['closed', 'error', 'timeout', 'unreachable', 'restarting', 'slow', 'busy'])
// Tried again every few seconds at first, every 30 s after a few minutes,
// for as long as the guest stays in the session.
const RECONNECT_DELAYS = [1000, 2000, 3000, 5000, 8000, 10000]
const RECONNECT_SLOW_AFTER_MS = 5 * 60 * 1000
const RECONNECT_SLOW_MS = 30000
// The relay asked for the host's newest address while the old one does not
// answer: after the second try, then at most this often (the last one
// repeated).
const LOOKUP_DELAYS = [5000, 10000, 20000, 30000]
// A first join whose code's address did not answer: the relay asked this
// many times (after these waits) before giving up.
const FIRST_LOOKUPS = [0, 5000, 10000]
// How a connection that never reached the host ends.
const DEAD_ADDRESS = new Set(['unreachable', 'error', 'timeout', 'closed'])
const KEEP_FRESH_MS = 60000
// A share taken back after a restart waits this long for its port (the
// last Tessel can take a minute to quit; 30 s lost a share, 2026-10-18), then
// starts on a new port and a new tunnel; a tunnel that can't start (no
// network yet after a reboot) is tried again after these waits (the last one
// repeated).
const PORT_WAIT_MS = 180000
const RELAUNCH_DELAYS = [15000, 30000, 60000, 120000, 300000]

// deps: ipcMain, send(channel, payload) to the window, host (the terminal
// host client), dataDir (cloudflared goes in its bin folder, the sessions
// kept across a restart in its files), queueData(id, data) and sendExit(id,
// exitCode) (the window's own pty:data / pty:exit), log. queryState, kill,
// pidRunning: the process helpers (tests give their own). resume: take back a share or
// a session at once (Tessel calls resume() itself, once it is the only copy
// running: a second copy starting must not take them). chatViews(send):
// makes the reader of the conversations guests watch (src/main/chat/
// transcriptView.js createTranscriptViews, with this send); without it, no
// guest gets them. chatRetry: { firstMs, maxMs, tries, lingerMs, reopenMs, opensPerMinute } (tests: FEED_*).
// requestLimits: { keepMs, max } (tests: the requests to open kept).
// trashItem(path): the Recycle Bin (Electron's shell; without it a guest's
// delete is refused). watchProject(root, fn) and makeFileWatcher(onChange):
// the folder and file watches for guests (explorer.js, editorFiles.js).
// Phase 2b: usage (liveShare/shareUsage.js createShareUsage: the host's usage
// for guests with the right; without it, none is offered); agentChildren(q)
// (accountSessions.children: an agent pane's sub-agents); cardCosts(ids)
// (jobCost.js forCards: a finished task's figures); localHistory (the
// editor's Local History: list, read). Phase 2c: sessionHistory: { list(query),
// details(query) } (providerAccountSessions.js: the past conversations guests
// of a project see), readTerminal(query) (chat/terminalConversations.js read:
// what its terminal agents said), pageById(webContentsId) (browserGuest.js: a
// browser page of the window, any session); without them, guests get none of
// it. rendezvous: the relay where a share says its address and a guest finds
// it (liveShare/shareRendezvous.js createRelay: { publish, latest }); without
// it, neither (tests); relayUrlOk(url): the addresses taken from it (a quick
// tunnel's; tests: theirs). protect: { available(), encrypt(text),
// decrypt(text) } (Electron's safeStorage: DPAPI on Windows), what seals the
// saved share and session on disk; without it, plain JSON. timing: {
// portWaitMs, relaunchDelays, lookupDelays, firstLookups, publisher (its
// gapMs, retryDelays, minGapMs) } (tests: the waits above). images: {
// check(buf), fromClipboard(), fromFile(path), save(png) } (sharePaste.js
// createPasteImages: an image a guest pastes into a host's pane, read on the
// guest's side and saved on the host's); without it, neither.
export function registerLiveShare({
  ipcMain,
  send,
  host,
  dataDir,
  queueData,
  sendExit,
  log,
  queryState = processState,
  kill = (pid) => process.kill(pid),
  pidRunning = pidAlive,
  resume = true,
  chatViews: makeChatViews = null,
  chatRetry = {},
  requestLimits = {},
  trashItem = null,
  watchProject = watchProjectFolder,
  makeFileWatcher = (onChange) => createFileWatcher(onChange),
  usage = null,
  agentChildren = null,
  cardCosts = null,
  localHistory = null,
  sessionHistory = null,
  readTerminal = null,
  // The processes running now (agentDetect.js listProcesses): what really
  // runs in a pane a guest types in (guests' agents rules).
  listProcs = listProcesses,
  pageById = null,
  rendezvous = null,
  relayUrlOk = isTunnelUrl,
  protect = null,
  images = null,
  timing = {}
}) {
  const info = (msg) => log?.info?.('liveshare', msg)
  const warn = (msg) => (log?.warn ? log.warn('liveshare', msg) : info(msg))
  // A share is kept until Stop sharing, whatever its age; a joined session as
  // long as its host keeps a guest offline.
  const hostFile = createSessionFile(join(dataDir, 'liveshare-host.json'), { maxAgeMs: Infinity })
  const guestFile = createSessionFile(join(dataDir, 'liveshare-guest.json'), { maxAgeMs: OFFLINE_KEEP_MS })
  // Where the share says its address (shareRendezvous.js).
  const publisher = rendezvous ? createPublisher({ relay: rendezvous, log: info, urlOk: relayUrlOk, ...(timing.publisher || {}) }) : null
  // The relay is used only while the setting says so ("Find me again after
  // a restart", on unless turned off).
  const relayOn = () => !!rendezvous && shareSettings.rendezvous !== false
  // The saved share and session hold keys and secrets: sealed by the OS
  // (DPAPI) when it can; a file saved plain (by an earlier Tessel) is still
  // read, and sealed at its next save. null: sealed, and can't be opened now.
  function sealRecord(data) {
    try {
      if (protect && protect.available()) {
        const sealed = protect.encrypt(JSON.stringify(data))
        if (typeof sealed === 'string' && sealed) return { sealed }
      }
    } catch {
      /* kept plain */
    }
    return data
  }
  function openRecord(saved) {
    if (!saved || typeof saved.sealed !== 'string') return saved || null
    try {
      if (!protect || !protect.available()) return null
      const data = JSON.parse(protect.decrypt(saved.sealed))
      return data && typeof data === 'object' ? { ...data, v: saved.v, savedAt: saved.savedAt } : null
    } catch {
      return null
    }
  }
  const portWaitMs = timing.portWaitMs ?? PORT_WAIT_MS
  const relaunchDelays = timing.relaunchDelays || RELAUNCH_DELAYS
  const lookupDelays = timing.lookupDelays || LOOKUP_DELAYS
  const firstLookups = timing.firstLookups || FIRST_LOOKUPS
  const trustFile = createKeptFile(join(dataDir, 'liveshare-trusted.json'))
  const identityFile = createKeptFile(join(dataDir, 'liveshare-identity.json'))
  const settingsFile = createKeptFile(join(dataDir, 'liveshare-settings.json'))
  let suspended = false

  // The people this host trusts (kept across shares and restarts). A file
  // that is there but can't be read is never written over (its trust would
  // be lost): this Tessel then trusts no one, and changes are not kept.
  const trustRead = trustFile.read()
  if (trustRead.status === 'unreadable') warn('the trusted people file can not be read: it is kept as it is, and no one is trusted until it can')
  const trust = createTrustStore({
    entries: trustRead.status === 'ok' ? trustRead.data.trusted : [],
    save: (trusted) => trustRead.status !== 'unreadable' && trustFile.write({ trusted }),
    onChange: () => pushHost(),
    log: info
  })
  // This Tessel's identity key as a guest: made the first time it joins, and
  // only then (a file there that can't be read is kept: this Tessel then
  // joins without an identity, asked like anyone, rather than lose the trust
  // hosts gave it). One key for every host it joins: a host trusts that key,
  // and hosts that compared notes could tell it is the same Tessel (its
  // public half only; a key per host would need the host's lasting identity
  // before the join, which a share does not have).
  let identityKey = null
  function guestIdentity() {
    if (identityKey) return identityKey
    const read = identityFile.read()
    if (read.status === 'ok') {
      identityKey = importSigningKey(read.data.key)
      if (!identityKey) warn('the Live Share identity file can not be used: joining without an identity')
      return identityKey
    }
    if (read.status === 'unreadable') {
      warn('the Live Share identity file can not be read: joining without an identity')
      return null
    }
    const made = newSigningKey()
    if (!identityFile.write({ key: exportSigningKey(made) })) return null
    identityKey = made
    return identityKey
  }
  // The agents the host's window lists for guests ([{ id, name }]).
  let hostAgents = []

  // --- Host --------------------------------------------------------------
  // sharing: { state, server, tunnel: { url, pid, stop }, guests, hostName,
  // hostKey, port, progress, error, projects (the ids of the projects shared,
  // the window's, in order; kept across a restart) }
  let sharing = null
  // What the window shows of the projects shared (liveShare:layouts):
  // project id -> cleaned layout; layoutsRev counts its changes.
  let layouts = new Map()
  let layoutsRev = 0
  // project id -> its agent panes with a conversation (cleanHostChats).
  let chatSources = new Map()
  const sizes = new Map() // pane id -> { cols, rows }, of every terminal
  const asks = new Map() // guest id -> { resolve(answer), trustable }
  let changedTimer = null
  let hostTimer = null // keeps the saved share fresh, watches an adopted tunnel

  // An invitation's code: the share's address with its path, and its secret.
  function inviteCode(s, id) {
    const c = s.server && s.tunnel ? s.server.inviteCode(id) : null
    if (!c) return null
    try {
      const url = new URL(s.tunnel.url)
      url.pathname = c.path ? `/i/${c.path}` : '/'
      return encodeInvite({ url: url.toString(), secret: c.secret, hostKey: s.hostKey.publicRaw })
    } catch {
      return null
    }
  }
  // The trusted people, as the window shows them (online: in the share now).
  function trustedList() {
    const on = sharing && sharing.server ? sharing.server.trustedOnline() : new Set()
    return trust.list().map((e) => ({ id: trustId(e.fp), name: e.name, projects: [...e.grant.projects], rights: { ...e.grant.rights }, since: e.since, lastSeen: e.lastSeen, online: on.has(e.fp) }))
  }
  const hostStatus = () => {
    const s = sharing
    const live = !!(s && s.state === 'sharing' && s.server)
    return {
      state: s ? s.state : 'off',
      projectIds: s ? [...(s.projects || [])] : [],
      // Its invitations, each with its code (only while sharing).
      invites: live ? s.server.invites().map((inv) => ({ ...inv, code: inviteCode(s, inv.id) })) : [],
      guests: s ? s.guests || [] : [],
      // Guests let in who are not connected now (they come back by
      // themselves; Remove keeps them out).
      offline: live ? s.server.offlineGuests() : [],
      trusted: trustedList(),
      // Which of your panes guests have on screen, type in, or read as a
      // chat: [{ id (pane), guests: [{ id, watching, typing, reading }] }].
      presence: live ? s.server.presence() : [],
      progress: s ? (s.progress ?? null) : null,
      error: (s && s.error) || null,
      // A share starting again by itself (after a restart, or its tunnel
      // lost) that could not yet: { at (the next try), error }.
      retry: s && s.retry ? { ...s.retry } : null,
      // A kept share starting again by itself (its Cancel is Stop sharing).
      restarting: !!(s && s.kept && s.state !== 'sharing'),
      // When a share came back by itself after a restart (the window says it
      // once): for a couple of minutes.
      resumed: s && s.state === 'sharing' && s.resumedAt && Date.now() - s.resumedAt < 120000 ? s.resumedAt : null,
      // The share's settings (also while not sharing), and what guests
      // changed lately (newest first; only while sharing).
      settings: { ...shareSettings },
      // The agents (and their models) this window can start, for the
      // "Agents guests may use" lists.
      agents: hostAgents.map((a) => ({ ...a, ...(a.models ? { models: a.models.map((m) => ({ ...m })) } : {}) })),
      // The projects last shared (the dialog ticks them first next time).
      lastProjectIds: [...lastProjects],
      actions: live ? actions.map((a) => ({ ...a })) : [],
      // Phase 2c: the projects whose activity guests follow (the window
      // sends it while they do), and the pages they watch.
      feeds: { activity: live ? [...activityWatched] : [] }
    }
  }
  const pushHost = () => send('liveShare:host', hostStatus())
  // Presence changed (guests look at, type in, read your panes): said at
  // most every 250 ms, the latest at the end.
  const PRESENCE_PUSH_MS = 250
  let presenceTimer = null
  let presenceAt = 0
  function pushPresence() {
    if (presenceTimer) return
    const wait = presenceAt + PRESENCE_PUSH_MS - Date.now()
    presenceTimer = setTimeout(
      () => {
        presenceTimer = null
        presenceAt = Date.now()
        const s = sharing
        if (s && s.state === 'sharing' && s.server) send('liveShare:presence', s.server.presence())
      },
      Math.max(0, wait)
    )
    presenceTimer.unref?.()
  }

  // Which project of a share each of its terminals is in, from the layouts (a
  // pane listed in two is the first one's): only these panes are shared.
  // Worked out again when the layouts or the share's projects changed.
  function homes(s) {
    const projects = s.projects || []
    if (!s.homes || s.homes.rev !== layoutsRev || s.homes.of !== projects) {
      const map = new Map()
      for (const id of projects) for (const l of layoutLeaves(layouts.get(id))) if (l.view === 'terminal' && !map.has(l.id)) map.set(l.id, id)
      s.homes = { rev: layoutsRev, of: projects, map }
    }
    return s.homes.map
  }

  // Which project of a share each agent pane with a conversation is in: one
  // its window listed, that is a pane of that project's layout (a terminal,
  // or a pane in chat mode); a pane listed in two is the first one's.
  function chatHomes(s) {
    const projects = s.projects || []
    if (!s.chatHomes || s.chatHomes.rev !== layoutsRev || s.chatHomes.of !== projects) {
      const map = new Map()
      for (const id of projects) {
        const leaves = new Map(layoutLeaves(layouts.get(id)).map((l) => [l.id, l]))
        for (const c of chatSources.get(id) || []) {
          const l = leaves.get(c.id)
          if (l && l.view === (c.terminal ? 'terminal' : 'chat') && !map.has(c.id)) map.set(c.id, id)
        }
      }
      s.chatHomes = { rev: layoutsRev, of: projects, map }
    }
    return s.chatHomes.map
  }
  const chatSourceOf = (s, id) => {
    const project = chatHomes(s).get(id)
    return project ? (chatSources.get(project) || []).find((c) => c.id === id) || null : null
  }

  // A share's projects as guests get them (shareHost.js projects()): each
  // one's layout and terminals, and its agent panes with a conversation (by
  // name: where it is stays here).
  function sharedProjects(s) {
    const home = homes(s)
    const chatHome = chatHomes(s)
    return (s.projects || []).map((id) => {
      const layout = layouts.get(id) || null
      const leaves = layoutLeaves(layout)
      const panes = leaves
        .filter((l) => l.view === 'terminal' && home.get(l.id) === id)
        .map((l) => ({ id: l.id, title: l.title, kind: l.kind, agentId: l.agentId, accent: l.accent, ...(sizes.get(l.id) || { cols: 0, rows: 0 }) }))
      const byId = new Map(leaves.map((l) => [l.id, l]))
      const chats = cleanChatPanes(
        (chatSources.get(id) || [])
          .filter((c) => chatHome.get(c.id) === id)
          .map((c) => ({ id: c.id, title: (byId.get(c.id) && byId.get(c.id).title) || c.title, agentId: c.agentId, accent: byId.get(c.id) ? byId.get(c.id).accent : null, terminal: c.terminal, reason: c.reason })),
        LAYOUT_PANES
      )
      return { id, layout, panes, chats }
    })
  }

  // --- Phase 2: the host's projects on guests' screens (shareChannel.js) ------
  // Each shared project's folder, as the host's window gives it with the
  // layouts (host-only: never sent to a guest, never in a layout).
  let roots = new Map()
  // The share's settings, kept across shares: hideIgnored ("Hide ignored and
  // secret files from guests", on unless turned off).
  const settingsRead = settingsFile.read()
  // rendezvous: "Find me again after a restart (uses ntfy.sh)", on unless
  // turned off (off: no call to the relay, as host or guest).
  let shareSettings = {
    ...DEFAULT_SHARE_SETTINGS,
    rendezvous: true,
    ...(settingsRead.status === 'ok' && settingsRead.data.hideIgnored === false ? { hideIgnored: false } : {}),
    ...(settingsRead.status === 'ok' && settingsRead.data.rendezvous === false ? { rendezvous: false } : {}),
    // agents: the agents and models guests may use, for whoever has no rule
    // of its own (liveShareAgents.js); none: all of them.
    ...(settingsRead.status === 'ok' && cleanAgentRule(settingsRead.data.agents) ? { agents: cleanAgentRule(settingsRead.data.agents) } : {})
  }
  // The projects last shared (the window's ids), kept here too: a share
  // started again from the dialog after a restart ticks them first, not only
  // the project on screen.
  let lastProjects = settingsRead.status === 'ok' ? cleanProjectIds(Array.isArray(settingsRead.data.lastProjects) ? settingsRead.data.lastProjects : []) : []
  const writeSettings = () => settingsFile.write({ hideIgnored: shareSettings.hideIgnored, rendezvous: shareSettings.rendezvous, lastProjects, ...(shareSettings.agents ? { agents: shareSettings.agents } : {}) })
  function rememberProjects(ids) {
    const next = cleanProjectIds(ids)
    if (!next.length || (next.length === lastProjects.length && next.every((x, i) => x === lastProjects[i]))) return
    lastProjects = next
    writeSettings()
  }
  const scope = createShareScope()
  const requests = createShareRequests({ scope, log })
  // The ops guests may ask for, by name: what each needs and costs
  // ({ right, kind, bulk }) and who answers it. Next phases add theirs with
  // addOps (and their area in shareChannel.js OP_AREAS).
  const channelOps = new Map()
  function addOps(table, run) {
    for (const [op, info] of Object.entries(table)) channelOps.set(op, { right: info.right, kind: info.kind, bulk: !!info.bulk, run })
  }
  addOps(SHARE_OPS, (req, ctx) => fileRequest(req, ctx))
  addOps(TASK_OPS, (req, ctx, s) => taskRequest(req, ctx, s))
  // The topics guests follow, by name: (s, project, key, on) when the first
  // guest subscribes or the last one leaves.
  const channelTopics = new Map([
    ['fs', (s, project, key, on) => watchFolder(s, project, 'fs', on)],
    ['scm', (s, project, key, on) => watchFolder(s, project, 'scm', on)],
    ['file', (s, project, key, on) => watchFile(s, project, key, on)],
    ['tasks', (s, project, key, on) => on && pushBoard(s, project)],
    ['activity', (s, project, key, on) => watchActivity(s, project, on)],
    // The host's editor tabs, and its pages as links: the latest at once to
    // the first guest that follows (shareHost keeps it for the next ones).
    ['tabs', (s, project, key, on) => on && refreshTabs(project, true)],
    ['links', (s, project, key, on) => linkFeed?.watch(project, on)],
    ['media', (s, project, key, on) => linkFeed?.watchMedia(project, key, on)]
  ])
  const projectRoots = (project) => {
    const root = roots.get(project)
    const info = root ? scope.root(root) : null
    return info ? cleanRoots([info.real, info.root]) : []
  }

  // --- Phase 2c: past conversations, activity, browser pages ----------------------
  // A project's past agent conversations and its terminal agents' (masked,
  // shareHistory.js), with its folder (host-only) and its agent panes.
  const pastSessions = createShareHistory({ listSessions: sessionHistory && sessionHistory.list, sessionDetails: sessionHistory && sessionHistory.details, readTerminal })
  addOps(HISTORY_OPS, (req, ctx, s) => sessionsRequest(req, ctx, s))
  // The hidden files a project's texts name, out ("…"), as its Files tab
  // hides them (shareHiddenText.js); git's check runs as the guest's
  // (runAsGuest) and, for a guest's request, within its budget (charge).
  const hiddenMasker = (project, charge = null) => {
    const root = roots.get(project) || null
    const info = root ? scope.root(root) : null
    return (texts) => runAsGuest(() => hideHiddenNames(texts, { scope, info, settings: shareSettings, charge }))
  }
  async function sessionsRequest(req, ctx, s) {
    const root = roots.get(req.project) || null
    const info = root ? scope.root(root) : null
    const charge = () => (typeof ctx.spend === 'function' ? ctx.spend('git') !== false : true)
    const where = { root: info ? info.root : null, roots: projectRoots(req.project), rawRoots: info ? [info.real, info.root] : [], maskHidden: hiddenMasker(req.project, charge) }
    try {
      if (req.op === 'sessions.list') return await pastSessions.list(req.project, req.args, where)
      if (req.op === 'sessions.details') return await pastSessions.details(req.project, req.args, where)
      const home = chatHomes(s)
      const panes = (chatSources.get(req.project) || []).filter((c) => c.terminal && home.get(c.id) === req.project)
      return await pastSessions.terminal(req.project, req.args, { ...where, panes })
    } catch (err) {
      // Over the guest's git budget (the hidden files' check): later.
      return { ok: false, code: err && err.code === 'busy' ? 'busy' : 'failed' }
    }
  }

  // The activity of the projects guests follow: the window sends it while
  // they do (liveShare:feeds), guests get a masked copy when it changed.
  const activityWatched = new Set()
  let activities = new Map() // project -> { data, json }
  // The window's last activity of each followed project (made again when
  // hiding turns on).
  let activityRaw = new Map()
  function watchActivity(s, project, on) {
    if (on) activityWatched.add(project)
    else {
      activityWatched.delete(project)
      activities.delete(project)
      activityRaw.delete(project)
    }
    send('liveShare:feeds', { activity: [...activityWatched] })
    const a = activities.get(project)
    if (on && a && sharing === s && s.server) s.server.push('activity', project, null, a.data)
  }

  // The browser pages of the shared projects as links (shareLinks.js): the
  // window's list, each page kept only when it is a browser pane of its
  // shared project's layout, or a page of the side panel the host shared
  // with guests itself (optIn: the page's own "Share with guests"; all of
  // them in one shared project, the one on the host's screen; never an id
  // of a layout's pane); its address, title and media read from the page,
  // pushed on 'links' (guests with "See my browser pages" there).
  const linkFeed = typeof pageById === 'function' ? createLinkFeed({ guestById: pageById, log, maskTitle: maskSecrets, push: (project, data) => sharing?.server?.push('links', project, null, data) }) : null
  let pageList = []
  const pageAllowed = (s) => (project, paneId, side) => (s.projects || []).includes(project) && (side || layoutLeaves(layouts.get(project)).some((l) => l.id === paneId && l.view === 'browser'))
  function refreshPages() {
    const s = sharing
    if (!linkFeed || !s || !s.server) return
    const inLayouts = new Set()
    for (const id of s.projects || []) for (const l of layoutLeaves(layouts.get(id))) inLayouts.add(l.id)
    const sideProject = (pageList.find((x) => x && x.side === true) || {}).project
    const list = pageList.filter((x) => x && (x.side !== true || (x.optIn === true && x.project === sideProject && !inLayouts.has(x.paneId))))
    linkFeed.setPages(list, pageAllowed(s))
  }

  // --- The host's editor tabs, for guests ('tabs', shareTabs.js) -------------------
  // The window's open files of each shared project (host-only), and what
  // guests get of them: the ones inside its folder its Files tab shows.
  let hostTabs = new Map() // project -> { files, active }
  const tabsSent = new Map() // project -> { data, json, seq }
  async function refreshTabs(project, force = false) {
    const s = sharing
    if (!s || !s.server) return
    const root = roots.get(project) || null
    const info = root ? scope.root(root) : null
    const raw = hostTabs.get(project) || { files: [], active: null }
    const prev = tabsSent.get(project)
    const seq = (prev ? prev.seq : 0) + 1
    tabsSent.set(project, { ...(prev || { data: null, json: null }), seq })
    const wanted = tabRels(raw, info, shareSettings)
    // What git ignores, with the share's setting (one cached check).
    let hidden = new Set()
    if (info && wanted.rels.length) hidden = await runAsGuest(() => scope.hiddenOf(info, wanted.rels, shareSettings)).catch(() => new Set(wanted.rels))
    const now = tabsSent.get(project)
    if (sharing !== s || !now || now.seq !== seq) return
    const data = guestTabs(wanted, hidden)
    const json = JSON.stringify(data)
    if (!force && json === now.json) return
    tabsSent.set(project, { data, json, seq })
    s.server.push('tabs', project, null, data)
  }

  // Files, notes and git (shareRequests.js), with the project's folder, the
  // guest's rights and the share's settings; a change is in the audit.
  async function fileRequest(req, ctx) {
    const res = await requests.handle(req, { roots, rights: ctx.rights, settings: shareSettings, trashItem, recheck: ctx.recheck, localHistory, taskCopy: (project, id) => taskCopies.get(project)?.get(id) || null })
    if (res && res.ok && channelOps.get(req.op)?.kind === 'write') noteAction(ctx.guest, req)
    return res
  }

  // --- Watching for guests ---------------------------------------------------------
  // One watch per project while a guest follows its files or its git state
  // (separate from the window's own), started once its folder is known.
  // Changes go out every PUSH_MS at most: the visible paths only (never a
  // hidden or ignored one), none when there are more than FS_PATHS (read
  // everything again); a change inside .git is only a hint ('scm').
  const folderWatches = new Map() // project -> { root, info, topics, stop, paths, all, git, timer }
  function watchFolder(s, project, topic, on) {
    let w = folderWatches.get(project)
    if (!on) {
      if (!w) return
      w.topics.delete(topic)
      if (!w.topics.size) stopFolder(project)
      return
    }
    if (!w) folderWatches.set(project, (w = { root: null, info: null, topics: new Set(), stop: null, paths: new Set(), all: false, git: false, timer: null, s }))
    w.topics.add(topic)
    startFolder(project, w)
  }
  function startFolder(project, w) {
    const root = roots.get(project) || null
    if (w.stop && w.root === root) return
    if (w.stop) w.stop()
    w.stop = null
    w.root = root
    w.info = root ? scope.root(root) : null
    if (!w.info) return
    try {
      w.stop = watchProject(w.info.real, (_r, change) => folderChanged(project, w, change))
    } catch {
      w.stop = null
    }
  }
  function stopFolder(project) {
    const w = folderWatches.get(project)
    if (!w) return
    folderWatches.delete(project)
    clearTimeout(w.timer)
    try {
      w.stop?.()
    } catch {
      /* already stopped */
    }
  }
  function folderChanged(project, w, change) {
    if (folderWatches.get(project) !== w || !w.info) return
    if (!change || !Array.isArray(change.paths)) {
      w.all = true
      scope.invalidatePaths(w.info.real, null)
    } else {
      const rels = []
      for (const full of change.paths) {
        const rel = relFrom(w.info.real, full)
        if (rel === null || rel === '') continue
        rels.push(rel)
        if (/^\.git(\/|$)/i.test(rel)) w.git = true
        else if (!w.all) w.paths.add(rel)
        if (w.paths.size > FS_PATHS) w.all = true
      }
      // What was kept about these paths only (a path seen ignored stays so).
      scope.invalidatePaths(w.info.real, rels)
    }
    if (!w.timer) {
      w.timer = setTimeout(() => flushFolder(project, w), PUSH_MS)
      w.timer.unref?.()
    }
  }
  async function flushFolder(project, w) {
    w.timer = null
    const { git, all } = w
    const rels = [...w.paths]
    w.paths = new Set()
    w.all = false
    w.git = false
    const s = w.s
    if (sharing !== s || !s.server || folderWatches.get(project) !== w) return
    if (git && w.topics.has('scm')) s.server.push('scm', project, null, {})
    if (!w.topics.has('fs')) return
    if (all) return s.server.push('fs', project, null, { paths: null })
    const named = rels.filter((rel) => cleanRel(rel) === rel && !hiddenByName(rel, shareSettings))
    const off = named.length ? await scope.hiddenOf(w.info, named, shareSettings).catch(() => new Set(named)) : new Set()
    const paths = named.filter((rel) => !off.has(rel))
    if (!paths.length || sharing !== s || folderWatches.get(project) !== w) return
    s.server.push('fs', project, null, { paths })
    // A visible change can change git's status too.
    if (w.topics.has('scm')) s.server.push('scm', project, null, {})
  }

  // Files open in guests' editors (the 'file' topic, a few dozen per guest):
  // one watcher for all of them, each file found inside its project first
  // (a hidden one is never watched); the news is what the editor compares.
  let fileWatcher = null
  const fileWanted = new Map() // project\nrel -> { project, rel, real, s }
  async function watchFile(s, project, rel, on) {
    const k = `${project}\n${rel}`
    if (!on) {
      fileWanted.delete(k)
      return refreshFiles()
    }
    const entry = { project, rel, real: null, s }
    fileWanted.set(k, entry)
    const root = roots.get(project)
    const r = root ? await scope.resolve(root, rel, { settings: shareSettings, mustExist: false }).catch(() => null) : null
    if (fileWanted.get(k) !== entry || sharing !== s) return
    entry.real = r && r.ok && (r.isFile || !r.exists) ? r.real || r.entry : null
    refreshFiles()
  }
  function refreshFiles() {
    const reals = [...new Set([...fileWanted.values()].map((e) => e.real).filter(Boolean))]
    if (!reals.length) {
      fileWatcher?.close()
      fileWatcher = null
      return
    }
    if (!fileWatcher) fileWatcher = makeFileWatcher((change) => fileChanged(change))
    fileWatcher.set(reals)
  }
  function fileChanged(change) {
    const key = String(change && change.path).toLowerCase()
    for (const e of fileWanted.values()) {
      if (!e.real || e.real.toLowerCase() !== key || sharing !== e.s || !e.s.server) continue
      e.s.server.push('file', e.project, e.rel, { exists: !!change.exists, size: Number(change.size) || 0, mtimeMs: Number(change.mtimeMs) || 0, sig: typeof change.sig === 'string' ? change.sig : null })
    }
  }
  function stopWatches() {
    for (const project of [...folderWatches.keys()]) stopFolder(project)
    fileWanted.clear()
    refreshFiles()
  }
  // Hiding turned on while sharing: a file open in a guest's editor that is
  // hidden now is said gone (its editor reads it again: not there) and no
  // longer followed; every guest's Files read everything again.
  async function hideNow() {
    const s = sharing
    if (!s || !s.server) return
    for (const e of [...fileWanted.values()]) {
      const root = roots.get(e.project)
      const r = root ? await scope.resolve(root, e.rel, { settings: shareSettings, mustExist: false }).catch(() => null) : null
      if (r && r.ok) continue
      if (sharing !== s) return
      e.real = null
      s.server.push('file', e.project, e.rel, { exists: false, size: 0, mtimeMs: 0, sig: null })
      s.server.endTopic('file', e.project, e.rel)
    }
    refreshFiles()
    for (const project of folderWatches.keys()) s.server.push('fs', project, null, { paths: null })
    // The activity guests follow, made again without what is hidden now.
    for (const item of activityRaw.values()) if (activityWatched.has(item.project)) pushActivity(s, item)
  }
  // A project's folder changed (the window said another one): its watch
  // starts again, its files are found again.
  function rootsChanged(before) {
    for (const [project, w] of folderWatches) if (before.get(project) !== roots.get(project)) startFolder(project, w)
    for (const e of [...fileWanted.values()]) if (before.get(e.project) !== roots.get(e.project)) watchFile(e.s, e.project, e.rel, true)
    for (const [project, root] of before) if (roots.get(project) !== root) scope.invalidate(root)
  }

  // --- Task boards (shareTasks.js) ---------------------------------------------
  // The guests' copy of each shared project's board (project -> { tasks,
  // json }), made from what the window sends; pushed when it changed.
  let boards = new Map()
  // project -> Map(card id -> the pane that asked its pending question):
  // host-only.
  let gateAskers = new Map()
  function pushBoard(s, project) {
    const b = boards.get(project)
    if (b && sharing === s && s.server) s.server.push('tasks', project, null, { tasks: b.tasks })
  }
  // A guest's change of a board: its arguments, its card on that project's
  // board, then the window's answer (it checks again and makes it).
  const TASK_WAIT_MS = 10000
  const taskRequests = new Map() // request id -> { resolve, timer, guestId, project }
  let nextTask = 1
  async function taskRequest(req, ctx, s) {
    const args = taskArgs(req.op, req.args)
    if (!args) return { ok: false, code: 'bad-args' }
    const board = boards.get(req.project)
    const card = args.id ? board && board.tasks.find((x) => x.id === args.id) : null
    if (args.id && !card) return { ok: false, code: 'not-found' }
    // An answer goes to the agent that asked: without the type right, only
    // one of the choices it offered (never free text typed to an agent).
    if (req.op === 'tasks.answer' && ctx.rights.type !== true && !(card.gate && card.gate.status === 'pending' && card.gate.options.includes(args.answer))) return { ok: false, code: 'not-allowed' }
    // Free text goes to the agent that asked: only one the guest's agents
    // rule lets it type in (one of the choices it offered is fine).
    if (req.op === 'tasks.answer' && !(card.gate && card.gate.options.includes(args.answer))) {
      const rule = effectiveAgentRule(ctx.rights.agents, shareSettings.agents)
      if (ruleRestricts(rule)) {
        const by = gateAskers.get(req.project)?.get(card.id)
        const pane = by ? paneView(by) : null
        if (!pane || pane.unsure || !paneTypeAllowed(rule, pane)) return { ok: false, code: 'not-allowed' }
      }
    }
    if (!ctx.recheck() || sharing !== s) return { ok: false, code: 'revoked' }
    const request = `t${nextTask++}`
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        taskRequests.delete(request)
        resolve({ ok: false, code: 'unavailable' })
      }, TASK_WAIT_MS)
      timer.unref?.()
      // The window asks again whether it still stands right before making it
      // (liveShare:taskCheck: the access model's word, not its own view).
      taskRequests.set(request, { resolve, timer, guestId: ctx.guest.id, project: req.project, recheck: ctx.recheck })
      send('liveShare:hostRequest', { action: 'task', request, op: req.op.slice('tasks.'.length), project: req.project, args, guest: ctx.guest, type: ctx.rights.type === true })
    })
    if (res.ok) noteAction(ctx.guest, { op: req.op, project: req.project, args: { ...args, title: args.title || (card && card.title) || '', from: req.op === 'tasks.edit' && card ? card.title : undefined } })
    return res
  }
  // --- Images guests paste into panes (sharePaste.js) -------------------------
  // A guest with the type right sends an image in parts; once all are in, it
  // is checked and made a new PNG here, saved in the folder for pasted images
  // with a name of this Tessel's, and the host's window pastes its path into
  // the pane as a local image paste would (liveShare:hostRequest 'pasteImage',
  // answered with liveShare:pasteDone). Only a terminal pane of that project.
  const PASTE_WAIT_MS = 10000
  const pasteUploads = createPasteUploads()
  const pasteRequests = new Map() // request id -> { resolve, timer, guestId, recheck }
  let nextPaste = 1
  // Images are decoded one at a time, whoever sent them (each blocks this
  // process a moment), a few waiting at most.
  const DECODES_WAITING = 3
  let decodeTail = Promise.resolve()
  let decodesWaiting = 0
  function decodeInTurn(bytes) {
    if (decodesWaiting >= DECODES_WAITING) return Promise.resolve({ ok: false, code: 'busy' })
    decodesWaiting++
    const run = decodeTail.then(
      () =>
        new Promise((resolve) =>
          setImmediate(() => {
            try {
              resolve(images.check(bytes))
            } catch {
              resolve({ ok: false, code: 'not-image' })
            }
          })
        )
    )
    decodeTail = run.then(
      () => {},
      () => {}
    )
    return run.finally(() => decodesWaiting--)
  }
  addOps(PASTE_OPS, (req, ctx, s) => pasteRequest(req, ctx, s))
  const paneTitle = (project, id) => {
    const l = layoutLeaves(layouts.get(project)).find((x) => x.id === id)
    return (l && l.title) || ''
  }
  async function pasteRequest(req, ctx, s) {
    const a = req.args || {}
    if (!images || sharing !== s) return { ok: false, code: 'bad-op' }
    if (!isPaneId(a.pane) || homes(s).get(a.pane) !== req.project) return { ok: false, code: 'not-found' }
    // (The type right: checked by the server before it came here, and again below.)
    if (ctx.rights.type !== true) return { ok: false, code: 'forbidden' }
    // Nor in a pane of an agent or a model its agents rule leaves out.
    const pasteRule = effectiveAgentRule(ctx.rights.agents, shareSettings.agents)
    if (ruleRestricts(pasteRule)) {
      const pane = paneView(a.pane)
      if (!pane || pane.unsure || !paneTypeAllowed(pasteRule, pane)) return { ok: false, code: 'forbidden' }
    }
    // One upload and one minute's images per person, whatever its connection.
    const owner = typeof ctx.person === 'string' ? ctx.person : ctx.guest.id
    if (req.op === 'paste.part') return pasteUploads.part(owner, req.project, a)
    const got = pasteUploads.take(owner, req.project, a)
    if (!got.ok) return got
    const png = await decodeInTurn(got.bytes)
    if (!png.ok) {
      info(`guest ${cleanName(ctx.guest.name) || '?'}: an image refused (${png.code})`)
      return { ok: false, code: png.code }
    }
    if (!ctx.recheck() || sharing !== s || homes(s).get(a.pane) !== req.project) return { ok: false, code: 'revoked' }
    let file
    try {
      file = images.save(png.png)
    } catch {
      return { ok: false, code: 'failed' }
    }
    const request = `p${nextPaste++}`
    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pasteRequests.delete(request)
        resolve({ ok: false, code: 'unavailable' })
      }, PASTE_WAIT_MS)
      timer.unref?.()
      // The window asks again right before it pastes (liveShare:pasteCheck):
      // an SSH host's copy can take a while.
      pasteRequests.set(request, { resolve, timer, guestId: ctx.guest.id, recheck: () => ctx.recheck() && sharing === s && homes(s).get(a.pane) === req.project })
      send('liveShare:hostRequest', { action: 'pasteImage', request, id: a.pane, project: req.project, file, guest: ctx.guest })
    })
    if (res.ok) noteAction(ctx.guest, { op: req.op, project: req.project, args: { paneTitle: paneTitle(req.project, a.pane) } })
    return res
  }
  function endPasteRequests(which = () => true) {
    for (const [request, r] of [...pasteRequests]) {
      if (!which(r)) continue
      pasteRequests.delete(request)
      clearTimeout(r.timer)
      r.resolve({ ok: false, code: 'revoked' })
    }
  }

  function endTaskRequests(code = 'revoked', which = () => true) {
    for (const [request, r] of [...taskRequests]) {
      if (!which(r)) continue
      taskRequests.delete(request)
      clearTimeout(r.timer)
      r.resolve({ ok: false, code })
    }
  }

  // --- Phase 2b: panes, sub-agents, usage, task history (sharePanels.js) -------
  // Each shared project's panes as the window sends them (liveShare:
  // paneAgents): the guests' copy goes out at most once a second ('agents'),
  // made again when the layouts change (a pane that came or went); where each
  // agent's sub-agents are read stays here. Its finished tasks' records
  // (liveShare:history) and its cards' own copies (from liveShare:tasks, for
  // the review) too. The host's usage goes to guests with the usage right
  // ('usage', shareUsage.js: never a reading taken for them).
  const agentsFeed = createAgentsFeed({ push: (project, data) => sharing?.server?.push('agents', project, null, data) })
  let rawPanes = new Map() // project -> the window's panes
  // What runs in each pane shared, as the window says it ({ agent (null: a
  // shell), models (the ids its model is known by), pid (its shell's, an
  // agent pane on this computer), local }), for the guests' agents rules
  // (shareHost.js paneAgent): host-only.
  let paneAgents = new Map()
  // What really runs under an agent pane's shell (agentsInTrees), looked at
  // when a guest types in it: { pid, agents, at, unsure, enterAt }. After a
  // guest's Enter there (it may have quit the agent or started another), the
  // pane is unsure until a look that started after that Enter.
  let running = new Map()
  const RUNNING_FRESH_MS = 10000
  const RUNNING_AFTER_ENTER_MS = 700
  let runningBusy = false
  let runningAgain = false
  let runningTimer = null
  const runningWanted = new Set()
  function lookSoon(id, delay = 0) {
    runningWanted.add(id)
    if (runningTimer) return
    runningTimer = setTimeout(() => {
      runningTimer = null
      lookNow()
    }, delay)
    runningTimer.unref?.()
  }
  async function lookNow() {
    if (runningBusy) {
      runningAgain = true
      return
    }
    const shells = {}
    for (const id of runningWanted) {
      const p = paneAgents.get(id)
      if (p && p.pid) shells[id] = p.pid
    }
    runningWanted.clear()
    if (!Object.keys(shells).length) return
    runningBusy = true
    const started = Date.now()
    try {
      const procs = await Promise.resolve(listProcs()).catch(() => null)
      if (!procs) return
      const found = agentsInTrees(procs, shells)
      for (const [id, agents] of Object.entries(found)) {
        const p = paneAgents.get(id)
        if (!p || p.pid !== shells[id]) continue
        const was = running.get(id)
        const enterAt = was ? was.enterAt || 0 : 0
        running.set(id, { pid: shells[id], agents, at: Date.now(), unsure: enterAt > started, enterAt })
        if (enterAt > started) lookSoon(id, RUNNING_AFTER_ENTER_MS)
        if (!was || was.agents.join() !== agents.join()) sharing?.server?.paneChanged(id)
      }
    } finally {
      runningBusy = false
      if (runningAgain) {
        runningAgain = false
        lookSoon('', 0)
      }
    }
  }
  // A pane as a guest's agents rule sees it (shareHost.js paneAgent): what
  // the window says, corrected by what really runs under its shell (an agent
  // Tessel can recognise, on this computer): back at its shell prompt, it is
  // a shell; another agent running there counts too. Not looked at yet, or
  // being looked at again after an Enter: unsure. null: not known yet.
  function paneView(id) {
    const p = paneAgents.get(id)
    if (!p) return null
    const out = { agent: p.agent, models: p.models, others: [] }
    if (!p.agent || !p.pid || !p.local || !KNOWN_AGENT_IDS.includes(p.agent)) return out
    const r = running.get(id)
    if (!r || r.pid !== p.pid) {
      lookSoon(id)
      return { ...out, unsure: true }
    }
    if (r.unsure) return { ...out, unsure: true }
    if (Date.now() - r.at > RUNNING_FRESH_MS) lookSoon(id)
    if (!r.agents.length) return { agent: null, models: [], others: [] }
    if (r.agents.includes(p.agent)) return { ...out, others: r.agents.filter((x) => x !== p.agent) }
    return { agent: null, models: [], others: r.agents }
  }
  // A guest typed in a pane: an Enter in an agent pane makes it unsure until
  // the host looked again.
  function paneTyped(id, data) {
    const p = paneAgents.get(id)
    if (!p || !p.agent || !p.pid || !p.local || !/[\r\n]/.test(String(data || ''))) return
    const r = running.get(id)
    if (r) {
      r.unsure = true
      r.enterAt = Date.now()
    }
    lookSoon(id, RUNNING_AFTER_ENTER_MS)
  }
  let paneChildren = new Map() // project -> Map(pane id -> { agent, sessionId, accountId })
  let histories = new Map() // project -> records (hostHistory)
  let historyCosts = new Map() // project -> { at, costs }: figures read here
  let taskCopies = new Map() // project -> Map(card id -> { path, branch, target })
  let usageOff = null
  addOps(PANEL_OPS, (req, ctx, s) => (req.op === 'agents.children' ? childrenRequest(req, ctx, s) : historyRequest(req, ctx, s)))
  channelTopics.set('agents', (s, project, key, on) => on && agentsFeed.sendNow(project))
  channelTopics.set('usage', (s, project, key, on) => {
    usageOff?.()
    usageOff = on && usage ? usage.subscribe((data) => sharing === s && s.server?.push('usage', null, null, data)) : null
  })
  // A pane guests of that project see: one of its terminals, or a pane of it
  // with a conversation.
  const paneShared = (s, project, id) => homes(s).get(id) === project || chatHomes(s).get(id) === project
  function panesChanged() {
    const s = sharing
    if (!s || !s.server) return
    for (const [project, list] of rawPanes) {
      const { panes, children } = guestPanes(list, projectRoots(project), (id) => paneShared(s, project, id))
      paneChildren.set(project, children)
      agentsFeed.set(project, { panes })
    }
  }
  // A pane's sub-agents: only a pane of that project the guest sees, read
  // from where the window said its conversation is. Read once per
  // CHILDREN_MS per pane whoever asks (reading them blocks this process a
  // moment), one read at a time.
  const CHILDREN_MS = 6000
  let childReads = new Map() // project \n pane \n session -> { at, value: Promise<items> }
  async function childrenRequest(req, ctx, s) {
    const pane = req.args && typeof req.args.pane === 'string' && /^[\w-]{1,80}$/.test(req.args.pane) ? req.args.pane : null
    if (!pane) return { ok: false, code: 'bad-args' }
    const spec = paneChildren.get(req.project)?.get(pane)
    if (!spec || sharing !== s || !paneShared(s, req.project, pane) || typeof agentChildren !== 'function') return { ok: false, code: 'not-found' }
    const key = `${req.project}\n${pane}\n${spec.agent}\n${spec.sessionId}`
    let entry = childReads.get(key)
    if (!entry || Date.now() - entry.at >= CHILDREN_MS) {
      const value = Promise.resolve()
        .then(() => agentChildren({ agent: spec.agent, sessionId: spec.sessionId, ...(spec.accountId !== undefined ? { accountId: spec.accountId } : {}), ...(spec.remoteHostId ? { remoteHostId: spec.remoteHostId } : {}) }))
        .then((list) => guestChildren(list, projectRoots(req.project)))
      entry = { at: Date.now(), value }
      childReads.delete(key)
      childReads.set(key, entry)
      // A failed read is not kept.
      value.catch(() => childReads.get(key) === entry && childReads.delete(key))
      if (childReads.size > 256) childReads.delete(childReads.keys().next().value)
    }
    try {
      return { ok: true, data: { items: await entry.value } }
    } catch {
      return { ok: false, code: 'failed' }
    }
  }
  // The project's task history: times and tokens; the costs in dollars only
  // for a guest with the usage right (its answer then leaves only while it
  // still has it). Figures the window has not read yet are read here, at most
  // once every 30 s per project.
  async function historyRequest(req, ctx, s) {
    // The pane that did it only while that project's guests see it.
    const records = (histories.get(req.project) || []).map((r) => (r.paneId && !(sharing === s && paneShared(s, req.project, r.paneId)) ? { ...r, paneId: null } : r))
    const usd = !!(ctx.rights && ctx.rights.usage === true)
    if (usd) ctx.uses?.('usage')
    let costs = null
    const todo = records.filter(needsFigures).map((r) => r.id)
    if (todo.length && typeof cardCosts === 'function') {
      const kept = historyCosts.get(req.project)
      if (kept && Date.now() - kept.at < HISTORY_LIMITS.costTtlMs) costs = kept.costs
      else {
        try {
          costs = await cardCosts(todo)
        } catch {
          costs = null
        }
        costs = costs && typeof costs === 'object' ? costs : null
        historyCosts.set(req.project, { at: Date.now(), costs })
      }
    }
    return { ok: true, data: guestHistory(records, { roots: projectRoots(req.project), usd, costs }) }
  }
  function endPanels() {
    agentsFeed.reset()
    usageOff?.()
    usageOff = null
    rawPanes = new Map()
    paneAgents = new Map()
    running = new Map()
    runningWanted.clear()
    paneChildren = new Map()
    histories = new Map()
    historyCosts = new Map()
    taskCopies = new Map()
    childReads = new Map()
  }

  // --- What guests changed (the audit) ---------------------------------------
  // Each change a guest made (a save, a file made, renamed or put in the
  // Recycle Bin, the notes, a stage, a discard, a commit, a task), newest
  // first, for the Live Share dialog's "Recent guest actions", a toast and
  // the log. A change to an agent's instructions (CLAUDE.md, AGENTS.md...)
  // is flagged.
  const MAX_ACTIONS = 50
  let actions = []
  let nextAction = 1
  const INSTRUCTION_FILES = /(^|\/)(claude|agents|gemini|codex)\.md$/i
  function noteAction(guest, req) {
    const a = req.args && typeof req.args === 'object' ? req.args : {}
    const kind = ACTION_KINDS[req.op]
    if (!kind) return
    const path = typeof a.path === 'string' ? a.path : typeof a.name === 'string' ? [a.dir, a.name].filter(Boolean).join('/') : req.op === 'notes.save' ? '.tessel/notes.md' : ''
    const paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === 'string').slice(0, 20) : []
    const entry = {
      id: nextAction++,
      at: Date.now(),
      guestId: guest && typeof guest.id === 'string' ? guest.id : null,
      name: guest ? cleanName(guest.name) : '',
      kind,
      project: req.project,
      path: str(path, 400),
      ...(req.op === 'fs.rename' ? { to: str(a.name, 255) } : {}),
      count: paths.length || (path ? 1 : 0),
      ...(paths.length ? { paths } : {}),
      ...(req.op === 'scm.commit' ? { detail: str(String(a.message || '').split('\n')[0], 120) } : {}),
      ...(req.op === 'paste.image' ? { detail: str(a.paneTitle || '', 120) } : {}),
      ...(req.op.startsWith('tasks.') ? { detail: str(a.title || '', 120), ...(a.column ? { column: a.column } : {}), ...(typeof a.answer === 'string' ? { answer: str(a.answer, 300) } : {}), ...(typeof a.from === 'string' ? { from: str(a.from, 120) } : {}) } : {}),
      flagged: [path, ...paths].some((p) => INSTRUCTION_FILES.test(p))
    }
    actions = [entry, ...actions].slice(0, MAX_ACTIONS)
    info(`guest ${entry.name || '?'}: ${kind}${entry.path ? ` ${entry.path}` : entry.count ? ` (${entry.count} files)` : ''}${entry.flagged ? ' (agent instructions)' : ''}`)
    send('liveShare:guestAction', entry)
    pushHost()
  }

  // --- Conversations guests watch -------------------------------------------
  // One reader per pane, opened by the first guest watching it, closed with
  // the last (shareHost.js chatWatch). Its file not there (yet), or its
  // reader given up for another: guests are told, and it is read again later.
  const chatReader = typeof makeChatViews === 'function' ? makeChatViews((channel, msg) => channel === 'transcriptView:event' && onFeedEvent(msg)) : null
  const feeds = new Map() // pane id -> { s, key, viewId, retry, code, tries }
  const feedOfView = new Map() // view id -> pane id
  const sourceKey = (c) => (c ? `${c.agentId}|${c.sessionId}|${c.hostId || ''}|${c.reason || ''}|${c.accountId === undefined ? '' : String(c.accountId)}` : '')
  function pushChat(s, id, read) {
    const feed = feeds.get(id)
    // Nobody watches (it lingers): kept for the next guest, not sent.
    if (feed && feed.lingering) {
      if (read.ok) feed.last = read
      return
    }
    if (feed && read.ok) feed.last = read
    // The same "nothing yet" again: not said again.
    if (feed && !read.ok && feed.code === read.code) return
    if (feed) feed.code = read.ok ? null : read.code
    const src = chatSourceOf(s, id)
    const project = chatHomes(s).get(id) || null
    // Written from the shared project's folders only (a pane opened outside
    // it never makes that folder readable), then as History and Activity:
    // the hidden files' names out, and no host path left anywhere.
    const { roots: chatRoots, raw } = chatRootsOf(project, src)
    const payload = guestChatPayload(read, chatRoots)
    if (!payload.ok) return s.server?.sendChat(id, payload)
    const seq = (chatSeq.get(id) || 0) + 1
    chatSeq.set(id, seq)
    hiddenMasker(project)(mapChatTexts(payload, (t) => t))
      .then((texts) => {
        // A newer read of the pane went meanwhile: that one is sent.
        if (sharing !== s || chatSeq.get(id) !== seq) return
        mapChatTexts(payload, (_t, i) => (typeof texts[i] === 'string' ? texts[i] : ''))
        s.server?.sendChat(id, assertNoHostPaths(payload, raw).value)
      })
      .catch(() => {})
  }
  // A pane's conversation's folders for guests: the shared project's own
  // (as given and real) and the pane's inside them. A pane on an SSH host:
  // the window already kept its project's folder there and the pane's inside
  // it (liveShareLayout.js hostChatsFromWorkspace). -> { roots, raw }
  const chatSeq = new Map() // pane id -> the latest push's number
  function chatRootsOf(project, src) {
    const paneRoots = src && Array.isArray(src.roots) ? src.roots : []
    const root = project ? roots.get(project) || null : null
    const info = root ? scope.root(root) : null
    // Its folder as the scope knows it (given and real), else as the window gave it.
    const own = (info ? [info.root, info.real] : [root]).filter((r) => typeof r === 'string' && r)
    if (src && src.hostId) return { roots: paneRoots, raw: [...own, ...paneRoots] }
    const kept = chatRootsWithin(paneRoots, own)
    return { roots: kept, raw: [...new Set([...own, ...kept])] }
  }
  const reopenMs = chatRetry.reopenMs ?? FEED_REOPEN_MS
  const lingerMs = chatRetry.lingerMs ?? FEED_LINGER_MS
  const opensPerMinute = chatRetry.opensPerMinute ?? FEED_OPENS_PER_MINUTE
  const retry = { first: chatRetry.firstMs ?? FEED_RETRY_MS, max: chatRetry.maxMs ?? FEED_RETRY_MAX_MS, tries: chatRetry.tries ?? FEED_TRIES }
  function retryFeed(s, id, feed, ms) {
    clearTimeout(feed.retry)
    if (feed.tries >= retry.tries) return
    feed.retry = setTimeout(
      () => {
        if (feeds.get(id) === feed && sharing === s) openFeed(s, id, { retry: true })
      },
      ms || Math.min(retry.max, retry.first * 2 ** feed.tries)
    )
    feed.retry.unref?.()
  }
  // Opens of a pane's reader in the last minute (kept when a feed closes).
  const feedOpens = new Map()
  function openAllowed(id) {
    const t = Date.now()
    const recent = (feedOpens.get(id) || []).filter((x) => t - x < 60000)
    if (recent.length >= opensPerMinute) {
      feedOpens.set(id, recent)
      return false
    }
    recent.push(t)
    feedOpens.set(id, recent)
    if (feedOpens.size > 256) for (const [k, v] of feedOpens) if (!v.some((x) => t - x < 60000)) feedOpens.delete(k)
    return true
  }
  // The first guest watches again, or the reader is let go and opened anew.
  function watchFeed(s, id) {
    const feed = feeds.get(id)
    if (feed && feed.lingering && feed.s === s && feed.viewId && sourceKey(chatSourceOf(s, id)) === feed.key) {
      clearTimeout(feed.linger)
      feed.lingering = false
      feed.linger = null
      if (feed.last) {
        feed.code = null
        pushChat(s, id, feed.last)
      }
      return
    }
    openFeed(s, id)
  }
  function unwatchFeed(id) {
    const feed = feeds.get(id)
    if (!feed) return
    // Nothing open to keep (waiting to retry): let go at once.
    if (!feed.viewId) return closeFeed(id)
    feed.lingering = true
    clearTimeout(feed.linger)
    feed.linger = setTimeout(() => {
      if (feeds.get(id) === feed) closeFeed(id)
    }, lingerMs)
    feed.linger.unref?.()
  }
  function openFeed(s, id, { retry = false } = {}) {
    const before = feeds.get(id)
    closeFeed(id)
    const src = chatSourceOf(s, id)
    const feed = { s, key: sourceKey(src), viewId: null, retry: null, linger: null, lingering: false, last: null, code: before ? before.code : null, tries: retry && before ? before.tries + 1 : 0, evicted: before ? before.evicted : 0 }
    feeds.set(id, feed)
    if (!src || !chatReader) return pushChat(s, id, { ok: false, code: 'missing' })
    // Too many reads of this pane lately: busy, tried again later.
    if (!src.reason && !openAllowed(id)) {
      pushChat(s, id, { ok: false, code: 'busy' })
      return retryFeed(s, id, feed, FEED_REOPEN_MS)
    }
    // A pane listed only to say why it has no conversation: nothing to read.
    if (src.reason) return pushChat(s, id, { ok: false, code: 'unavailable' })
    const q = src.hostId ? { agent: src.agentId, sessionId: src.sessionId, hostId: src.hostId } : { agent: src.agentId, sessionId: src.sessionId, paneId: id, ...(src.accountId !== undefined ? { accountId: src.accountId } : {}) }
    Promise.resolve()
      .then(() => chatReader.openFromWindow(q))
      .catch(() => null)
      .then((res) => {
        if (feeds.get(id) !== feed) {
          if (res && res.ok) chatReader.close(res.viewId)
          return
        }
        if (!res || !res.ok) {
          pushChat(s, id, { ok: false, code: res && res.code === 'missing' ? 'missing' : 'error' })
          return retryFeed(s, id, feed)
        }
        feed.viewId = res.viewId
        // A reader let go for room (evicted) keeps its tries: it cannot
        // flap forever against the others.
        if (!feed.evicted) feed.tries = 0
        feedOfView.set(res.viewId, id)
        pushChat(s, id, res)
      })
  }
  function closeFeed(id) {
    const feed = feeds.get(id)
    if (!feed) return
    feeds.delete(id)
    clearTimeout(feed.retry)
    clearTimeout(feed.linger)
    if (feed.viewId) {
      feedOfView.delete(feed.viewId)
      try {
        chatReader.close(feed.viewId)
      } catch {
        /* already closed */
      }
    }
  }
  function onFeedEvent(msg) {
    const id = msg && feedOfView.get(msg.viewId)
    const feed = id ? feeds.get(id) : null
    if (!feed || feed.viewId !== msg.viewId) return
    if (msg.ok) return pushChat(feed.s, id, msg)
    // Nobody watches it: no reason to open it again.
    if (feed.lingering) return closeFeed(id)
    feedOfView.delete(msg.viewId)
    feed.viewId = null
    const given = msg.code === 'closed'
    if (given) feed.evicted++
    pushChat(feed.s, id, { ok: false, code: given ? 'busy' : 'missing' })
    retryFeed(feed.s, id, feed, given ? reopenMs : 0)
  }
  // The window's panes changed: a conversation that changed (a new session,
  // another account) is read anew for the guests watching it.
  function refreshFeeds() {
    for (const [id, feed] of [...feeds]) {
      if (sharing !== feed.s) continue
      const src = chatSourceOf(feed.s, id)
      if (src && sourceKey(src) !== feed.key) openFeed(feed.s, id)
    }
  }
  function closeAllFeeds() {
    for (const id of [...feeds.keys()]) closeFeed(id)
  }

  // Guests are told at once what they no longer see (a pane taken out, a
  // project taken out of the share: nothing more of it goes out from now,
  // shareHost checks paneProject), the rest after a short pause.
  function changedNow() {
    if (!sharing?.server) return
    clearTimeout(changedTimer)
    changedTimer = null
    sharing.server.panesChanged()
  }

  function screenChanged() {
    if (!sharing?.server || changedTimer) return
    changedTimer = setTimeout(() => {
      changedTimer = null
      sharing?.server?.panesChanged()
    }, 60)
  }

  // A snapshot of a pane's screen from the terminal host: ready() is called
  // the moment its answer is read, in order with the pane's output. Its text
  // (the screen without the scrollback) follows. The terminal host is asked
  // for no scrollback (one started by an older Tessel sends it all anyway:
  // visibleScreen keeps the screen either way).
  function snapshot(id, ready) {
    const toSnap = (msg) => {
      if (!(msg && msg.ok)) return null
      const size = sizes.get(id) || { cols: 0, rows: 0 }
      return { data: visibleScreen(msg.buffer || '', size.cols, size.rows), ...size }
    }
    let snap
    const once = (msg) => (snap === undefined ? (snap = toSnap(msg)) : snap)
    return host.request('attach', { id, scrollback: 0 }, undefined, (msg) => ready(once(msg))).then(once)
  }

  // What the next Tessel needs to take this share back after a restart, or
  // start it again on a new tunnel: kept while it shares, and while it
  // starts again by itself (no tunnel then: the next one starts a new one).
  function saveHost() {
    const s = sharing
    // (Not once it ends or pauses: its last guests leaving must not write a
    // share Stop sharing just deleted.)
    if (!s || !s.server || s.cancelled || !(s.state === 'sharing' || s.kept)) return
    const live = s.state === 'sharing' && s.tunnel
    hostFile.write(sealRecord({
      format: 2,
      url: live ? s.tunnel.url : s.lastUrl || null,
      port: live ? s.port : 0,
      pid: (live && s.tunnel.pid) || 0,
      hostName: s.hostName,
      hostKey: exportSigningKey(s.hostKey),
      projectIds: [...(s.projects || [])],
      access: s.server.accessState(),
      // The share's rendezvous secret, its last counter, and where its address
      // was said (not said again after a restart at the same address).
      shareSecret: s.shareSecret.toString('base64'),
      relaySeq: s.relaySeq || 0,
      relay: live && publisher ? { url: s.tunnel.url, at: s.publishedAt || 0, topics: publisher.said(s.tunnel.url) } : null
    }))
  }

  // The topics a share says its address on (shareRendezvous.js): its own
  // (for the guests it let in) and each invitation that still lets new
  // guests in.
  const relaySecrets = (s) => [s.shareSecret, ...(s.server ? s.server.liveCodeSecrets() : [])]
  // Never lower than the last one said (saved with the share), and never
  // behind the clock.
  const nextSeq = (s) => () => (s.relaySeq = Math.max((s.relaySeq || 0) + 1, Date.now()))
  // Where the share is now, said on the relay. refresh: every topic again
  // (the relay about to forget); otherwise only the topics not yet said at
  // this address (a new address, a new invitation).
  function publishAddress(s, refresh = false) {
    if (!publisher || !relayOn() || sharing !== s || s.state !== 'sharing' || !s.tunnel || !s.server) return
    if (refresh || !s.publishedAt || s.publishedUrl !== s.tunnel.url) {
      s.publishedAt = Date.now()
      s.publishedUrl = s.tunnel.url
    }
    publisher.publish({ url: s.tunnel.url, hostKey: s.hostKey, secrets: relaySecrets(s), nextSeq: nextSeq(s), refresh })
  }

  // Requests to open sent to the window (opened at once with the right, or
  // asked of the host without it: { action, request, spec, guest }), kept
  // until the window is done with them (liveShare:requestDone): one that no
  // longer stands (the guest gone, its project or, for one opened with the
  // right, that right taken away), or kept too long or past the most kept, is
  // called off ({ action: 'cancel', request }).
  const REQUEST_KEEP_MS = requestLimits.keepMs ?? 2 * 60 * 1000
  const MAX_REQUESTS = requestLimits.max ?? 32
  const hostRequests = new Map() // request id -> { action, guestId, spec, at }
  let nextRequest = 1
  function cancelRequest(request) {
    if (!hostRequests.delete(request)) return
    send('liveShare:hostRequest', { action: 'cancel', request })
  }
  function requestOpen(action, spec, guest) {
    const t0 = Date.now()
    for (const [id, r] of [...hostRequests]) if (t0 - r.at > REQUEST_KEEP_MS) cancelRequest(id)
    if (hostRequests.size >= MAX_REQUESTS) cancelRequest(hostRequests.keys().next().value)
    const request = `r${nextRequest++}`
    hostRequests.set(request, { action, guestId: guest.id, spec, at: t0 })
    send('liveShare:hostRequest', { action, request, spec, guest })
  }
  const sameModels = (a, b) => (!a && !b) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x)))
  function checkRequests(list) {
    for (const [request, r] of [...hostRequests]) {
      const g = list.find((x) => x.id === r.guestId && x.state === 'joined')
      // (An agent: still one its agents rule allows, with the models it allows.)
      const rule = r.spec.kind === 'agent' && sharing?.server ? sharing.server.agentRuleOf(g ? g.id : '') : null
      const agentOk = r.spec.kind !== 'agent' || (agentAllowed(rule, r.spec.agent) && (!r.spec.model || modelAllowed(rule, r.spec.agent, r.spec.model)) && sameModels(allowedModels(rule, r.spec.agent), r.spec.models))
      if (g && agentOk && g.projects.includes(r.spec.project) && (r.action !== 'open' || (g.rights && g.rights.open))) continue
      cancelRequest(request)
    }
  }

  // extra: what a share taken back had (access: its invitations, codes and
  // people; or, saved before invitations, its one code: secret, known,
  // secrets, guard, inviteExpires, knownAt).
  function makeServer(s, extra = {}) {
    return createShareHost({
      hostName: s.hostName,
      hostKey: s.hostKey,
      rendezvousSecret: s.shareSecret,
      log: info,
      trust,
      ...extra,
      callbacks: {
        projects: () => sharedProjects(s),
        paneProject: (id) => homes(s).get(id) || null,
        chatProject: (id) => chatHomes(s).get(id) || null,
        onChatsWatched: () => sharing === s && pushPresence(),
        onPresence: () => sharing === s && pushPresence(),
        ...(chatReader ? { chatWatch: (id, on) => (on ? watchFeed(s, id) : unwatchFeed(id)) } : {}),
        snapshot,
        // Phase 2's requests and topics (shareChannel.js).
        opInfo: (op) => {
          const o = channelOps.get(op)
          return o ? { right: o.right, kind: o.kind, bulk: o.bulk } : null
        },
        request: (req, ctx) => {
          const o = channelOps.get(req.op)
          return o ? o.run(req, ctx, s) : { ok: false, code: 'bad-op' }
        },
        watch: (topic, project, key, on) => channelTopics.get(topic)?.(s, project, key, on),
        // Phase 2b: the panes and the history always; the usage when there
        // are readings to give.
        // The host's editor tabs always; its pages as links when this Tessel
        // can read them.
        offers: (feature) => (feature === 'usage' ? !!usage : feature === 'links' ? !!linkFeed : feature === 'paste' ? !!images : feature === 'panes2' || feature === 'history' || feature === 'tabs'),
        write: (id, data) => host.send('write', { id, data }),
        agents: () => hostAgents,
        agentDefault: () => shareSettings.agents || null,
        paneAgent: (id) => paneView(id),
        paneTyped: (id, data) => paneTyped(id, data),
        // A pane a guest typed in switched to what its rule refuses (Esc was
        // pressed in it): the host's window says so.
        onRuleBreach: (b) => sharing === s && send('liveShare:hostRequest', { action: 'ruleBreach', guest: { id: b.guest.id, name: b.guest.name }, pane: b.pane, agent: b.agent, model: b.model }),
        openPane: (spec, guest) => requestOpen('open', spec, guest),
        askOpen: (spec, guest) => requestOpen('ask-open', spec, guest),
        closePane: (id, guest) => send('liveShare:hostRequest', { action: 'close', id, guest }),
        askApproval: (guest) =>
          new Promise((resolve) => {
            asks.set(guest.id, { resolve, trustable: !!guest.trustable })
            send('liveShare:ask', { guestId: guest.id, name: guest.name, code: guest.code || null, invite: guest.invite || null, offer: guest.offer || null, trustable: !!guest.trustable })
          }),
        onGuests: (list) => {
          s.guests = list
          for (const id of [...asks.keys()]) if (!list.some((g) => g.id === id && g.state === 'waiting')) asks.delete(id)
          checkRequests(list)
          endTaskRequests('revoked', (r) => !list.some((g) => g.id === r.guestId && g.state === 'joined' && g.rights && g.rights.tasks && g.projects.includes(r.project)))
          // A guest that lost the type right (or left): its paste waiting
          // for the window is called off (an upload it left ends on its own).
          endPasteRequests((r) => !list.some((g) => g.id === r.guestId && g.state === 'joined' && g.rights && g.rights.type))
          pushHost()
        },
        onInviteBlocked: (id) => {
          info(`invitation ${id} blocked: too many connections stopped after the handshake`)
          saveHost()
          pushHost()
          send('liveShare:inviteBlocked', { id })
        },
        onKnownChanged: () => {
          saveHost()
          // (While it starts, the window has nothing of it to show yet.)
          if (sharing === s && s.state === 'sharing') {
            pushHost()
            // A new code (a new invitation, one given a new code): said too.
            publishAddress(s)
          }
        }
      }
    })
  }

  // What ends with a share or a pause of it: its server (guests told why),
  // its tunnel (unless kept for the next Tessel), its retries, and what it
  // follows for guests.
  function teardown(s, reason, { now = false, keepTunnel = false } = {}) {
    s.cancelled = true
    clearTimeout(s.retryTimer)
    clearInterval(hostTimer)
    hostTimer = null
    try {
      s.server?.stop(reason)
    } catch {
      /* already stopped */
    }
    if (!keepTunnel) {
      try {
        if (now && s.tunnel?.stopNow) s.tunnel.stopNow()
        else s.tunnel?.stop()
      } catch {
        /* already stopped */
      }
    }
    for (const ask of asks.values()) ask.resolve(false)
    asks.clear()
    hostRequests.clear()
    clearTimeout(presenceTimer)
    presenceTimer = null
    publisher?.forget()
    closeAllFeeds()
    stopWatches()
    scope.reset()
    endTaskRequests('revoked')
    endPasteRequests()
    pasteUploads.clear()
    endPanels()
    linkFeed?.stop()
    pageList = []
    hostTabs = new Map()
    tabsSent.clear()
    pastSessions.forget()
    activityWatched.clear()
    activities = new Map()
    activityRaw = new Map()
    layouts = new Map()
    chatSources = new Map()
    roots = new Map()
    boards = new Map()
    actions = []
    layoutsRev++
  }

  // Stop sharing: the share ends for good (its saved copy too; nothing
  // starts it again). A share being taken back after a restart is stopped
  // too (stopRun). now: quitting, nothing waited for.
  function stopSharing(reason = 'stopped', error = null, { now = false } = {}) {
    stopRun++
    // (A share being taken back is forgotten at once too.)
    hostFile.clear()
    const s = sharing
    if (!s) return
    // Said on the relay too, so guests offline now end when they look.
    const marker = reason === 'stopped' && s.kept && s.server && publisher && relayOn() ? { hostKey: s.hostKey, secrets: relaySecrets(s), nextSeq: nextSeq(s) } : null
    teardown(s, reason, { now })
    if (marker) publisher.stop(marker).catch(() => {})
    sharing = error ? { state: 'error', error, guests: [] } : null
    info(`sharing stopped (${reason})`)
    pushHost()
    if (error) sharing = null
  }

  // Quitting Tessel or an update: the share only pauses. Guests are told it
  // restarts (they come back by themselves), and it is saved for the next
  // Tessel, with its tunnel when keepTunnel (an update: taken back as it is).
  // A share still starting for the first time (never saved) ends.
  function pauseSharing({ keepTunnel = false } = {}) {
    const s = sharing
    if (!s) return
    if (!s.kept) return stopSharing('stopped', null, { now: true })
    saveHost()
    teardown(s, 'restarting', { now: true, keepTunnel: keepTunnel && s.state === 'sharing' })
    sharing = null
    info('sharing paused: the next Tessel starts it again')
  }

  // While sharing: the saved share kept fresh; a tunnel taken back after a
  // restart (not this Tessel's child) watched by its PID (cheap: its program
  // was checked when it was taken back); the address said again on the relay
  // before it forgets it.
  function watchHost(s) {
    clearInterval(hostTimer)
    hostTimer = setInterval(() => {
      if (sharing !== s) return
      if (s.state === 'sharing' && s.adopted && !pidRunning(s.tunnel.pid)) {
        tunnelLost(s, s.tunnel, null)
        return
      }
      saveHost()
      if (s.state === 'sharing' && Date.now() - (s.publishedAt || 0) >= REPUBLISH_MS) publishAddress(s, true)
    }, KEEP_FRESH_MS)
    hostTimer.unref?.()
  }

  // The share's tunnel stopped while sharing (cloudflared ended, or a tunnel
  // taken back is gone): the share stays, and starts again on a new tunnel
  // (guests find its new address on the relay).
  function tunnelLost(s, tunnel, code) {
    if (sharing !== s || s.cancelled || s.state !== 'sharing' || !tunnel || s.tunnel !== tunnel) return
    warn(code === null || code === undefined ? 'the Cloudflare tunnel stopped: starting a new one' : `the Cloudflare tunnel stopped (code ${code}): starting a new one`)
    try {
      tunnel.stop()
    } catch {
      /* already stopped */
    }
    s.lastUrl = tunnel.url
    s.tunnel = null
    s.adopted = false
    relaunch(s)
  }

  // Starts cloudflared to the share's port and waits until its address
  // answers (s.tunnel). false: cancelled meanwhile; throws why it failed.
  async function openTunnel(s, cancelled) {
    // A tunnel left running by a Tessel that did not take its share back.
    await endLeftoverTunnel(dataDir, { queryState, kill }).catch(() => false)
    if (cancelled()) return false
    const exe = await ensureCloudflared(dataDir, {
      onProgress: (p) => {
        s.progress = p
        pushHost()
      }
    })
    if (cancelled()) return false
    s.progress = null
    s.state = 'starting'
    pushHost()
    let tunnel = null
    tunnel = await startTunnel({ exe, port: s.port, dataDir, onExit: (code) => tunnelLost(s, tunnel, code) })
    s.tunnel = tunnel
    if (cancelled()) {
      tunnel.stop()
      s.tunnel = null
      return false
    }
    s.state = 'checking'
    pushHost()
    // Its address goes nowhere until cloudflared connected to Cloudflare
    // (a network that blocks it: it never does).
    if (!(await waitRegistered(dataDir, { cancelled }))) {
      if (cancelled()) return false
      throw new Error(
        t('main.liveShare.notConnected', 'The Cloudflare tunnel could not connect ({{detail}}). Check your internet connection, or whether a firewall or an antivirus blocks Cloudflare.', {
          detail: tunnelLogTail(dataDir, 2) || 'no answer'
        })
      )
    }
    // Why the address did not answer, each time (the most frequent is said).
    const fails = new Map()
    const onFail = (reason) => fails.set(reason, (fails.get(reason) || 0) + 1)
    if (!(await waitReachable(tunnel.url, { cancelled, onFail }))) {
      if (cancelled()) return false
      const why = [...fails].sort((a, b) => b[1] - a[1]).map(([r, n]) => (n > 1 ? `${r} ×${n}` : r)).join(', ') || 'no answer'
      throw new Error(
        t('main.liveShare.unreachableWhy', 'The tunnel address could not be reached ({{detail}}). Check your internet connection, or whether a firewall, an antivirus or a DNS filter blocks trycloudflare.com.', { detail: why })
      )
    }
    return !cancelled()
  }

  // A kept share starting again by itself on a new tunnel (taken back after
  // a restart, or its tunnel lost): its server (the same keys, invitations
  // and people) on a port of its own, then a tunnel; one that can't start is
  // tried again later (RELAUNCH_DELAYS), until it works or Stop sharing.
  async function relaunch(s) {
    if (s.relaunching || s.cancelled || sharing !== s) return
    s.relaunching = true
    clearTimeout(s.retryTimer)
    s.state = 'preparing'
    pushHost()
    const cancelled = () => s.cancelled || sharing !== s
    try {
      if (!s.port) s.port = await s.server.start(0)
      if (!(await openTunnel(s, cancelled))) return
      s.state = 'sharing'
      s.retry = null
      s.tries = 0
      // Back after a restart (not a tunnel lost while sharing): said once.
      if (s.resuming) {
        s.resuming = false
        s.resumedAt = Date.now()
      }
      info(`sharing again at ${s.tunnel.url}`)
      saveHost()
      watchHost(s)
      // A new address: said on the relay (debounced there).
      publishAddress(s)
      pushHost()
    } catch (err) {
      if (cancelled()) return
      const message = tunnelErrorText(err)
      warn(`sharing could not start again: ${message}`)
      if (s.tunnel) {
        const tail = tunnelLogTail(dataDir, 8)
        if (tail) warn(`cloudflared: ${tail}`)
        try {
          s.tunnel.stop()
        } catch {
          /* already stopped */
        }
        s.tunnel = null
      }
      const delay = relaunchDelays[Math.min(s.tries || 0, relaunchDelays.length - 1)]
      s.tries = (s.tries || 0) + 1
      s.state = 'starting'
      s.retry = { at: Date.now() + delay, error: message }
      saveHost()
      pushHost()
      s.retryTimer = setTimeout(() => relaunch(s), delay)
      s.retryTimer.unref?.()
    } finally {
      s.relaunching = false
    }
  }

  // projects: the ids of the projects to share (the window's); invite: the
  // first invitation ({ label, lifetime, maxUses, rights }: it offers every
  // project shared).
  async function startSharing({ name, projects, invite = {} } = {}) {
    if (sharing && sharing.state !== 'error') return { ok: true, ...hostStatus() }
    const s = { state: 'preparing', guests: [], progress: null, cancelled: false, hostName: str(name, 40) || defaultShareName(), hostKey: newSigningKey(), shareSecret: newSecret(), projects: cleanProjectIds(projects) }
    sharing = s
    pushHost()
    try {
      s.server = makeServer(s)
      const first = s.server.createInvite({ ...(invite && typeof invite === 'object' ? invite : {}), projects: s.projects })
      if (!first.ok) throw new Error(t('main.liveShare.badInviteSpec', 'The first invitation could not be made: check its lifetime and number of uses.'))
      s.port = await s.server.start()
      if (s.cancelled) return { ok: false }
      if (!(await openTunnel(s, () => s.cancelled))) return { ok: false }
      s.state = 'sharing'
      // From now on it is kept until Stop sharing (a restart starts it again).
      s.kept = true
      rememberProjects(s.projects)
      info(`sharing at ${s.tunnel.url}`)
      saveHost()
      watchHost(s)
      publishAddress(s)
      pushHost()
      return { ok: true, ...hostStatus() }
    } catch (err) {
      const message = tunnelErrorText(err)
      // Said in the log too (the window's message goes with the dialog).
      warn(`sharing failed: ${message}`)
      if (s.tunnel) {
        const tail = tunnelLogTail(dataDir, 8)
        if (tail) warn(`cloudflared: ${tail}`)
      }
      if (sharing === s) stopSharing('error', message)
      return { ok: false, error: message }
    }
  }

  const shareSecretOf = (saved) => {
    const b = typeof saved.shareSecret === 'string' ? Buffer.from(saved.shareSecret, 'base64') : null
    return b && b.length === 32 ? b : newSecret()
  }

  // A saved share's keys, projects and access ({ hostKey, projects, extra },
  // extra for makeServer), or null when it can't be read.
  function savedShare(saved) {
    const hostKey = importSigningKey(saved.hostKey)
    if (!hostKey) return null
    // Its projects (a share saved by a Tessel that shared only one: that
    // one).
    const projects = cleanProjectIds(Array.isArray(saved.projectIds) ? saved.projectIds : [saved.projectId])
    if (saved.format === 2) {
      if (!saved.access || typeof saved.access !== 'object') return null
      return { hostKey, projects, extra: { access: saved.access } }
    }
    // Saved before invitations: its one code becomes a root invitation,
    // with its earlier secrets, its block and its guests (each with what it
    // saw; saved without it: the projects shared then, which is what it saw).
    let secret
    try {
      secret = Buffer.from(String(saved.secret), 'base64')
    } catch {
      return null
    }
    if (secret.length !== 32) return null
    const earlier = (Array.isArray(saved.secrets) ? saved.secrets : []).map((x) => Buffer.from(String(x), 'base64')).filter((x) => x.length === 32)
    const known = (Array.isArray(saved.known) ? saved.known : []).map((k) => (k && typeof k === 'object' && !Array.isArray(k.projects) ? { ...k, projects } : k))
    return { hostKey, projects, extra: { secret, known, knownAt: saved.savedAt, secrets: earlier, guard: saved.guard, inviteExpires: Number(saved.expiresAt) || undefined } }
  }

  // At every start of Tessel (a restart, an update, a reboot): the share the
  // last Tessel left, started again with its keys, invitations and codes, its
  // earlier secrets, its blocks and the people it let in (removed people stay
  // out, expired invitations expired). Its tunnel taken back when it still
  // runs (the same address: every code works as it is), once its port is
  // free (the last Tessel can take a minute to quit); otherwise a new tunnel,
  // a new address said on the relay (relaunch: tried until it works). Guests
  // reconnect by themselves. The saved share is never deleted on the way,
  // only when it can't be read or the host presses Stop sharing meanwhile
  // (stopRun); quitting, another taking-back or an update meanwhile only let
  // it go, kept for the next Tessel.
  let resumeRun = 0
  let stopRun = 0
  let quitting = false
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  async function resumeSharing() {
    return await takeShareBack()
  }
  async function takeShareBack() {
    const run = ++resumeRun
    const stops = stopRun
    const raw = hostFile.read()
    if (!raw) {
      await endLeftoverTunnel(dataDir, { queryState, kill }).catch(() => false)
      return false
    }
    const saved = openRecord(raw)
    // Sealed, and the OS can't open it now: kept as it is for a next try.
    if (!saved) {
      warn('the saved share can not be opened now: kept for the next start')
      return false
    }
    const pid = Number(saved.pid) || 0
    const url = typeof saved.url === 'string' && /^wss?:\/\//.test(saved.url) ? saved.url : null
    // Ended for good: the tunnel (if still ours) and the saved share (if it is
    // still this one: a new share may have saved its own meanwhile).
    const end = async (why) => {
      info(`share not taken back: ${why}`)
      if (pid) await stopTunnelPid(dataDir, pid, { queryState, kill }).catch(() => false)
      hostFile.clearIf((x) => {
        const o = openRecord(x)
        return !!o && (Number(o.pid) || 0) === pid && o.url === saved.url
      })
      return false
    }
    // Still the one to take it back? Stopped meanwhile: ended; quitting,
    // superseded or suspended: let go quietly.
    const check = () => {
      if (stopRun !== stops) return quitting ? 'superseded' : 'stopped'
      if (run !== resumeRun || suspended || sharing) return 'superseded'
      return 'ok'
    }
    const restored = savedShare(saved)
    if (!restored) return end('unreadable')
    // Is that PID still this cloudflared? Windows may not say at once.
    let state = 'gone'
    if (pid) {
      state = 'unknown'
      for (let i = 0; i < 3 && state === 'unknown'; i++) {
        if (i) await wait(1500)
        state = await tunnelState(pid, { dataDir, queryState })
      }
    }
    if (check() === 'stopped') return end('stopped meanwhile')
    if (check() !== 'ok') return false
    const s = {
      state: 'starting',
      guests: [],
      progress: null,
      cancelled: false,
      hostName: str(saved.hostName, 40) || defaultShareName(),
      hostKey: restored.hostKey,
      projects: restored.projects,
      kept: true,
      resuming: true,
      // (A share saved before it had one gets one now.)
      shareSecret: shareSecretOf(saved),
      relaySeq: Number.isSafeInteger(saved.relaySeq) && saved.relaySeq > 0 ? saved.relaySeq : 0,
      lastUrl: url
    }
    const server = makeServer(s, restored.extra)
    s.server = server
    const stopServer = () => {
      try {
        server.stop('restarting')
      } catch {
        /* not started */
      }
    }
    const runs = pid && (state === 'ours' || (state === 'unknown' && pidRunning(pid)))
    if (runs && url && saved.port > 0) {
      // Its port: the last Tessel may take a while to let it go (a dev
      // restart kills it, but its processes can hold the port for several
      // seconds; one try of 3 s, then of 30 s, lost a share you had guests
      // in: the old Tessel can take a minute to quit, 2026-10-18). Tried for
      // up to PORT_WAIT_MS, every half second.
      let port = 0
      for (let i = 0; i < portWaitMs / 500 && !port && check() === 'ok'; i++) {
        try {
          port = await server.start(saved.port)
        } catch {
          await wait(500)
        }
      }
      const c = check()
      if (c !== 'ok') {
        stopServer()
        return c === 'stopped' ? end('stopped meanwhile') : false
      }
      if (port) {
        s.port = port
        s.adopted = true
        s.tunnel = {
          url,
          pid,
          // Stop sharing: only while it is still this cloudflared.
          stop: () => stopTunnelPid(dataDir, pid, { queryState, kill }).catch(() => false),
          // Quitting: ended now if that PID still runs this cloudflared (a few
          // seconds at most); if Windows can't say in time, the next Tessel does.
          stopNow: () => stopTunnelLater(dataDir, pid)
        }
        s.state = 'sharing'
        s.resuming = false
        s.resumedAt = Date.now()
        sharing = s
        info(`sharing taken back after a restart (${url})`)
        // Its address was said already: not again (only what is missing),
        // until the relay is about to forget it.
        const r = saved.relay
        if (publisher && r && r.url === url && Number.isFinite(r.at) && Date.now() - r.at < REPUBLISH_MS) {
          publisher.seed(url, r.topics)
          s.publishedAt = r.at
          s.publishedUrl = url
        }
        saveHost()
        watchHost(s)
        publishAddress(s)
        pushHost()
        return true
      }
      // Still taken: that tunnel leads to it, so a new port, a new tunnel.
      info(`port ${saved.port} still taken: sharing again on a new tunnel`)
      await stopTunnelPid(dataDir, pid, { queryState, kill }).catch(() => false)
      const after = check()
      if (after !== 'ok') return after === 'stopped' ? end('stopped meanwhile') : false
    }
    // A new tunnel (a new address), the same share. From here on the share
    // is this Tessel's (Stop sharing, quitting and an update act on it).
    sharing = s
    info('sharing again after a restart, on a new tunnel')
    pushHost()
    await relaunch(s)
    return true
  }

  // An access change made through the share server, while sharing (the
  // server's onKnownChanged saves it and shows it).
  function withServer(fn) {
    const s = sharing
    if (!s || s.state !== 'sharing' || !s.server) return { ok: false, reason: 'not-sharing' }
    return fn(s.server, s)
  }
  // A subject id from the window (a guest, a person, a trusted person, an
  // invitation): plain text, bounded.
  const subjectId = (id) => (typeof id === 'string' && /^[\w-]{1,48}$/.test(id) ? id : '')

  // A project added to the share or taken out of it, at any time (also while
  // it starts). Taken out: its panes vanish for every guest at once, and no
  // request about them is taken any more; it is no guest's any more. Added:
  // guests already in do not see it until the host gives it to them. The last
  // project stays (Stop sharing ends the share).
  function setShared(id, on) {
    const s = sharing
    if (!s || s.state === 'error' || !isProjectId(id)) return { ok: false }
    const projects = s.projects || []
    const has = projects.includes(id)
    if (on ? has : !has) return { ok: true, projectIds: [...projects] }
    if (on && projects.length >= MAX_PROJECTS) return { ok: false, reason: 'full', max: MAX_PROJECTS }
    if (!on && projects.length <= 1) return { ok: false, reason: 'last' }
    s.projects = on ? [...projects, id] : projects.filter((x) => x !== id)
    rememberProjects(s.projects)
    info(on ? 'a project added to the share' : 'a project taken out of the share')
    if (sharing === s) changedNow()
    if (!on) {
      pastSessions.forget(id)
      refreshPages()
    }
    saveHost()
    pushHost()
    return { ok: true, projectIds: [...s.projects] }
  }

  // --- Phase 2: the host's projects in this window (shareChannel.js) -------
  // The host's Files, editor, Changes and notes: the window's usual calls
  // with lshare:// paths come here (index.js), and guestFs turns them into
  // requests to the host (checked again when they come back).
  function guestRequest(op, project, args, opts) {
    const g = joined
    if (!g || g.state !== 'joined' || !g.client) return Promise.reject(new Error('offline'))
    if (!g.projects.some((p) => p.id === project)) return Promise.resolve({ ok: false, code: 'no-project' })
    return g.client.request(op, project, args, opts)
  }
  const guestFs = createGuestFs({ request: guestRequest })

  // What this window follows on the host (subscription name -> { topic,
  // project, key }), asked again on each connection; a project the host no
  // longer shares with it is let go.
  const GUEST_SUBS = 128
  function guestSubscribe(topic, project, key, on) {
    const g = joined
    if (!g || !Object.hasOwn(TOPICS, topic)) return false
    const k = subKey(topic, project, key)
    if (!on) {
      if (!g.subs.delete(k)) return true
    } else {
      if (g.subs.has(k)) return true
      if (g.subs.size >= GUEST_SUBS) return false
      g.subs.set(k, { topic, project, key })
    }
    if (g.state === 'joined' && g.client) g.client.subscribe(topic, project, key, on)
    return true
  }
  function resubscribe(g) {
    for (const s of g.subs.values()) g.client.subscribe(s.topic, s.project, s.key, true)
  }
  // The host's usage: followed while this guest has the right (the host
  // refuses it without); the right taken away, what came goes.
  function syncUsage(g) {
    const want = g.features.has('usage') && !!(g.rights && g.rights.usage === true)
    const has = g.subs.has(subKey('usage', null, null))
    if (want && !has) guestSubscribe('usage', null, null, true)
    else if (!want && has) guestSubscribe('usage', null, null, false)
    if (!want && g.usage) {
      g.usage = null
      send('liveShare:push', { topic: 'usage', project: null, data: null })
    }
  }
  // The host's pages as links: followed in every project while this guest
  // has "See my browser pages" (the host refuses it without, project by
  // project); the right taken away, what came goes.
  function syncLinks(g) {
    const want = g.features.has('links') && !!(g.rights && g.rights.pagesView === true)
    for (const p of g.projects) {
      const has = g.subs.has(subKey('links', p.id, null))
      if (want && !has) guestSubscribe('links', p.id, null, true)
      else if (!want && has) guestSubscribe('links', p.id, null, false)
    }
    // Without the right, no page's videos are followed either.
    if (!want) for (const sub of [...g.subs.values()]) if (sub.topic === 'media') guestSubscribe('media', sub.project, sub.key, false)
    if (!want && g.links.size) {
      for (const project of g.links.keys()) send('liveShare:push', { topic: 'links', project, data: { pages: [] } })
      g.links.clear()
    }
  }
  function dropSubsOf(g) {
    const keep = new Set(g.projects.map((p) => p.id))
    for (const [k, s] of [...g.subs]) {
      if (s.project && !keep.has(s.project)) g.subs.delete(k)
    }
    if (g.watchedRoot && !keep.has(g.watchedRoot)) g.watchedRoot = null
    for (const id of [...g.tabs.keys()]) if (!keep.has(id)) g.tabs.delete(id)
    for (const id of [...g.links.keys()]) if (!keep.has(id)) g.links.delete(id)
    for (const id of [...g.activities.keys()]) if (!keep.has(id)) g.activities.delete(id)
  }

  // The Files tab's project (one at a time, like a local one): its files and
  // its git state followed.
  function guestWatchRoot(root) {
    const g = joined
    const loc = parseLsharePath(root)
    if (!g || !loc || loc.rel || !g.projects.some((p) => p.id === loc.project)) return { ok: false }
    if (g.watchedRoot && g.watchedRoot !== loc.project) guestUnwatchRoots()
    g.watchedRoot = loc.project
    guestSubscribe('fs', loc.project, null, true)
    guestSubscribe('scm', loc.project, null, true)
    return { ok: true }
  }
  function guestUnwatchRoots() {
    const g = joined
    if (!g || !g.watchedRoot) return { ok: true }
    guestSubscribe('fs', g.watchedRoot, null, false)
    guestSubscribe('scm', g.watchedRoot, null, false)
    g.watchedRoot = null
    return { ok: true }
  }
  // The host's files open in the editor (the others stop being followed):
  // how many are followed.
  function guestWatchFiles(paths) {
    const g = joined
    if (!g) return 0
    const want = new Map()
    for (const p of Array.isArray(paths) ? paths : []) {
      const loc = parseLsharePath(p)
      if (!loc || !loc.rel || want.size >= TOPICS.file.max || !g.projects.some((x) => x.id === loc.project)) continue
      want.set(subKey('file', loc.project, loc.rel), loc)
    }
    for (const [k, s] of [...g.subs]) if (s.topic === 'file' && !want.has(k)) guestSubscribe('file', s.project, s.key, false)
    for (const loc of want.values()) guestSubscribe('file', loc.project, loc.rel, true)
    return want.size
  }

  // News from the host, checked, in the shape the window already reads:
  // explorer:changed for the files (a change in git's state as a path in
  // .git, which the window reads as "status again"), editor:changed for an
  // open file, liveShare:push for a board.
  function onGuestPush(g, topic, project, key, data) {
    // The host's usage (host-wide): only while this guest has the right.
    if (topic === 'usage') {
      if (!g.subs.has(subKey('usage', null, null)) || !(g.rights && g.rights.usage === true)) return
      const usage = checkUsage(data)
      if (!usage) return
      g.usage = usage
      return send('liveShare:push', { topic: 'usage', project: null, data: usage })
    }
    if (!g.projects.some((p) => p.id === project) || !g.subs.has(subKey(topic, project, key))) return
    // A project's panes as the host's headers show them, with this window's
    // pane ids (the same as its terminals' and chats').
    if (topic === 'agents') {
      const panes = checkPanes(data && data.panes)
      if (!panes) return
      for (const p of panes) p.id = guestPaneId(g.session, p.id)
      g.paneAgents.set(project, panes)
      return send('liveShare:push', { topic: 'agents', project, data: { panes } })
    }
    const root = lshareRoot(project)
    if (topic === 'fs') {
      const list = data && Array.isArray(data.paths) ? data.paths : null
      const paths = list && list.length <= 256 && list.every((r) => typeof r === 'string' && r && cleanRel(r) === r) ? list.map((r) => lsharePath(project, r)) : null
      return send('explorer:changed', { root, paths, renamed: null })
    }
    if (topic === 'scm') return send('explorer:changed', { root, paths: [lsharePath(project, '.git')], renamed: null })
    if (topic === 'file') {
      const d = data && typeof data === 'object' ? data : {}
      const sig = typeof d.sig === 'string' && /^\d{1,20}:\d{1,20}$/.test(d.sig) ? d.sig : null
      return send('editor:changed', { path: lsharePath(project, key), exists: d.exists === true && !!sig, size: Number.isSafeInteger(d.size) && d.size >= 0 ? d.size : 0, mtimeMs: Number.isFinite(d.mtimeMs) ? d.mtimeMs : 0, sig })
    }
    if (topic === 'tasks') {
      const tasks = checkTasks(data && data.tasks)
      if (!tasks) return
      // The host's agent on a card: its pane here, when this window shows it.
      for (const card of tasks) card.paneId = card.paneId && g.panes.has(card.paneId) ? g.panes.get(card.paneId).localId : null
      g.boards.set(project, tasks)
      return send('liveShare:push', { topic: 'tasks', project, data: { tasks } })
    }
    if (topic === 'activity') {
      const checked = checkActivity(data, { paneId: (id) => guestPaneId(g.session, id), wsId: project })
      if (!checked) return
      g.activities.set(project, checked)
      return send('liveShare:push', { topic: 'activity', project, data: checked })
    }
    // The host's editor tabs (paths from the project's folder).
    if (topic === 'tabs') {
      const checked = checkTabs(data)
      if (!checked) return
      g.tabs.set(project, checked)
      return send('liveShare:push', { topic: 'tabs', project, data: checked })
    }
    // The host's pages as links, with "See my browser pages" only; each
    // page by its id in this window.
    if (topic === 'links') {
      if (!(g.rights && g.rights.pagesView === true)) return
      let checked = checkLinks(data, maskSecrets)
      if (!checked) return
      for (const p of checked.pages) {
        p.remote = p.id
        p.id = linkPaneId(g.session, p.id)
      }
      g.links.set(project, checked)
      checked = { pages: checked.pages.map(({ remote: _remote, ...rest }) => rest) }
      return send('liveShare:push', { topic: 'links', project, data: checked })
    }
  }

  // --- Phase 2c on the guest's side: its past conversations --------------------
  // The host's pane of one of this window's (a terminal or a chat), by its
  // id here.
  function hostPaneOf(g, id) {
    const pane = g.byLocal.get(id) || g.chatByLocal.get(id)
    return pane ? pane.remoteId : null
  }

  // --- Guest -------------------------------------------------------------
  // joined: { client, session, host, state, panes: Map(remoteId -> pane),
  // byLocal, projects: [{ id, layout }] (the host's projects this guest sees,
  // in order), rights, code, url, secret, invite, name, signingKey (this
  // guest's reconnect key), admitted, leaving, retry: { timer, since, tries } }
  let joined = null
  let sessions = 0
  let guestTimer = null

  const guestPanesList = (g) =>
    [...g.panes.values()].map((p) => ({ id: p.localId, project: p.project, title: p.title, kind: p.kind, agentId: p.agentId, accent: p.accent, cols: p.cols, rows: p.rows, gen: p.gen }))
  // The host's agent panes this guest can look at as a chat (terminal: the
  // host's pane has one; a pane in chat mode has none).
  const guestChatsList = (g) => [...g.chats.values()].map((e) => ({ id: e.localId, project: e.project, title: e.title, agentId: e.agentId, accent: e.accent, terminal: e.terminal, ...(e.reason ? { reason: e.reason } : {}) }))
  // A project's layout with this window's pane ids (only its own panes are
  // terminals shown here).
  const localLayout = (g, project) => {
    const layout = project.layout
    if (!layout) return null
    const mine = (id) => {
      const pane = id && g.panes.get(id)
      return pane && pane.project === project.id ? pane : null
    }
    // A browser pane's id is a link's here (linkPaneId): never a terminal's.
    const idOf = (n) => (n.view === 'terminal' && mine(n.id) ? mine(n.id).localId : n.view === 'browser' ? linkPaneId(g.session, n.id) : guestPaneId(g.session, n.id))
    const map = (n) => (n.type === 'leaf' ? { ...n, id: idOf(n) } : { ...n, children: n.children.map(map) })
    const local = (id) => (mine(id) ? mine(id).localId : null)
    // The tab shown: an editor or a browser pane is never a terminal here.
    const shownLeaf = layout.shown && layout.shown !== 'terminal' ? layoutLeaves(layout).find((l) => l.id === layout.shown) : null
    const shown = layout.shown === 'terminal' ? 'terminal' : shownLeaf ? idOf(shownLeaf) : null
    return { project: layout.project, tree: layout.tree ? map(layout.tree) : null, activeId: local(layout.activeId), maximizedId: local(layout.maximizedId), shown, copy: layout.copy || null }
  }
  const guestStatus = () =>
    joined
      ? {
          state: joined.state,
          host: joined.host,
          session: joined.session,
          panes: guestPanesList(joined),
          projects: joined.projects.map((p) => ({ id: p.id, layout: localLayout(joined, p) })),
          reason: joined.reason || null,
          // What the host lets this guest do, and the code to tell the host.
          rights: joined.rights,
          code: joined.code,
          // Whether the host's Tessel shares conversations, and its panes
          // that have one.
          chat: joined.features.has('chat'),
          chats: guestChatsList(joined),
          // The agents the host lists (its Tessel can be asked to open one,
          // and asked to open without the right): null for an older host.
          agents: joined.features.has('agents') ? joined.agents : null,
          // What the host's Tessel speaks beyond the protocol (the window
          // says "the host needs to update" for what it does not).
          features: [...joined.features]
        }
      : { state: 'off', host: null, session: null, panes: [], projects: [], reason: null, rights: null, code: null, chat: false, chats: [], agents: null, features: [] }
  const pushGuest = () => send('liveShare:guest', guestStatus())

  // Its address too (the relay may have given a newer one than its code's),
  // and the last relay message it took (an older one is refused).
  function saveGuest(g) {
    if (joined !== g || !g.admitted || !g.hostKey) return
    guestFile.write(
      sealRecord({
        invite: g.invite,
        name: g.name,
        key: exportSigningKey(g.signingKey),
        hostKey: g.hostKey.toString('base64'),
        url: g.url,
        relaySeq: g.relaySeq || 0,
        shareSecret: g.shareSecret ? g.shareSecret.toString('base64') : null,
        reachedAt: g.reachedAt || Date.now()
      })
    )
  }

  // The host's newest address from the relay (shareRendezvous.js), on the
  // share's topic (its secret came with the welcome) and the code's: taken
  // only when signed with the host's key (pinned by its welcome, or named by
  // a TS2 code; none known: never asked) and newer than the last one taken.
  // true: this guest moved there (connect again). The host stopped sharing:
  // this guest's session ends.
  async function lookUpAddress(g) {
    const hostKey = g.hostKey || g.codeHostKey || null
    if (!relayOn() || !hostKey) return false
    let best = null
    for (const secret of [g.shareSecret, g.secret]) {
      const keys = secret ? rendezvousKeys(secret) : null
      if (!keys) continue
      const texts = await rendezvous.latest(keys.topic)
      if (joined !== g) return false
      const said = newestAddress(texts, { secret, hostKey, after: g.relaySeq || 0, urlOk: relayUrlOk })
      if (said && (!best || said.seq > best.seq)) best = said
    }
    if (!best) return false
    g.relaySeq = best.seq
    if (best.stopped) {
      info('the host stopped sharing (said on the rendezvous relay)')
      endGuest(g, 'stopped')
      return false
    }
    const url = withBase(best.url, g.url)
    if (!url) return false
    const moved = url !== g.url
    g.url = url
    saveGuest(g)
    if (moved) info('the host is at a new address (from the rendezvous relay): connecting there')
    return moved
  }

  // A first join whose code's address did not answer (the host's share came
  // back on a new tunnel since the code was made): the relay asked a few
  // times (FIRST_LOOKUPS) for its newest address; none: it ends as it did.
  function findHostFirst(g, reason) {
    // A TS1 code (no host key in it): its own address only; a new code then.
    if (!g.codeHostKey) return endGuest(g, 'old-code')
    const delay = firstLookups[g.firstLookups++]
    if (g.firstLookups === 1) info('the invite code’s address did not answer: asking the rendezvous relay for the host’s newest one')
    clearTimeout(g.retry && g.retry.timer)
    g.retry = {
      timer: setTimeout(async () => {
        if (joined !== g) return
        const moved = await lookUpAddress(g).catch(() => false)
        if (joined !== g) return
        if (moved) return connectGuest(g)
        if (g.firstLookups >= firstLookups.length) return endGuest(g, reason)
        findHostFirst(g, reason)
      }, delay)
    }
  }

  // A pane whose terminal starts again here (the host restarted it, or the
  // connection came back): its next screen is waited for, and the window
  // opens its terminal anew (gen).
  function resetPane(pane) {
    pane.ready = false
    pane.fresh = false
    pane.attached = false
    pane.screen = ''
    pane.exited = false
    pane.exitCode = null
    pane.gen = (pane.gen || 0) + 1
  }

  // The host's projects this guest sees, each with its layout and its
  // terminals (a pane listed in two projects is the first one's; past
  // GUEST_PANES in all, the rest are not shown).
  function onProjects(g, list) {
    const projects = []
    const seen = new Set()
    const chats = new Map()
    for (const p of (Array.isArray(list) ? list : []).slice(0, MAX_PROJECTS)) {
      if (!p || !isProjectId(p.id) || projects.some((x) => x.id === p.id)) continue
      projects.push({ id: p.id, layout: cleanLayout(p.layout) })
      // Its agent panes with a conversation (a host that shares them).
      if (g.features.has('chat')) {
        for (const c of cleanChatPanes(p.chats, LAYOUT_PANES)) {
          if (chats.size >= GUEST_PANES) break
          if (chats.has(c.id)) continue
          const old = g.chats.get(c.id)
          // Moved to another of its projects: asked again there.
          if (old && old.project !== p.id) g.chatAsked.delete(c.id)
          const kept = old && old.project === p.id
          chats.set(c.id, { ...c, remoteId: c.id, localId: guestPaneId(g.session, c.id), project: p.id, last: kept ? old.last : null, events: kept ? old.events : null })
        }
      }
      for (const x of (Array.isArray(p.panes) ? p.panes : []).slice(0, LAYOUT_PANES)) {
        if (seen.size >= GUEST_PANES) break
        if (!x || typeof x.id !== 'string' || !/^[\w-]{1,80}$/.test(x.id) || seen.has(x.id)) continue
        seen.add(x.id)
        let pane = g.panes.get(x.id)
        if (!pane) {
          // A pane that left and comes back: a new terminal here (its gen goes
          // on from the last one, so an attach still running is redone).
          const gen = g.lastGen.has(x.id) ? g.lastGen.get(x.id) + 1 : 0
          pane = { remoteId: x.id, localId: guestPaneId(g.session, x.id), project: p.id, screen: '', ready: false, fresh: false, attached: false, exited: false, exitCode: null, waiters: [], gen }
          g.panes.set(x.id, pane)
          g.byLocal.set(pane.localId, pane)
        } else if (pane.project !== p.id) {
          // Moved to another of its projects on the host: a new terminal
          // there, with the screen the host sends again.
          resetPane(pane)
          pane.project = p.id
        }
        pane.title = str(x.title)
        pane.kind = x.kind === 'agent' ? 'agent' : 'shell'
        pane.agentId = str(x.agentId, 40) || null
        pane.accent = /^#[0-9a-f]{3,8}$/i.test(x.accent || '') ? x.accent : null
        pane.cols = Math.max(0, Math.min(1000, x.cols | 0))
        pane.rows = Math.max(0, Math.min(500, x.rows | 0))
      }
    }
    // Panes the host closed, no longer shows, or no longer shares with this
    // guest: they end here too.
    for (const [remoteId, pane] of [...g.panes]) {
      if (seen.has(remoteId)) continue
      g.lastGen.set(remoteId, pane.gen || 0)
      g.panes.delete(remoteId)
      g.byLocal.delete(pane.localId)
      for (const w of pane.waiters.splice(0)) w(false)
      if (pane.attached) sendExit(pane.localId, 0)
    }
    g.projects = projects
    // Conversations: the ones that went are forgotten; the ones the window
    // watches and this connection has not asked for yet (back after a
    // reconnect) are asked for.
    for (const id of [...g.chatWanted]) {
      if (chats.has(id)) continue
      g.chatWanted.delete(id)
      g.chatAsked.delete(id)
    }
    g.chats = chats
    g.chatByLocal = new Map([...chats.values()].map((e) => [e.localId, e]))
    // What it follows of a project it no longer sees: let go.
    dropSubsOf(g)
    for (const id of [...g.boards.keys()]) if (!projects.some((p) => p.id === id)) g.boards.delete(id)
    for (const id of [...g.paneAgents.keys()]) if (!projects.some((p) => p.id === id)) g.paneAgents.delete(id)
    // Each project's panes as the host's headers show them: followed for
    // every project (the sidebar and the Dashboard list them all).
    if (g.features.has('panes2')) for (const p of projects) guestSubscribe('agents', p.id, null, true)
    // The host's editor tabs of every project, and its pages as links with
    // the right.
    if (g.features.has('tabs')) for (const p of projects) guestSubscribe('tabs', p.id, null, true)
    syncLinks(g)
    if (g.state === 'joined') {
      for (const id of g.chatWanted) {
        if (g.chatAsked.has(id)) continue
        g.chatAsked.add(id)
        g.client.chat(id, true)
      }
    }
    pushGuest()
  }

  function endGuest(g, reason) {
    if (joined !== g) return
    clearTimeout(g.retry && g.retry.timer)
    clearInterval(guestTimer)
    guestTimer = null
    g.state = 'ended'
    g.reason = reason
    for (const pane of g.panes.values()) for (const w of pane.waiters.splice(0)) w(false)
    guestFile.clear()
    info(`left the session of ${g.host || '?'} (${reason})`)
    pushGuest()
    joined = null
  }

  // The connection dropped: taken up again with the reconnect key, every few
  // seconds, then every 30 s, for as long as this guest stays in the session
  // (a host restarting or rebooting, a PC asleep, a lost network); the Live
  // Share project stays meanwhile. After the second try, the relay is asked
  // for the host's newest address (at most every LOOKUP_DELAYS).
  function reconnectLater(g) {
    if (joined !== g) return
    const r = g.retry || (g.retry = { since: Date.now(), tries: 0, timer: null, lookups: 0, lookupAt: 0 })
    // The host not reached for as long as it keeps a guest offline (it
    // stopped sharing meanwhile, say): over.
    if (Date.now() - (g.reachedAt || r.since) > OFFLINE_KEEP_MS) return endGuest(g, 'lost')
    const delay = r.tries < RECONNECT_DELAYS.length ? RECONNECT_DELAYS[r.tries] : Date.now() - r.since > RECONNECT_SLOW_AFTER_MS ? RECONNECT_SLOW_MS : RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]
    r.tries++
    clearTimeout(r.timer)
    r.timer = setTimeout(async () => {
      if (joined !== g || g.state !== 'reconnecting' || g.retry !== r) return
      if (relayOn() && r.tries >= 2 && Date.now() >= (r.lookupAt || 0)) {
        r.lookupAt = Date.now() + lookupDelays[Math.min(r.lookups++, lookupDelays.length - 1)]
        await lookUpAddress(g).catch(() => false)
        if (joined !== g || g.state !== 'reconnecting' || g.retry !== r) return
      }
      connectGuest(g)
    }, delay)
  }

  function connectGuest(g) {
    // Each connection asks for the conversations the window watches anew.
    g.chatAsked = new Set()
    const client = createShareGuest({
      url: g.url,
      secret: g.secret,
      name: g.name,
      signingKey: g.signingKey,
      identityKey: guestIdentity(),
      back: g.admitted,
      // Coming back: the key of its first welcome; a first join with a TS2
      // code: the share's key the code names.
      hostKey: g.hostKey || g.codeHostKey,
      callbacks: {
        onHostKey: (key) => {
          if (joined === g && g.client === client) g.hostKey = key
        },
        onRendezvous: (secret) => {
          if (joined === g && g.client === client) g.shareSecret = secret
        },
        onState: (state, extra) => {
          if (joined !== g || g.client !== client) return
          if (extra?.host) g.host = cleanName(extra.host)
          if (extra?.code) g.code = str(extra.code, 12)
          // The host answered at this address.
          if (state === 'waiting' || state === 'joined') g.reached = true
          // Back in: every pane's screen comes again.
          if (state === 'joined' && g.admitted) for (const pane of g.panes.values()) resetPane(pane)
          if (state === 'joined') {
            g.admitted = true
            g.retry = null
            g.reason = null
            g.reachedAt = Date.now()
            saveGuest(g)
            // What the window follows on the host, asked again.
            resubscribe(g)
          }
          // While reconnecting, the handshake's steps are not shown.
          if (g.state === 'reconnecting' && state !== 'joined') return
          g.state = state
          // The host's usage, followed with the right (once in: the request
          // goes now).
          if (state === 'joined') {
            syncUsage(g)
            syncLinks(g)
          }
          pushGuest()
        },
        onRights: (rights) => {
          if (joined !== g || g.client !== client || !rights) return
          g.rights = cleanRights(rights)
          if (g.state === 'joined') {
            syncUsage(g)
            syncLinks(g)
          }
          pushGuest()
        },
        onFeatures: (list) => {
          if (joined === g && g.client === client) g.features = new Set(Array.isArray(list) ? list : [])
        },
        onAgents: (list) => {
          if (joined !== g || g.client !== client) return
          g.agents = cleanAgents(list)
          pushGuest()
        },
        // A conversation the window watches, checked again (shareChat.js):
        // what changed since what this guest has, put together here; the
        // window gets all of it.
        onChat: (remoteId, msg) => {
          if (joined !== g || g.client !== client) return
          const entry = g.chats.get(remoteId)
          if (!entry || !g.chatWanted.has(remoteId)) return
          const payload = cleanChatMessage(msg)
          if (!payload) return
          if (payload.ok) {
            const events = mergeChatEvents(entry.events, payload)
            if (!events) {
              // Out of step with the host: all of it again (a few times a
              // minute at most; the view keeps what it shows meanwhile).
              entry.events = null
              const t0 = Date.now()
              entry.resyncs = (entry.resyncs || []).filter((x) => t0 - x < 60000)
              if (entry.resyncs.length < GUEST_RESYNCS_PER_MINUTE) {
                entry.resyncs.push(t0)
                client.resyncChat(remoteId)
              }
              return
            }
            entry.events = events
            // What the chat ignores (an event the host's Tessel knows and
            // this one does not) is kept for the next update, not shown.
            entry.last = { ok: true, events: events.filter((e) => e.type !== 'skip'), truncated: payload.truncated }
          } else {
            entry.events = null
            entry.last = payload
          }
          send('liveShare:chat', { id: entry.localId, ...entry.last })
        },
        onNotice: (code, about = {}) => joined === g && g.client === client && send('liveShare:notice', { code: str(code, 40), agent: cleanName(str(about.agent, 80)), model: cleanName(str(about.model, 80)) }),
        onPush: (topic, project, key, data) => joined === g && g.client === client && onGuestPush(g, topic, project, key, data),
        onProjects: (projects) => joined === g && g.client === client && onProjects(g, projects),
        onSnapshot: (remoteId, data, cols, rows) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.screen = data
          if (cols > 0 && rows > 0) {
            pane.cols = cols
            pane.rows = rows
          }
          pane.ready = true
          pane.fresh = true
          for (const w of pane.waiters.splice(0)) w(true)
        },
        onData: (remoteId, data) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          if (pane.attached) queueData(pane.localId, data)
          else pane.screen = trimBuffer(pane.screen + data, HOST_BUFFER_BYTES)
        },
        onExit: (remoteId, exitCode) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          pane.exited = true
          pane.exitCode = exitCode
          if (pane.attached) sendExit(pane.localId, exitCode)
        },
        onRestart: (remoteId) => {
          if (joined !== g || g.client !== client) return
          const pane = g.panes.get(remoteId)
          if (!pane) return
          resetPane(pane)
          pushGuest()
        },
        onClosed: (reason) => {
          if (joined !== g || g.client !== client) return
          if (!g.leaving && g.admitted && RECONNECT_REASONS.has(reason)) {
            if (g.state !== 'reconnecting') info(`connection to ${g.host || '?'} lost (${reason}): reconnecting`)
            g.state = 'reconnecting'
            g.reason = reason
            pushGuest()
            reconnectLater(g)
            return
          }
          // A first join that never reached the host: it may be elsewhere.
          if (!g.leaving && !g.admitted && !g.reached && relayOn() && DEAD_ADDRESS.has(reason) && g.firstLookups < firstLookups.length) return findHostFirst(g, reason)
          endGuest(g, reason)
        }
      }
    })
    g.client = client
    client.connect()
    // The pane on screen goes again with each connection (said once in).
    if (g.focusRemote) client.focus(g.focusRemote)
  }

  // url, relaySeq: a session taken back after a restart (its last address,
  // the last relay message it took).
  function joinSession({ invite, name, signingKey = null, hostKey = null, url = null, relaySeq = 0, shareSecret = null, reachedAt = null } = {}) {
    const code = decodeInvite(invite)
    if (!code) return { ok: false, error: t('main.liveShare.badInvite', 'This is not a Tessel Live Share invite code.') }
    if (joined) leaveSession('replaced')
    // The address last known: the one a session taken back had (the code's
    // invitation path on it), or the code's.
    const start = typeof url === 'string' && withBase(url, code.url) === url ? url : code.url
    const g = {
      session: ++sessions,
      host: null,
      state: 'connecting',
      panes: new Map(),
      byLocal: new Map(),
      lastGen: new Map(), // pane id -> gen when it left
      projects: [],
      // What the host's Tessel speaks beyond the protocol (shareChat.js), its
      // agent panes with a conversation (remote id -> { localId, project,
      // title, agentId, accent, terminal, last }), the ones the window
      // watches, and those this connection asked the host for.
      features: new Set(),
      agents: [],
      focusRemote: null, // the host pane on screen here (presence)
      chats: new Map(),
      chatByLocal: new Map(),
      chatWanted: new Set(),
      chatAsked: new Set(),
      // What this window follows on the host (shareChannel.js), the project
      // whose files it shows, and the boards that came.
      subs: new Map(),
      watchedRoot: null,
      boards: new Map(),
      // Phase 2b: each project's panes as the host's headers show them (this
      // window's pane ids), and the host's usage (with the right).
      paneAgents: new Map(),
      tabs: new Map(),
      links: new Map(),
      usage: null,
      // Phase 2c: the host's page this window watches ({ local, project,
      // remote }), and the activity that came (project -> { events, teams }).
      page: null,
      activities: new Map(),
      reason: null,
      client: null,
      rights: null,
      code: null,
      url: start,
      secret: code.secret,
      // The share's key a TS2 code names (null: a TS1 code).
      codeHostKey: code.hostKey || null,
      relaySeq: Number.isSafeInteger(relaySeq) && relaySeq > 0 ? relaySeq : 0,
      // The share's rendezvous secret (from the host's welcome), and when the
      // host was last reached.
      shareSecret: Buffer.isBuffer(shareSecret) && shareSecret.length === 32 ? shareSecret : null,
      reachedAt: Number.isFinite(reachedAt) ? reachedAt : null,
      reached: false,
      firstLookups: 0,
      invite: String(invite).trim(),
      name: str(name, 40) || defaultShareName(),
      // This guest's reconnect key: made now, or the one of a session taken
      // back after a restart (as good as admitted: a refused key ends it).
      signingKey: signingKey || newSigningKey(),
      // The host's key (from its first welcome): a returning guest checks the
      // host signs with it.
      hostKey: signingKey ? hostKey : null,
      admitted: !!(signingKey && hostKey),
      leaving: false,
      retry: null
    }
    joined = g
    connectGuest(g)
    clearInterval(guestTimer)
    guestTimer = setInterval(() => saveGuest(g), KEEP_FRESH_MS)
    guestTimer.unref?.()
    pushGuest()
    return { ok: true }
  }

  function leaveSession(reason = 'left') {
    const g = joined
    if (!g) return
    g.leaving = true
    g.reason = reason
    clearTimeout(g.retry && g.retry.timer)
    g.client.leave() // -> onClosed: the window closes the Live Share project
    if (joined === g) endGuest(g, reason)
  }

  // After a restart or a reboot of this Tessel: the session it was in, joined
  // again with its reconnect key (no new question for the host), at its last
  // address.
  function resumeGuest() {
    // Quitting or an update starting meanwhile: kept for the next Tessel.
    if (quitting || suspended) return false
    const raw = guestFile.read()
    const saved = openRecord(raw)
    // Sealed, and the OS can't open it now: kept for a next try.
    if (raw && !saved) return false
    const signingKey = saved && typeof saved.invite === 'string' ? importSigningKey(saved.key) : null
    const hostKey = saved && typeof saved.hostKey === 'string' ? Buffer.from(saved.hostKey, 'base64') : null
    if (!signingKey || !hostKey || hostKey.length !== 32 || joined) {
      if (!joined) guestFile.clear()
      return false
    }
    info('joining again the session left by a restart')
    const shareSecret = typeof saved.shareSecret === 'string' ? Buffer.from(saved.shareSecret, 'base64') : null
    return joinSession({ invite: saved.invite, name: saved.name, signingKey, hostKey, url: typeof saved.url === 'string' ? saved.url : null, relaySeq: saved.relaySeq, shareSecret, reachedAt: saved.reachedAt }).ok
  }

  // Quitting or an update: a session the host let this guest in is kept for
  // the next Tessel (gone without leaving: the host keeps its reconnect
  // key); one not let in yet ends.
  function pauseGuest() {
    const g = joined
    if (g && g.admitted) {
      saveGuest(g)
      clearTimeout(g.retry && g.retry.timer)
      clearInterval(guestTimer)
      g.leaving = true
      joined = null
      g.client.disconnect()
    } else leaveSession('left')
  }

  // --- The window's pty calls for a guest pane ----------------------------
  const isGuestPane = (id) => !!(joined && joined.byLocal.has(id))

  // A pane's terminal opening here: the screen that came for it. One already
  // shown (this window reloaded): the host sends it again (resync).
  async function guestAttach(id) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane) return { ok: false }
    if (pane.ready && !pane.fresh && g.state === 'joined') {
      pane.ready = false
      pane.attached = false
      pane.screen = ''
      g.client.resync(pane.remoteId)
    }
    if (!pane.ready) {
      const ok = await new Promise((resolve) => {
        pane.waiters.push(resolve)
        setTimeout(() => resolve(false), ATTACH_WAIT_MS)
      })
      if (!ok || joined !== g || !g.byLocal.has(id)) return { ok: false }
    }
    const buffer = pane.screen
    pane.screen = ''
    pane.fresh = false
    pane.attached = true
    return {
      ok: true,
      shell: { id: 'liveshare', name: g.host || 'Live Share' },
      backend: 'liveshare',
      pid: null,
      cwd: null,
      exited: pane.exited,
      exitCode: pane.exitCode,
      buffer,
      agentLaunchToken: null,
      remoteHostId: null
    }
  }

  // Typing, opening and closing need the host's yes (the host checks too),
  // and a connection.
  const may = (g, right) => g.state === 'joined' && (!g.rights || g.rights[right])

  function guestWrite(id, data) {
    const pane = joined && joined.byLocal.get(id)
    if (pane && typeof data === 'string' && may(joined, 'type')) joined.client.write(pane.remoteId, data)
  }

  // An image pasted (or dropped) into a host's pane: read here as a checked
  // PNG (the clipboard's, or a file dropped), sent to the host in parts, one
  // image at a time; the host saves it and pastes its path there
  // (sharePaste.js). -> { ok: true } | { ok: false, code }.
  let guestPasting = false
  async function guestPasteImage(id, from = {}) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane || !images) return { ok: false, code: 'not-found' }
    if (!may(g, 'type')) return { ok: false, code: 'forbidden' }
    if (!g.client || !g.client.speaks('paste')) return { ok: false, code: 'outdated' }
    if (guestPasting) return { ok: false, code: 'busy' }
    guestPasting = true
    try {
      let read
      if (from && from.file !== undefined) read = isImageFile(from.file) ? images.fromFile(from.file) : { ok: false, code: 'not-image' }
      else read = images.fromClipboard()
      if (!read.ok) return { ok: false, code: read.code }
      const parts = splitParts(read.png)
      const upload = newUploadId()
      for (let index = 0; index < parts.length; index++) {
        const res = await guestRequest('paste.part', pane.project, { pane: pane.remoteId, upload, index, count: parts.length, data: parts[index] })
        if (!res || res.ok !== true) return { ok: false, code: (res && res.code) || 'failed' }
        if (joined !== g || !g.byLocal.has(id)) return { ok: false, code: 'not-found' }
      }
      const res = await guestRequest('paste.image', pane.project, { pane: pane.remoteId, upload })
      info(`an image pasted in a host's pane: ${res && res.ok ? 'pasted there' : `not pasted (${(res && res.code) || 'failed'})`}`)
      return res && res.ok === true ? { ok: true } : { ok: false, code: (res && res.code) || 'failed' }
    } catch {
      return { ok: false, code: 'offline' }
    } finally {
      guestPasting = false
    }
  }

  // Closing a host's pane here asks the host to close it (for everyone).
  // Once the session ended (or while leaving), it only forgets it.
  function guestKill(id) {
    const g = joined
    const pane = g && g.byLocal.get(id)
    if (!pane) return
    if (may(g, 'close')) g.client.close(pane.remoteId)
  }

  // --- IPC -----------------------------------------------------------------
  ipcMain.handle('liveShare:state', () => ({ host: hostStatus(), guest: guestStatus(), defaultName: defaultShareName() }))
  ipcMain.handle('liveShare:start', (_evt, opts) => startSharing(opts || {}))
  ipcMain.handle('liveShare:stop', () => {
    stopSharing('stopped')
    return { ok: true }
  })
  // What the window shows of the projects shared: [{ id, layout }]. A
  // project shared that is not in it keeps its last layout (a share taken
  // back after a restart waits for the window to find its projects again).
  // Only the projects shared are kept (none while not sharing).
  ipcMain.on('liveShare:layouts', (_evt, list) => {
    const keep = new Set(sharing?.projects || [])
    const next = new Map([...layouts].filter(([id]) => keep.has(id)))
    const nextChats = new Map([...chatSources].filter(([id]) => keep.has(id)))
    const nextRoots = new Map([...roots].filter(([id]) => keep.has(id)))
    const nextTabs = new Map([...hostTabs].filter(([id]) => keep.has(id)))
    for (const item of (Array.isArray(list) ? list : []).filter((x) => x && keep.has(x.id)).slice(0, MAX_PROJECTS)) {
      next.set(item.id, cleanLayout(item.layout))
      nextChats.set(item.id, cleanHostChats(item.chats))
      // Its folder (host-only): a project with none (an SSH project) has no
      // Files or Changes for guests.
      const root = cleanRoot(item.root)
      if (root) nextRoots.set(item.id, root)
      else nextRoots.delete(item.id)
      nextTabs.set(item.id, cleanHostTabs(item.tabs))
    }
    const rootsBefore = roots
    roots = nextRoots
    rootsChanged(rootsBefore)
    const before = sharing ? new Map(homes(sharing)) : new Map()
    const chatsBefore = sharing ? new Map(chatHomes(sharing)) : new Map()
    layouts = next
    chatSources = nextChats
    layoutsRev++
    const after = sharing ? homes(sharing) : new Map()
    const chatsAfter = sharing ? chatHomes(sharing) : new Map()
    // A pane taken out of its project, or moved to another: guests drop it
    // now rather than after the pause (its conversation too).
    if ([...before].some(([id, project]) => after.get(id) !== project) || [...chatsBefore].some(([id, project]) => chatsAfter.get(id) !== project)) changedNow()
    else screenChanged()
    refreshFeeds()
    // The panes guests see may have changed: their copy is made again.
    panesChanged()
    refreshPages()
    // The editor tabs guests get, when they (or the folder) changed.
    const tabsBefore = hostTabs
    hostTabs = nextTabs
    for (const id of keep) if (JSON.stringify(tabsBefore.get(id) || null) !== JSON.stringify(hostTabs.get(id) || null) || rootsBefore.get(id) !== roots.get(id)) refreshTabs(id)
  })
  // The window's browser panes of the shared projects: [{ project, paneId,
  // webContentsId, hidden }] (host-only: guests know a page by its pane).
  ipcMain.on('liveShare:pages', (_evt, list) => {
    pageList = Array.isArray(list) ? list.slice(0, 64) : []
    refreshPages()
  })
  // The activity of the projects guests follow: [{ project, events, teams }].
  // The hidden files named in it go out first (shareHiddenText.js: one git
  // check at most per push); a newer push of the same project wins.
  const activitySeq = new Map() // project -> the latest push's number
  ipcMain.on('liveShare:activity', (_evt, list) => {
    const s = sharing
    if (!s || !s.server) return
    for (const item of (Array.isArray(list) ? list : []).slice(0, MAX_PROJECTS)) {
      if (!item || !(s.projects || []).includes(item.project) || !activityWatched.has(item.project)) continue
      activityRaw.set(item.project, item)
      pushActivity(s, item)
    }
  })
  // One project's activity for guests: masked, its hidden files' names out,
  // pushed when it changed.
  function pushActivity(s, item) {
    const project = item.project
    const data = guestActivity(item.events, item.teams, project, projectRoots(project))
    const seq = (activitySeq.get(project) || 0) + 1
    activitySeq.set(project, seq)
    hiddenMasker(project)(mapActivityTexts(data, (t) => t))
      .then((texts) => {
        if (sharing !== s || !s.server || activitySeq.get(project) !== seq || !activityWatched.has(project)) return
        mapActivityTexts(data, (_t, i) => texts[i])
        const json = JSON.stringify(data)
        if (activities.get(project)?.json === json) return
        activities.set(project, { data, json })
        s.server.push('activity', project, null, data)
      })
      .catch(() => {})
  }
  // A project added to the share or taken out: { id, shared }.
  ipcMain.handle('liveShare:share', (_evt, { id, shared } = {}) => setShared(id, !!shared))
  // The share's settings: { hideIgnored } (kept across shares). A change
  // counts for every request from now on.
  ipcMain.handle('liveShare:setSettings', (_evt, patch = {}) => {
    const keep = writeSettings
    if (patch && typeof patch.hideIgnored === 'boolean' && patch.hideIgnored !== shareSettings.hideIgnored) {
      shareSettings = { ...shareSettings, hideIgnored: patch.hideIgnored }
      keep()
      scope.invalidate()
      info(`guests ${shareSettings.hideIgnored ? 'no longer see' : 'now see'} ignored and secret files`)
      if (shareSettings.hideIgnored) hideNow()
      for (const id of hostTabs.keys()) refreshTabs(id)
      pushHost()
    }
    // The relay: off, nothing more is said there or asked of it; on again,
    // the share's address is said at once.
    if (patch && typeof patch.rendezvous === 'boolean' && patch.rendezvous !== shareSettings.rendezvous) {
      shareSettings = { ...shareSettings, rendezvous: patch.rendezvous }
      keep()
      info(`the rendezvous relay is ${patch.rendezvous ? 'on' : 'off'}`)
      if (!patch.rendezvous) publisher?.forget()
      else if (sharing) publishAddress(sharing, true)
      pushHost()
    }
    // The agents guests may use (a rule, or null: all of them), for whoever
    // has none of its own: guests in follow it at once.
    if (patch && Object.hasOwn(patch, 'agents')) {
      const rule = cleanAgentRule(patch.agents)
      const rest = { ...shareSettings }
      delete rest.agents
      shareSettings = rule ? { ...rest, agents: rule } : rest
      keep()
      info(`guests ${rule ? 'now use only the agents the share allows' : 'may use every agent'}`)
      sharing?.server?.agentRuleChanged()
      // Requests to open waiting for an answer: still allowed?
      if (sharing?.server) checkRequests(sharing.server.guests())
      pushHost()
    }
    return { ok: true, settings: { ...shareSettings } }
  })
  // The window's task boards of the projects shared: [{ project, tasks }].
  // Guests get their copy (shareTasks.js guestTasks) when it changed.
  ipcMain.on('liveShare:tasks', (_evt, list) => {
    const s = sharing
    if (!s || !s.server) return
    const keep = new Set(s.projects || [])
    for (const item of (Array.isArray(list) ? list : []).slice(0, MAX_PROJECTS)) {
      if (!item || !keep.has(item.project)) continue
      // Its cards' own copies, for the review (host-only), and the panes
      // that asked their questions.
      taskCopies.set(item.project, hostTaskCopies(item.tasks))
      const askers = new Map()
      for (const c of Array.isArray(item.tasks) ? item.tasks.slice(0, 2000) : []) if (c && typeof c.id === 'string' && c.gate && typeof c.gate.by === 'string') askers.set(c.id, c.gate.by)
      gateAskers.set(item.project, askers)
      const tasks = guestTasks(item.tasks, projectRoots(item.project))
      const json = JSON.stringify(tasks)
      if (boards.get(item.project)?.json === json) continue
      boards.set(item.project, { tasks, json })
      s.server.push('tasks', item.project, null, { tasks })
    }
    for (const id of [...boards.keys()]) if (!keep.has(id)) boards.delete(id)
    for (const id of [...taskCopies.keys()]) if (!keep.has(id)) taskCopies.delete(id)
    for (const id of [...gateAskers.keys()]) if (!keep.has(id)) gateAskers.delete(id)
  })
  // Phase 2b. The window's panes of the projects shared, as their headers
  // and the Dashboard show them: [{ project, panes }] (sharePanels.js: the
  // guests' copy, at most once a second per project).
  ipcMain.on('liveShare:paneAgents', (_evt, list) => {
    const s = sharing
    if (!s || !s.server) return
    const keep = new Set(s.projects || [])
    for (const item of (Array.isArray(list) ? list : []).slice(0, MAX_PROJECTS)) if (item && keep.has(item.project) && Array.isArray(item.panes)) rawPanes.set(item.project, item.panes)
    for (const id of [...rawPanes.keys()]) if (!keep.has(id)) rawPanes.delete(id)
    const before = paneAgents
    paneAgents = new Map()
    for (const panes of rawPanes.values())
      for (const p of panes.slice(0, 256)) {
        if (!p || typeof p.id !== 'string') continue
        const agent = (p.kind === 'agent' || p.kind === 'chat') && isAgentId(p.agentId) ? p.agentId : null
        const models = agent ? (Array.isArray(p.modelIds) ? p.modelIds : [p.modelId]).filter(isModelId).slice(0, 4) : []
        // (A chat pane has no process of its own: what the window says.)
        const pid = agent && p.kind === 'agent' && Number.isSafeInteger(p.pid) && p.pid > 0 ? p.pid : null
        paneAgents.set(p.id, { agent, models, pid, local: p.local === true })
      }
    // What runs in a pane changed: the guests' safety net.
    for (const [id, e] of paneAgents) {
      const was = before.get(id)
      if (!was || was.agent !== e.agent || was.models.join('\n') !== e.models.join('\n')) s.server.paneChanged(id)
    }
    for (const id of agentsFeed.projects()) {
      if (keep.has(id)) continue
      agentsFeed.drop(id)
      paneChildren.delete(id)
    }
    panesChanged()
  })
  // The window's finished tasks of the projects shared: [{ project, records }]
  // (taskHistory.js records; asked for with 'history.list').
  ipcMain.on('liveShare:history', (_evt, list) => {
    const s = sharing
    if (!s || !s.server) return
    const keep = new Set(s.projects || [])
    for (const item of (Array.isArray(list) ? list : []).slice(0, MAX_PROJECTS)) if (item && keep.has(item.project)) histories.set(item.project, hostHistory(item.records))
    for (const id of [...histories.keys()]) if (!keep.has(id)) histories.delete(id)
  })
  // The window, right before it makes a guest's change of a board: does the
  // request still stand (the guest in, with the right, seeing the project)?
  ipcMain.handle('liveShare:taskCheck', (_evt, request) => {
    const r = typeof request === 'string' ? taskRequests.get(request) : null
    try {
      return { ok: !!r && r.recheck() === true }
    } catch {
      return { ok: false }
    }
  })
  // The window's answer to a guest's change of a board: { request, ok, code }.
  ipcMain.on('liveShare:taskDone', (_evt, { request, ok, code } = {}) => {
    const r = typeof request === 'string' ? taskRequests.get(request) : null
    if (!r) return
    taskRequests.delete(request)
    clearTimeout(r.timer)
    // 'confirm': a card with its own copy, whose delete the host is asked
    // to confirm (its copy and branch go with it); 'busy': another such ask
    // of this guest waits, or the host said no to one lately.
    r.resolve(ok === true ? { ok: true, data: {} } : { ok: false, code: ['not-found', 'not-allowed', 'revoked', 'forbidden', 'bad-args', 'confirm', 'busy'].includes(code) ? code : 'failed' })
  })
  // A guest's image for a host's pane (its local id here): from: { file }
  // for a file dropped, else the clipboard's.
  ipcMain.handle('liveShare:pasteImage', (_evt, id, from) => (typeof id === 'string' ? guestPasteImage(id, from && typeof from === 'object' ? from : {}) : { ok: false, code: 'not-found' }))
  // The window, right before it pastes a guest's image: still asked for (main
  // did not give up on it), the guest still with the right, the pane still shared?
  ipcMain.handle('liveShare:pasteCheck', (_evt, request) => {
    const r = typeof request === 'string' ? pasteRequests.get(request) : null
    try {
      return { ok: !!r && r.recheck() === true }
    } catch {
      return { ok: false }
    }
  })
  // The window's answer to a guest's image paste: { request, ok, code }.
  ipcMain.on('liveShare:pasteDone', (_evt, { request, ok, code } = {}) => {
    const r = typeof request === 'string' ? pasteRequests.get(request) : null
    if (!r) return
    pasteRequests.delete(request)
    clearTimeout(r.timer)
    r.resolve(ok === true ? { ok: true, data: {} } : { ok: false, code: ['not-found', 'forbidden', 'revoked', 'unavailable'].includes(code) ? code : 'failed' })
  })
  // Access, one change at a time, against what the subject has now (two
  // clicks in a row never undo each other): one project or one right of a
  // guest in, a person let in (offline: it comes back with it), a trusted
  // person (also while not sharing) or an invitation.
  ipcMain.handle('liveShare:access', (_evt, args = {}) => {
    const { subject, project, right, on } = args || {}
    const id = subjectId(subject)
    // agents: the agents rule given (null: back to the share's setting).
    const change = Object.hasOwn(args || {}, 'agents') ? { agents: cleanAgentRule(args.agents) } : project !== undefined ? (isProjectId(project) ? { project, on: !!on } : null) : isRightId(right) ? { right, on: !!on } : null
    if (!id || !change) return { ok: false }
    const live = sharing && sharing.state === 'sharing' && sharing.server
    // The trusted entry the change goes to, if any (a trusted person, or a
    // guest or person linked to one).
    const person = live ? sharing.server.personOf(id) : null
    const entry = trust.byId(id) || (person && person.trust ? trust.get(person.trust) : null)
    // Not sharing: only a trusted person can change (its projects: any of
    // this window's).
    const ok = live ? !!sharing.server.change(id, change) : !!entry && trust.change(entry.fp, change)
    if (ok) return { ok: true }
    // A trusted person has a project cap: said as such.
    if (entry && change.project !== undefined && change.on && !entry.grant.projects.includes(change.project) && entry.grant.projects.length >= MAX_TRUSTED_PROJECTS) return { ok: false, reason: 'trust-projects', max: MAX_TRUSTED_PROJECTS }
    return { ok: false }
  })
  // A trusted person renamed (the label the host knows it by).
  ipcMain.handle('liveShare:renameTrusted', (_evt, { id, name } = {}) => {
    const e = trust.byId(subjectId(id))
    return { ok: !!e && trust.rename(e.fp, typeof name === 'string' ? name : '') }
  })
  // Invitations: { label, lifetime, maxUses, projects, later, rights }.
  ipcMain.handle('liveShare:createInvite', (_evt, spec = {}) => withServer((server, s) => {
    const r = server.createInvite(spec)
    return r.ok ? { ok: true, invite: { ...r.invite, code: inviteCode(s, r.invite.id) } } : r
  }))
  // A change of an invitation (patch: what changes), made to its people too
  // as said (applyRemovals: what it no longer gives is taken from them;
  // applyAdditions: what it now gives is given to them).
  ipcMain.handle('liveShare:updateInvite', (_evt, { id, patch, applyRemovals = true, applyAdditions = false } = {}) =>
    withServer((server) => server.updateInvite(subjectId(id), patch && typeof patch === 'object' ? patch : {}, { applyRemovals: applyRemovals !== false, applyAdditions: applyAdditions === true }))
  )
  ipcMain.handle('liveShare:revokeInvite', (_evt, { id, removePeople = false } = {}) => withServer((server) => server.revokeInvite(subjectId(id), { removePeople: removePeople === true })))
  ipcMain.handle('liveShare:rotateInvite', (_evt, { id } = {}) => withServer((server) => server.rotateInvite(subjectId(id))))
  ipcMain.handle('liveShare:duplicateInvite', (_evt, { id } = {}) => withServer((server, s) => {
    const r = server.duplicateInvite(subjectId(id))
    return r.ok ? { ok: true, invite: { ...r.invite, code: inviteCode(s, r.invite.id) } } : r
  }))
  // The host's answer to a guest waiting: the shared projects it gets (the
  // ones listed; none when no list comes), its rights, and whether it is
  // trusted from now on. When it can't be trusted, it is let in untrusted
  // and the answer says why, for the host to see: 'not-trustable' (an older
  // Tessel, without an identity key) or 'trust-full' (the list is full).
  ipcMain.handle('liveShare:approve', (_evt, { guestId, yes, projects, rights, trust: trustIt } = {}) => {
    const ask = asks.get(guestId)
    if (!ask) return { ok: false }
    asks.delete(guestId)
    const wanted = !!yes && trustIt === true
    const why = !wanted ? null : !ask.trustable ? 'not-trustable' : trust.isFull() ? 'trust-full' : null
    ask.resolve(yes ? { yes: true, projects: cleanProjectIds(projects), rights: cleanRights(rights), trust: wanted && !why } : false)
    if (why === 'trust-full') return { ok: true, reason: why, max: MAX_TRUSTED }
    return why ? { ok: true, reason: why } : { ok: true }
  })
  // Trust a guest let in (connected or offline), or stop trusting someone.
  ipcMain.handle('liveShare:trust', (_evt, { guestId } = {}) =>
    withServer((server) => {
      const id = subjectId(guestId)
      const person = server.personOf(id)
      if (person && person.identity && !person.trust && trust.isFull()) return { ok: false, reason: 'trust-full', max: MAX_TRUSTED }
      return { ok: !!server.trust(id) }
    })
  )
  ipcMain.handle('liveShare:untrust', (_evt, { id } = {}) => {
    const tid = subjectId(id)
    if (!isTrustId(tid)) return { ok: false }
    if (sharing && sharing.state === 'sharing' && sharing.server) return withServer((server) => ({ ok: !!server.untrust(tid) }))
    const e = trust.byId(tid)
    return { ok: !!e && trust.remove(e.fp) }
  })
  // A guest removed (connected, or offline: k- id): it can't come back with
  // its reconnect key. A trusted one is no longer trusted either (or it
  // would come back with any invitation), unless untrust is false.
  ipcMain.handle('liveShare:removeGuest', (_evt, { guestId, untrust = true } = {}) =>
    withServer((server) => {
      const id = subjectId(guestId)
      const person = server.personOf(id)
      // (No longer trusted: its people go, connected ones too.)
      if (untrust !== false && person && person.trust) return { ok: !!server.untrust(trustId(person.trust)) }
      return { ok: id.startsWith('k-') ? !!server.removeKnown(id) : !!server.removeGuest(id) }
    })
  )
  // The window is done with a request to open (opened, answered, or let go).
  ipcMain.on('liveShare:requestDone', (_evt, request) => {
    if (typeof request === 'string') hostRequests.delete(request)
  })
  // The agents the window lists for guests (the ones it can start).
  ipcMain.on('liveShare:agents', (_evt, list) => {
    hostAgents = cleanAgents(list)
    sharing?.server?.agentsChanged()
    pushHost()
  })
  ipcMain.handle('liveShare:join', (_evt, opts) => joinSession({ invite: opts && opts.invite, name: opts && opts.name }))
  ipcMain.handle('liveShare:leave', () => {
    leaveSession('left')
    return { ok: true }
  })
  // Guest: a host's agent pane's conversation watched by this window (on) or
  // no longer: read only, nothing reaches the host's pane. -> { ok, last }
  // (the latest that came, or null) | { ok: false, code } ('outdated-host':
  // the host's Tessel does not share conversations).
  ipcMain.handle('liveShare:chatWatch', (_evt, { id, on } = {}) => {
    const g = joined
    if (!g) return { ok: false, code: 'missing' }
    if (!g.features.has('chat')) return { ok: false, code: 'outdated-host' }
    const entry = typeof id === 'string' ? g.chatByLocal.get(id) : null
    if (!entry) return { ok: false, code: 'missing' }
    const rid = entry.remoteId
    if (!on) {
      g.chatWanted.delete(rid)
      if (g.chatAsked.delete(rid) && g.state === 'joined') g.client.chat(rid, false)
      return { ok: true }
    }
    if (!g.chatWanted.has(rid) && g.chatWanted.size >= GUEST_CHATS) return { ok: false, code: 'busy' }
    g.chatWanted.add(rid)
    if (g.state === 'joined' && !g.chatAsked.has(rid)) {
      g.chatAsked.add(rid)
      g.client.chat(rid, true)
    }
    return { ok: true, last: entry.last || null }
  })
  // Guest: a topic of the host's followed by this window (a board) or no
  // longer: { topic, project, on }.
  ipcMain.handle('liveShare:subscribe', (_evt, { topic, project, on } = {}) => {
    if (!WINDOW_TOPICS.has(topic)) return { ok: false }
    // Followed by main itself (every project's panes, the usage with the
    // right): the last news that came.
    if (topic === 'agents' || topic === 'usage' || topic === 'tabs' || topic === 'links') {
      const g = joined
      if (!g || (topic !== 'usage' && !g.projects.some((p) => p.id === project))) return { ok: false }
      const data =
        topic === 'usage'
          ? g.usage
          : topic === 'tabs'
            ? g.tabs.get(project) || null
            : topic === 'links'
              ? g.rights && g.rights.pagesView === true && g.links.get(project)
                ? { pages: g.links.get(project).pages.map(({ remote: _remote, ...rest }) => rest) }
                : null
              : g.paneAgents.has(project)
                ? { panes: g.paneAgents.get(project) }
                : null
      return { ok: true, ...(data ? { data } : {}), outdated: !g.features.has(TOPICS[topic].feature) && g.state === 'joined' }
    }
    if (typeof project !== 'string') return { ok: false }
    const g = joined
    if (!g || (on && !g.projects.some((p) => p.id === project))) return { ok: false }
    const ok = guestSubscribe(topic, project, null, !!on)
    const board = topic === 'tasks' && on ? g.boards.get(project) : null
    const activity = topic === 'activity' && on ? g.activities.get(project) : null
    return { ok, ...(board ? { data: { tasks: board } } : {}), ...(activity ? { data: activity } : {}), outdated: !g.features.has(TOPICS[topic].feature) && g.state === 'joined' }
  })
  // Guest: the host's past conversations of a project and what its terminal
  // agents said ({ op: list | details | terminal, project, args }), checked
  // when they come back. -> { ok, data } | { ok: false, code }
  ipcMain.handle('liveShare:sessions', async (_evt, { op, project, args } = {}) => {
    const g = joined
    if (!g || g.state !== 'joined') return { ok: false, code: 'offline' }
    if (!g.features.has('history')) return { ok: false, code: 'outdated-host' }
    const a = args && typeof args === 'object' ? args : {}
    let name
    let clean
    if (op === 'list') {
      name = 'sessions.list'
      clean = listArgs(a)
    } else if (op === 'details') {
      name = 'sessions.details'
      clean = isRef(a.ref) ? { ref: a.ref } : null
    } else if (op === 'terminal') {
      name = 'sessions.terminal'
      const known = {}
      for (const [id, key] of Object.entries(a.known && typeof a.known === 'object' ? a.known : {}).slice(0, 64)) {
        const remote = typeof id === 'string' ? hostPaneOf(g, id) : null
        if (remote && isRef(key)) known[remote] = key
      }
      clean = { from: Number.isFinite(a.from) && a.from >= 0 ? a.from : 0, known }
    }
    if (!name || !clean || typeof project !== 'string') return { ok: false, code: 'bad-args' }
    let res
    try {
      res = await guestRequest(name, project, clean)
    } catch {
      return { ok: false, code: 'offline' }
    }
    if (!res || !res.ok) return { ok: false, code: (res && typeof res.code === 'string' && res.code.slice(0, 40)) || 'failed' }
    if (op === 'list') {
      const sessions = checkSessionList(res.data)
      return sessions ? { ok: true, sessions, truncated: !!(res.data && res.data.truncated) } : { ok: false, code: 'failed' }
    }
    if (op === 'details') return checkSessionDetails(res.data) || { ok: false, code: 'failed' }
    const local = (remote) => (g.panes.get(remote) || g.chats.get(remote) || {}).localId || null
    const checked = checkTerminal(res.data, local)
    if (!checked) return { ok: false, code: 'failed' }
    // Each pane's name and agent, as this window shows them.
    for (const [id, entry] of Object.entries(checked.panes)) {
      const pane = g.byLocal.get(id) || g.chatByLocal.get(id)
      entry.title = pane ? pane.title || '' : ''
      entry.agentId = pane ? pane.agentId || null : null
    }
    return { ok: true, panes: checked.panes }
  })
  // Guest: one of the host's pages on this window's screen, followed (on), or
  // no longer: its videos come with its link while it is ({ id }: its id
  // here; one page at a time).
  ipcMain.handle('liveShare:pageMedia', (_evt, { id, on } = {}) => {
    const g = joined
    if (!g) return { ok: false }
    for (const sub of [...g.subs.values()]) if (sub.topic === 'media') guestSubscribe('media', sub.project, sub.key, false)
    if (!on) return { ok: true }
    if (!(g.rights && g.rights.pagesView === true) || !g.features.has('links')) return { ok: false }
    for (const [project, got] of g.links) {
      const page = got.pages.find((p) => p.id === id)
      if (page && !page.local) return { ok: guestSubscribe('media', project, page.remote, true) }
    }
    return { ok: false }
  })
  // Guest: a change of a host's board ({ op: add | move | edit | remove |
  // answer, project, args }): the host checks the right, and its window
  // makes it. -> { ok } | { ok: false, code }
  ipcMain.handle('liveShare:task', async (_evt, { op, project, args } = {}) => {
    const name = `tasks.${op}`
    if (!Object.hasOwn(TASK_OPS, name) || typeof project !== 'string') return { ok: false, code: 'bad-args' }
    const clean = taskArgs(name, args)
    if (!clean) return { ok: false, code: 'bad-args' }
    try {
      const res = await guestRequest(name, project, clean)
      return res && res.ok ? { ok: true } : { ok: false, code: (res && typeof res.code === 'string' && res.code.slice(0, 40)) || 'failed' }
    } catch {
      return { ok: false, code: 'offline' }
    }
  })
  // Guest: what the window's panels ask the host (phase 2b: a pane's
  // sub-agents, the project's task history, a task branch's review): { op,
  // project, args } -> the host's answer, checked here (sharePanels.js) |
  // { ok: false, code } ('bad-op': the host's Tessel is too old for it;
  // 'offline'). Pane ids are this window's (the host's never leave here).
  const WINDOW_OPS = {
    'agents.children': {
      args: (g, a) => {
        const local = typeof a.pane === 'string' ? g.byLocal.get(a.pane) || g.chatByLocal.get(a.pane) : null
        return local ? { pane: local.remoteId } : null
      },
      check: (g, d) => {
        const items = checkChildren(d && d.items)
        return items ? { items } : null
      }
    },
    'history.list': {
      args: () => ({}),
      check: (g, d) => {
        const h = checkHistory(d)
        if (!h) return null
        // The pane that did it, when this window shows it.
        for (const r of h.records) r.paneId = r.paneId && g.panes.has(r.paneId) ? g.panes.get(r.paneId).localId : null
        return h
      }
    },
    'review.info': {
      args: (g, a) => (isTaskId(a.task) ? { task: a.task } : null),
      check: (g, d) => checkReviewInfo(d)
    },
    'review.diff': {
      args: (g, a) => (isTaskId(a.task) && typeof a.file === 'string' && a.file && cleanRel(a.file) === a.file ? { task: a.task, file: a.file } : null),
      check: (g, d) => checkReviewDiff(d)
    }
  }
  ipcMain.handle('liveShare:request', async (_evt, { op, project, args } = {}) => {
    const spec = typeof op === 'string' && Object.hasOwn(WINDOW_OPS, op) ? WINDOW_OPS[op] : null
    const g = joined
    if (!spec || !g || typeof project !== 'string') return { ok: false, code: 'bad-args' }
    const clean = spec.args(g, args && typeof args === 'object' ? args : {})
    if (!clean) return { ok: false, code: 'bad-args' }
    let res
    try {
      res = await guestRequest(op, project, clean)
    } catch {
      return { ok: false, code: 'offline' }
    }
    if (!res || res.ok !== true) return { ok: false, code: res && typeof res.code === 'string' && /^[a-z][a-z-]{0,39}$/.test(res.code) ? res.code : 'failed' }
    const data = spec.check(g, res.data)
    return data ? { ok: true, data } : { ok: false, code: 'bad-answer' }
  })
  // A terminal or an agent of the host's (one it lists) opened on the host,
  // in one of its projects this guest sees: at once with the right; without
  // it, a host that can be asked is asked (asked: true).
  ipcMain.handle('liveShare:open', (_evt, spec = {}) => {
    const g = joined
    if (!g || g.state !== 'joined') return { ok: false }
    const canAsk = g.features.has('agents')
    if (!may(g, 'open') && !canAsk) return { ok: false, reason: 'rights' }
    const project = spec && g.projects.some((p) => p.id === spec.project) ? spec.project : null
    if (!project) return { ok: false, reason: 'project' }
    const agent = spec.kind === 'agent' ? spec.agent : null
    // An agent or a model the host's rule leaves out (the host refuses it
    // anyway; said here at once).
    const rule = g.rights ? g.rights.agents : null
    const model = agent !== null && isModelId(spec.model) ? spec.model : null
    if (agent !== null && isAgentId(agent) && !agentAllowed(rule, agent)) return { ok: false, reason: 'agent-denied' }
    if (model && !modelAllowed(rule, agent, model)) return { ok: false, reason: 'model-denied' }
    if (agent !== null && (!isAgentId(agent) || (canAsk && !g.agents.some((a) => a.id === agent)))) return { ok: false, reason: 'agent' }
    g.client.open(agent ? { kind: 'agent', agent, project, ...(model ? { model } : {}) } : { kind: 'terminal', project })
    return { ok: true, asked: !may(g, 'open') }
  })
  // The host's pane this window has on screen (null: none of the host's),
  // for the host's eyes only.
  ipcMain.on('liveShare:focus', (_evt, id) => {
    const g = joined
    if (!g) return
    // Kept while reconnecting too: the next connection says it once in.
    const pane = typeof id === 'string' ? g.byLocal.get(id) || g.chatByLocal.get(id) : null
    g.focusRemote = pane ? pane.remoteId : null
    g.client?.focus(g.focusRemote)
  })

  // A share or a session the last Tessel left (a restart, an update, a
  // crash): taken back, once.
  let resumed = null
  const takeBack = () => {
    if (resumed) return resumed
    resumed = Promise.all([resumeSharing().catch(() => false), Promise.resolve().then(() => resumeGuest()).catch(() => false)])
    return resumed
  }
  if (resume) takeBack()

  return {
    get resumed() {
      return resumed || Promise.resolve([false, false])
    },
    resume: takeBack,
    // Host: every terminal's output, exit and size, as Tessel gets them.
    onPtyData: (id, data) => sharing?.server?.sendData(id, data),
    onPtyExit: (id, exitCode) => sharing?.server?.sendExit(id, exitCode),
    noteSize(id, cols, rows) {
      if (!(cols > 0 && rows > 0)) return
      const old = sizes.get(id)
      if (old && old.cols === cols && old.rows === rows) return
      sizes.set(id, { cols, rows })
      if (sharing?.server && homes(sharing).has(id)) screenChanged()
    },
    // A terminal started under this id (a new pane, or one restarted in
    // place): guests that had it get its new screen.
    paneStarted: (id) => sharing?.server?.paneRestarted(id),
    forgetPane: (id) => sizes.delete(id),
    // Guest: the host's files, editor, notes and changes (index.js sends
    // lshare:// calls here), and its watches.
    guestFs,
    guestWatchRoot,
    guestUnwatchRoots,
    guestWatchFiles,
    // Host: the share's settings, and the channel's ops and topics (the next
    // phases add theirs).
    shareSettings: () => ({ ...shareSettings }),
    addOps,
    addTopic: (topic, fn) => channelTopics.set(topic, fn),
    // Guest panes (the host's, shown here).
    isGuestPane,
    guestAttach,
    guestWrite,
    guestKill,
    // Tessel restarting on purpose (an update): the share and the session
    // carry on with the next Tessel (guests are told to reconnect; the
    // tunnel keeps running); nothing is ended.
    suspend() {
      if (suspended) return
      suspended = true
      pauseSharing({ keepTunnel: true })
      // (A share still being taken back lets go by itself: suspended.)
      pauseGuest()
    },
    // The update did not install after all: this Tessel carries on, and
    // takes the share and the session back at once.
    unsuspend() {
      if (!suspended) return
      suspended = false
      resumeSharing().catch(() => false)
      Promise.resolve()
        .then(() => resumeGuest())
        .catch(() => false)
    },
    // Quitting Tessel (or Windows shutting down): the share and a session
    // the host let this guest in only pause, kept for the next Tessel, which
    // starts them again by itself; the tunnel ends (the next Tessel takes it
    // back if it still runs, or starts a new one). Only Stop sharing and Leave
    // end them for good.
    stopAll() {
      if (suspended) return
      // A share still being taken back lets go (its saved copy kept).
      quitting = true
      stopRun++
      pauseSharing({ keepTunnel: false })
      pauseGuest()
    }
  }
}
