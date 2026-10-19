// Live Share, host side: the share server guests connect to.
//
// It listens on 127.0.0.1 only (the Cloudflare tunnel, shareTunnel.js, is
// what reaches it from outside), and refuses browsers (any Origin header). A
// connection first runs the handshake of shareCrypto.js in clear (the
// guest's commitment, the host's nonce and X25519 key, the guest's), then
// everything is sealed with keys derived from them and an invitation's
// secret: a guest without an invite code is dropped at its first message.
//
// Who may get in, and what each one gets, is the access model's
// (shareAccess.js): invitations, people, trusted people (shareTrust.js). Each
// invitation is reached at an address of its own on the share (/i/<path>,
// part of its invite code: older guests connect to it as they always did),
// so a connection says which invitation it uses before the host's keys, and
// only that invitation's secret is tried. A connection to an address no
// invitation has gets the hello (the address answers as a Tessel Live Share)
// and is closed as expired. A code made before invitations is reached at the
// address itself (a root invitation; every earlier root secret a person
// still needs is tried there).
//
// A new guest with a code still waits until the host says yes (askApproval)
// to that guest (its id, its invitation, and the verification code both
// sides show), which comes with the projects and rights the host gives it
// (the invitation's, ticked in the prompt); the host can remove any guest at
// any time. Only a trusted person gets in without the question: its Tessel
// proves its identity key on the join (shareCrypto.js signIdentity, bound to
// this connection), and the host trusts that key (shareTrust.js), something
// it can only do for a guest it let in itself. An older guest has no identity
// key: it joins as before and can't be trusted. A trusted identity has one
// connection at a time (a new join of it replaces the one it had, as coming
// back does), joins a few times a minute at most, and its counts (what it
// opened, closed, asked) are its identity's: leaving and joining again
// resets nothing. Each invitation lets no new
// guest in once it is revoked, expired, used up (its uses) or blocked: past a
// few connections that got its keys and never got in, whatever their way out
// (someone in the middle could be trying to make the verification codes
// match), it is blocked until the host makes it a new code. After a no (or a
// guest who left or was removed while waiting), that invitation's new
// guests wait a while before they can ask again; the host's own noes, a few
// in a row across two invitations or more, pause every invitation. Each
// invitation has a short waiting line of its own (MAX_WAITING), within a
// longer one in all (MAX_WAITING_ALL), so one code can't fill the host's;
// a guest waits WAITING_MS at most for the host's answer (then it counts
// against its invitation's block, like any connection that never got in);
// handshakes are limited to a few a minute.
//
// A guest let in made a reconnect key of its own (Ed25519) and gave its
// public half when it joined. When its connection drops (its network, its
// Tessel or this one restarting), it comes back by signing the new
// connection's binding with that key, and is in again at once, with its
// grant (and its open / close counts): no new question. Someone in the
// middle can't do that for it: the key never travels, and a signature only
// fits the connection it was made for. A new guest proves it holds its key
// (it signs its first connection too), and a key already known, or a weak
// one, is refused. The host signs every welcome with a key of its own (the
// share's, given to the guest in its first welcome, checked by the code both
// sides compared): a returning guest checks it is the same host. People let
// in survive a restart of this Tessel (accessState(), given back to
// createShareHost), with their counts, and so do the codes they need and each
// invitation's block. A guest who leaves or is removed can't come back with
// its reconnect key; one offline for more than 30 days is forgotten.
//
// The host shares one project or several (projects), and can add or take one
// out at any time. Each guest sees its own of them (its grant): changed at any
// time (change, setGrant: a guest offline too, it comes back with them); a
// project shared later is no one's until the host gives it (an invitation
// that takes projects shared later offers it to new guests), and one taken out
// of the share is no one's any more (a trusted person's stays, seen again
// when shared again). Once in, a guest sees each of its projects as the
// host's screen shows it: its layout (splits, sizes, the active and
// fullscreen pane), and each of its terminals and agents live: the screen as
// it is (no scrollback), then its output as it comes. Nothing of the other
// projects reaches it, and every request it makes is checked against its
// projects at the moment it comes. A guest starts view only: rights
// (src/shared/liveShareRights.js) let it type in those panes, open terminals
// and agents (a few a minute, a dozen in all), and ask to close panes. A
// pane's screen costs the host's terminal host some work: one is taken at a
// time per pane, shared by every guest that needs it then, and a guest comes
// back (a new connection with its key) and asks for screens again only a few
// times a minute. What a guest's terminal answers by itself to a program's
// questions (cursor position, colours...) is never typed in the host's: the
// host's own terminal answers.
//
// Opening: a guest asks for a terminal, or for one of the agents the host
// lists (callbacks.agents: ids only; the host's Tessel picks the shell and
// the command, as when the host opens one), in one of its projects; nothing
// else it sends is kept (no command line, path, argument or variable). With
// the right, it opens (openPane); without it, a guest whose Tessel says so
// (the 'agents' feature) asks the host (askOpen), a couple of times a minute.
// An agent the host does not list is refused.
//
// A guest whose Tessel says so (the 'chat' feature, shareChat.js) can also
// look at an agent pane of its projects as a chat, read only: it asks for
// that pane's conversation ('chat', on), and gets it as the host's Tessel
// reads it (sendChat: one read for every guest watching, at most once a
// second per pane, bounded; each guest only what changed since what it has,
// and nothing more while its connection is behind), until it stops ('chat',
// off), loses the pane or the project, or leaves. Every ask counts against
// its limit, answered or not (past it, "busy" once a minute per pane); a
// guest whose copy no longer lines up asks for all of it again ('chat',
// resync), within a small limit of its own; a stop for a conversation it
// does not watch is ignored. Nothing about it reaches the pane: no typing, no
// mode, no restart. A guest whose Tessel does not say so gets none of it.
//
// Requests and subscriptions (shareChannel.js: the messages; phase 2: the
// host's Files, editor, Changes and Tasks on a guest's screen), for a guest
// whose Tessel speaks their feature ('files', 'scm', 'tasks'): each request
// is checked when it comes (a known op of a feature both sides speak, one of
// the guest's projects still shared, the right the op needs), within the
// guest's budgets (CHANNEL_LIMITS: requests in flight, light, heavy and
// write requests a minute, bytes of large answers a minute, all counted for
// its person so a new connection starts from nowhere), then handed to the
// host's Tessel (callbacks.request) with a recheck() it calls right before a
// change is made. A heavy request (a search, git's status...) runs once per
// project at a time, and the same one asked by several guests runs once.
// Its answer is checked again when it leaves (the project and the right
// still the guest's), and a large one waits while the guest's connection is
// behind (terminal output first). Taking a project or a right away answers
// what was in flight for it as 'revoked' at once (a late result is dropped),
// and ends the subscriptions of a project no longer the guest's; leaving or
// being removed ends all of them. A subscription is to a topic (shareChannel
// TOPICS): the host's Tessel is told when the first guest subscribes and the
// last one leaves (callbacks.watch), and sends the news with push(): to each
// guest subscribed that may still see it, the latest only while its
// connection is behind. A topic whose subscriptions are each guest's own
// stream (perGuest; no topic is one now: the host's pages go to guests as
// links, 'links', never as frames) is told to the host's Tessel for each
// guest (callbacks.watchGuest), which sends to that guest alone, never to a
// subscription that no longer stands.
//
// Presence, for the host's eyes only (presence(), onPresence): which of the
// host's panes each guest has on screen (the 'presence' feature: 'focus',
// checked against its projects, a couple of times a second at most, and it
// gives nothing), which it typed in during the last few seconds (its typing
// as the host takes it), and which conversations it reads.
//
// Tessel itself is reached only through the callbacks below, so this file
// runs (and is tested) without Electron.
import crypto from 'crypto'
import { WebSocketServer } from 'ws'
import { newNonce, newKeyPair, sharedSecret, sessionKeys, createChannel, commitmentMatches, bindingSigned, signBinding, newSigningKey, identitySigned, identityFingerprint, NONCE_BYTES, COMMIT_BYTES, KX_BYTES } from './shareCrypto.js'
import { SHARE_FEATURES, cleanFeatures, CHAT_LIMITS, CHAT_CODES } from './shareChat.js'
import { NO_RIGHTS, cleanRights, sameRights, isRightId } from '../../shared/liveShareRights'
import { cleanReq, cleanId, cleanSub, subKey, parseSubKey, TOPICS, CHANNEL_LIMITS } from './shareChannel.js'
import { MAX_PROJECTS, isProjectId, cleanProjectIds, cleanName, cleanGrant } from './shareGrant.js'
import { createAccess, pathOfUrl, keyHash, personId, isInviteId, INVITE_TTL_MS } from './shareAccess.js'
import { isTrustId, trustId } from './shareTrust.js'

export { NO_RIGHTS, cleanRights, MAX_PROJECTS, isProjectId, cleanProjectIds, cleanName, INVITE_TTL_MS }

// 4: several projects shared, each guest its own (the welcome and the
// updates list projects, not panes). What came after 4 is said as features
// in the sealed join and welcome (shareChat.js SHARE_FEATURES), not as a new
// version: the hello's version must be the same on both sides, and an older
// Tessel ignores features it does not know. Fields added since, each ignored
// by an older Tessel: the join's identity ({ key, sig }: the guest's identity
// key and its proof), the welcome's agents and the 'agents' message (with the
// 'agents' feature), the guest's 'focus' (with 'presence'). 3: the guest
// commits first (shareCrypto.js), proves its reconnect key and the host signs
// its welcome. A Tessel with protocol 1 (no commitment) is told it is out of
// date; one with protocol 2 or 3 reads the hello's version (an older guest:
// its Tessel is out of date; an older host: the host's is).
export const SHARE_PROTOCOL = 4
const MAX_GUESTS = 10
const MAX_WAITING = 2 // guests waiting for the host's answer at once, per invitation
const MAX_WAITING_ALL = 6 // and in all
// How long a guest waits for the host's answer (then it is turned away,
// counted against its invitation's block only).
const WAITING_MS = 4 * 60 * 1000
// Times a trusted identity joins in a minute (each join replaces the
// connection it had).
const TRUSTED_JOINS_PER_MINUTE = 3
const MAX_FRAME = 1024 * 1024 // a guest's message (typing, a paste)
const MAX_WRITE = 256 * 1024
const MAX_BUFFERED = 16 * 1024 * 1024 // a guest this far behind is dropped
const HANDSHAKE_MS = 15000
const COMMIT_MS = 5000 // a connection that says nothing after the hello: gone
// Connections still in their handshake, from one address and in all (they
// never count among the guests).
const HANDSHAKES_PER_ADDRESS = 3
const HANDSHAKES_AT_ONCE = 30
const PING_MS = 25000 // Cloudflare closes a WebSocket idle for 100 s
const FLUSH_MS = 8
// What one guest may ask in a minute, and in all.
const OPENS_PER_MINUTE = 3
const OPENS_IN_ALL = 12
const OPEN_ASKS_PER_MINUTE = 2 // asking the host to open (without the right)
const CLOSES_PER_MINUTE = 6
const RESYNCS_PER_MINUTE = 30 // pane screens asked again (a window reloaded)
// Requests (shareChannel.js): budgets, the per-minute list of each kind in a
// person's counters, a heavy request waiting for its project at most, and
// how often a large answer held back looks again at the guest's connection.
const L = CHANNEL_LIMITS
const RATE_LISTS = { light: 'reqLight', heavy: 'reqHeavy', write: 'reqWrite' }
const HEAVY_WAITING = 16
const BULK_RETRY_MS = 50
const PUSH_RETRY_MS = 250
// The most paths a held 'fs' news keeps when it gathers several (then: null,
// read everything again).
const MAX_PUSH_PATHS = 256
const CODE = /^[a-z][a-z-]{0,39}$/
// What a guest's own stream may send it (none now).
const STREAM_MESSAGES = new Set([])
// The agents the host lists for guests, at most.
const MAX_AGENTS = 32
// Presence: typing in a pane counts for this long; a guest says what it has
// on screen this often at most.
const TYPING_MS = 3000
const FOCUS_PER_MINUTE = 120
// Typing that goes on is said again this often (the host's window lets a
// typing mark not heard of for a while go).
const TYPING_AGAIN_MS = 4000
// Conversations (the 'chat' feature): watched by one guest at once, started
// in a minute, and how often one pane's goes out (the latest when its time
// comes); one bigger than this is not sent.
const MAX_CHATS = 8
const CHATS_PER_MINUTE = 30
// A guest whose copy no longer lines up asks for all of it again: a few a
// minute, apart from its asks.
const CHAT_RESYNCS_PER_MINUTE = 6
const CHAT_EVERY_MS = 1000
const MAX_CHAT_BYTES = CHAT_LIMITS.bytes + 64 * 1024
// A guest's connection this far behind gets no conversation update (its
// terminals come first); the latest goes once it caught up.
const CHAT_BUFFERED = 1024 * 1024
// Times a guest let in comes back in a minute (each time, every pane it sees
// is taken again); past that it is turned away as busy (its Tessel tries
// again a moment later).
const REJOINS_PER_MINUTE = 3
// Connections a minute, from one address and in all (a guest let in comes
// back past an invitation's block, not past these). Addresses: Cloudflare's
// word for the client (IPv6 by its /64); a program on this PC can claim any
// (a known limit: it could connect anyway).
const EXCHANGES_PER_ADDRESS = 20
const EXCHANGES_PER_MINUTE = 200

// An address as counted: IPv6 by its first four groups (one network).
export function addressKey(address) {
  const a = String(address || '').trim().toLowerCase().slice(0, 64)
  if (!a.includes(':') || /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(a)) return a.replace(/^::ffff:/, '')
  const [head, tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const full = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64'
}
// How a connection ends by the host's own doing (not counted above).
const HOST_ENDS = new Set(['stopped', 'restarting', 'denied', 'removed', 'replaced', 'slow'])
// WebSocket close codes a guest reads as a reason (shareGuest.js).
export const CLOSE_EXPIRED = 4001
export const CLOSE_BUSY = 4002
export const CLOSE_OUTDATED = 4003

// An agent id the host lists (its Tessel's ids: claude, codex, opencode...).
export const isAgentId = (id) => typeof id === 'string' && /^[A-Za-z0-9][\w.-]{0,39}$/.test(id)
// The agents the host lists for guests: [{ id, name }], each once, bounded.
export function cleanAgents(list) {
  const out = []
  for (const a of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_AGENTS) break
    if (!a || !isAgentId(a.id) || out.some((x) => x.id === a.id)) continue
    out.push({ id: a.id, name: cleanName(a.name) || a.id })
  }
  return out
}
// What a guest asks to open: a terminal, or an agent by its id, in a
// project. Nothing else it sends is kept.
export function openSpec(spec) {
  if (!spec || typeof spec !== 'object' || !isProjectId(spec.project)) return null
  if (spec.kind === 'terminal') return { kind: 'terminal', project: spec.project }
  if (spec.kind === 'agent' && isAgentId(spec.agent)) return { kind: 'agent', agent: spec.agent, project: spec.project }
  return null
}

// What a terminal sends by itself when a program asks (xterm's reports), not
// what someone types: the cursor position, the terminal's identity and
// version, mode and status reports, colour and window answers, focus in and
// out. A guest's terminal answers too: dropped, the host's answers already.
/* eslint-disable no-control-regex -- terminal escape sequences */
const TERMINAL_REPLIES = [
  /\x1b\[\d+;\d+R/g, // cursor position (also Shift+F3 and the like: not sent)
  /\x1b\[[?>][\d;]*c/g, // device attributes
  /\x1b\[[03]n/g, // status
  /\x1b\[\??[\d;]*\$y/g, // mode reports
  /\x1b\[\?\d*u/g, // keyboard protocol flags
  /\x1b\[\d+;\d+;\d+t/g, // window size reports
  /\x1b\[[IO]/g, // focus in / out
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, // OSC answers (colours)
  /\x1bP[^\x1b]*\x1b\\/g // DCS answers (version, settings)
]
/* eslint-enable no-control-regex */
export function stripTerminalReplies(data) {
  let out = String(data || '')
  for (const re of TERMINAL_REPLIES) out = out.replace(re, '')
  return out
}

// callbacks:
//   projects()             -> the projects shared now, in order: [{ id,
//                             layout (what the host's window shows of it,
//                             sent as is), panes: [{ id, title, kind, cols,
//                             rows }] }]
//   paneProject(id)        -> the shared project a pane is in right now, or
//                             null (optional: projects() otherwise); checked
//                             with the guest's projects for every output,
//                             screen, exit and request, so a pane taken out
//                             of them (closed, moved, its project no longer
//                             shared or no longer the guest's) sends nothing
//                             more at once and takes no request
//   snapshot(id, ready)    -> Promise<{ data, cols, rows } | null>, then live
//                             output comes through sendData (see subscribe);
//                             data may be a Promise of the text
//   write(id, data)
//   openPane(spec, guest)  -> spec: { kind: 'terminal' } | { kind: 'agent',
//                             agent } and project (one of the guest's)
//   askOpen(spec, guest)   -> optional: a guest without the right asks the
//                             host to open that (the host's answer is the
//                             window's)
//   agents()               -> optional: the agents guests may ask for, [{ id,
//                             name }]; without it, no agent is opened
//   closePane(id, guest)
//   askApproval(guest)     -> Promise<boolean | { yes, projects, rights,
//                             trust }>; guest: publicGuest's, with offer
//                             (the invitation's { projects, rights }, the
//                             shared ones); projects: the shared projects
//                             that guest gets (none when not said; a plain
//                             true gives all of them); trust: trust its
//                             identity key from now on
//   onGuests(list)         -> the guests connected changed (offlineGuests()
//                             gives the others let in)
//   onInviteBlocked(id)    -> too many connections stopped after the
//                             handshake: that invitation lets no new guest in
//                             until it gets a new code
//   onKnownChanged()       -> the access model changed (accessState(): to
//                             save, and the host's window)
//   onPresence()           -> optional: presence() changed
//   chatProject(id)        -> the shared project an agent pane a guest can
//                             look at as a chat is in, or null (optional:
//                             projects()' chats otherwise); checked like
//                             paneProject for every conversation sent
//   chatWatch(id, on)      -> optional (without it, no guest gets the 'chat'
//                             feature): the first guest started watching that
//                             pane's conversation (on), or the last one
//                             stopped; its reads go out with sendChat(id, ...)
//   onChatsWatched()       -> optional: who watches which conversation
//                             changed (chatsWatched())
//   opInfo(op)             -> optional (with request): what an op needs and
//                             costs, { right: 'view' | a right id, kind:
//                             'light' | 'heavy' | 'write', bulk } or null for
//                             an op the host does not know (a change needs a
//                             right)
//   request(req, ctx)      -> optional (without it, no guest gets 'files',
//                             'scm' or 'tasks'): Promise<{ ok: true, data } |
//                             { ok: false, code, detail? }>; req: { op,
//                             project, args } as the guest sent them (args
//                             unchecked); ctx: { guest (publicGuest's), rights
//                             (the guest's now), recheck() (true while the
//                             guest still may: called right before a change),
//                             cancelled(), spend('git') (one more git run of
//                             the guest's budget: false when over it),
//                             uses(right) (the answer shows what that right
//                             lets see: it leaves only while the guest still
//                             has it) }
//   watch(topic, project, key, on) -> optional: the first guest subscribed
//                             to that topic (on), or the last one left; its
//                             news go out with push(topic, project, key, data)
//   offers(feature)        -> optional (with request): true for each of phase
//                             2b's features the host offers ('panes2',
//                             'usage', 'history', 'tabs', 'links'); without
//                             it, none
//   watchGuest(topic, project, key, stream, on) -> optional: a guest's
//                             subscription to a perGuest topic started or
//                             ended; stream: { guest (its id), person (its
//                             person's key hash), name, live() (still
//                             subscribed and allowed), behind() (its
//                             connection's bytes waiting), send(type, body)
//                             (to that guest only, while live) }, the same
//                             object on and off
// projects()' items may have chats: [{ id, title, agentId, accent,
// terminal }] (shareChat.js cleanChatPanes), sent only to guests with the
// 'chat' feature.
// secret: a root invitation's (a share of one code, at the address itself);
// with it, a share taken back from before invitations: known (its guests let
// in), knownAt, secrets (its earlier secrets), inviteExpires, guard (its
// block). access: a share taken back (accessState()). trust: the trusted
// people (shareTrust.js; none without it). hostKey: the share's signing key
// (shareCrypto.js newSigningKey). rendezvousSecret: the share's own secret
// for the relay (shareRendezvous.js), given in each signed welcome: where a
// guest let in finds the share's new address after it moved.
export function createShareHost({ secret = null, hostName, callbacks, log = () => {}, now = Date.now, known = [], knownAt = null, secrets = [], inviteExpires = null, guard = null, access: saved = null, trust = null, hostKey = newSigningKey(), rendezvousSecret = null }) {
  const guests = new Map() // id -> guest (a connection)
  let wss = null
  let pingTimer = null
  let nextGuest = 1
  let stopped = false
  let exchanges = [] // times of handshakes: [time, address]
  // A guest let in and connected now (its person's key hash).
  const online = () => new Set([...guests.values()].filter((g) => g.state === 'joined' && g.person).map((g) => g.person.hash))
  // Changes of the access model: guests see what they now get; the host's
  // Tessel saves it and shows it. Grant changes made inside panesChanged wait
  // for it (it sends every guest its projects anyway).
  let holding = 0
  let heldGrants = false
  const access = createAccess({
    now,
    trust,
    log,
    isOnline: (hash) => online().has(hash),
    sharedIds: () => sharedIds(),
    saved,
    legacy: saved ? null : secret ? { secret, expiresAt: Number.isFinite(inviteExpires) ? inviteExpires : undefined, secrets, known, knownAt, guard } : null,
    onChange: (kind) => {
      if (kind === 'grants') {
        if (holding) heldGrants = true
        else refreshGuests()
      }
      knownChanged()
    }
  })
  const knownChanged = () => callbacks.onKnownChanged?.()
  // What this host speaks beyond the protocol version.
  const serves = callbacks.opInfo && callbacks.request
  // Phase 2b's features: only those the host says it offers (callbacks.offers:
  // its usage needs the readings it has, say). Phase 2c's 'history' requests
  // go through the same feature, as do the editor tabs ('tabs') and the pages
  // as links ('links').
  const offered = (f) => (serves && typeof callbacks.offers === 'function' && callbacks.offers(f) === true ? serves : null)
  const FEATURE_NEEDS = { chat: callbacks.chatWatch, agents: callbacks.agents, presence: callbacks.onPresence, files: serves, scm: serves, tasks: serves, panes2: offered('panes2'), usage: offered('usage'), history: offered('history'), tabs: offered('tabs'), links: offered('links') }
  const hostFeatures = SHARE_FEATURES.filter((f) => typeof FEATURE_NEEDS[f] === 'function')
  // Conversations watched: pane id -> Set of guest ids; the last one read
  // (sent at once to a guest that starts watching), and when one last went out.
  const chatWatchers = new Map()
  const chatLast = new Map()
  const chatTimes = new Map() // pane id -> { at, timer }
  let typingTimer = null
  // Requests in flight per person (its key hash): a new connection of the
  // same person shares them. Heavy requests running or waiting (by what they
  // ask), and the last one queued on each project.
  const inFlight = new Map()
  const heavyRuns = new Map()
  const heavyTails = new Map()
  // Subscriptions: name (shareChannel subKey) -> Set of guest ids; the latest
  // news of a topic that keeps it.
  const watchers = new Map()
  const lastPush = new Map()

  const inHandshake = (g) => g.state === 'handshake' || g.state === 'committed' || g.state === 'secured'
  const trustedOf = (g) => (g.person ? access.trustedOf(g.person) : null)
  // Where a guest's counts are kept: its person's, or a trusted one's
  // identity's.
  const countsOf = (g) => access.countersOf(g.person)
  const inviteOfGuest = (g) => {
    if (g.person) return access.viaOf(g.person)
    const inv = g.entry ? access.liveInvite(g.entry) : null
    return inv ? { id: inv.id, label: inv.label } : null
  }
  const publicGuest = (g) => ({
    id: g.id,
    name: g.name,
    state: g.state,
    since: g.since,
    code: g.code,
    rights: { ...g.rights },
    projects: [...g.projects],
    invite: inviteOfGuest(g),
    trusted: !!trustedOf(g),
    // The trusted entry it is (t-...), when it is one.
    trustId: trustedOf(g) ? trustId(trustedOf(g).fp) : null,
    trustable: !!g.identity
  })
  const notifyGuests = () => callbacks.onGuests?.([...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest))

  function send(g, message) {
    if (g.socket.readyState !== 1) return
    if (g.socket.bufferedAmount > MAX_BUFFERED) {
      drop(g, 'slow')
      return
    }
    g.socket.send(g.channel.seal(message))
  }

  function drop(g, reason) {
    if (!guests.has(g.id)) return
    guests.delete(g.id)
    clearTimeout(g.flushTimer)
    clearTimeout(g.waitTimer)
    // Nothing more of its conversations goes out.
    for (const id of [...g.chats.keys()]) unwatchChat(g, id)
    clearTimeout(g.chatHeldTimer)
    // Nor of its requests and subscriptions.
    endChannel(g)
    try {
      if (g.channel && g.socket.readyState === 1) g.socket.send(g.channel.seal({ t: 'bye', reason }))
    } catch {
      /* closing anyway */
    }
    try {
      g.socket.close(1000)
    } catch {
      /* already closed */
    }
    g.resolveApproval?.(false)
    // Past the host's keys, never in, and not turned away by the host's own
    // doing: counted against its invitation (see onInviteBlocked), whatever
    // its way out.
    if (g.keysSent && !g.everJoined && !g.byHost && !HOST_ENDS.has(reason)) stoppedEarly(g)
    // A guest who left or was removed while waiting: that invitation's new
    // guests wait as after a no (asking again and again costs something);
    // other invitations do not. One that waited too long counts against its
    // invitation's block (above), one removed after it was let in pauses no
    // one.
    if (g.state === 'waiting' && (reason === 'left' || reason === 'closed' || reason === 'removed')) denied(g)
    // Left on purpose, or removed: it can't come back. Otherwise: seen now.
    if (g.person && (reason === 'left' || reason === 'removed')) access.removePerson(g.person.hash)
    else if (g.person && g.everJoined && access.person(g.person.hash)) {
      g.person.lastSeen = now()
      knownChanged()
    }
    if (g.focus || g.typed.size) presenceChanged()
    if (!inHandshake(g)) log(`guest ${g.name || '?'} left (${reason})`)
    notifyGuests()
  }

  function stoppedEarly(g) {
    if (!g.guardId || !access.noteUnfinished(g.guardId)) return
    callbacks.onInviteBlocked?.(g.guardId)
    dropNotJoined('expired')
  }
  // A no for its invitation (byHost: the host's own, which may pause every
  // invitation, shareAccess.js noteDenied).
  const denied = (g, byHost = false) => g.guardId && access.noteDenied(g.guardId, { byHost })
  // Guests waiting longer than WAITING_MS: turned away.
  function expireWaiting() {
    for (const g of [...guests.values()]) if (g.state === 'waiting' && now() - g.waitingSince >= WAITING_MS) drop(g, 'timeout')
  }

  // Output waiting for a guest; a pane whose screen is still being prepared
  // (held) keeps its output until that screen went out first.
  function flush(g) {
    clearTimeout(g.flushTimer)
    g.flushTimer = null
    if (!guests.has(g.id)) return
    for (const [id, data] of [...g.pending]) {
      const sub = g.subscribed.get(id)
      if (sub && sub.held) continue
      g.pending.delete(id)
      if (live(g, id, sub)) send(g, { t: 'data', id, data })
      else forget(g, id)
    }
  }

  // The projects shared now (their ids), and the one a pane is in.
  function sharedIds() {
    return new Set(callbacks.projects().map((p) => p.id))
  }
  function paneProject(id) {
    if (callbacks.paneProject) return callbacks.paneProject(id) || null
    const p = callbacks.projects().find((x) => x.panes.some((pane) => pane.id === id))
    return p ? p.id : null
  }
  // A guest may see a pane now: it is in a shared project of that guest's.
  const canSee = (g, id) => {
    const project = paneProject(id)
    return !!project && g.projects.has(project)
  }
  // A subscription still good: its pane still in the project it was taken
  // in, that project still shared and the guest's (a pane that moved to
  // another project is taken again: its screen first).
  const live = (g, id, sub) => {
    const project = paneProject(id)
    return !!sub && !!project && sub.project === project && g.projects.has(project)
  }

  // A pane no longer shared: what was waiting for it goes, and its screen
  // is taken again if it comes back (a new subscription: what the old one
  // still had coming is ignored).
  function forget(g, id) {
    g.subscribed.delete(id)
    g.pending.delete(id)
  }

  // --- Conversations (the 'chat' feature) ---------------------------------
  const chatsOf = (p) => (Array.isArray(p && p.chats) ? p.chats : [])
  function chatProject(id) {
    if (callbacks.chatProject) return callbacks.chatProject(id) || null
    const p = callbacks.projects().find((x) => chatsOf(x).some((c) => c.id === id))
    return p ? p.id : null
  }
  const speaksChat = (g) => g.features.has('chat')
  const speaksAgents = (g) => g.features.has('agents')
  // Still good: the pane in the project it was asked in, that project still
  // shared and the guest's.
  const chatLive = (g, id) => {
    const project = chatProject(id)
    return speaksChat(g) && !!project && g.chats.get(id) === project && g.projects.has(project)
  }
  const watchedChanged = () => {
    try {
      callbacks.onChatsWatched?.()
    } catch {
      /* only a display */
    }
  }
  function watchChat(g, id, project) {
    g.chats.set(id, project)
    g.chatSent.delete(id)
    let watchers = chatWatchers.get(id)
    const first = !watchers
    if (!watchers) chatWatchers.set(id, (watchers = new Set()))
    watchers.add(g.id)
    watchedChanged()
    presenceChanged()
    if (first) {
      try {
        callbacks.chatWatch(id, true)
      } catch {
        /* the host's reading going wrong never ends the guest */
      }
      return
    }
    const last = chatLast.get(id)
    if (last) sendChatTo(g, id, last)
  }
  function unwatchChat(g, id) {
    g.chats.delete(id)
    g.chatSent.delete(id)
    g.chatHeld.delete(id)
    const watchers = chatWatchers.get(id)
    // Only a guest that watched it changes anything.
    if (!watchers || !watchers.delete(g.id)) return
    presenceChanged()
    if (watchers.size) return watchedChanged()
    chatWatchers.delete(id)
    chatLast.delete(id)
    clearTimeout(chatTimes.get(id)?.timer)
    chatTimes.delete(id)
    watchedChanged()
    try {
      callbacks.chatWatch(id, false)
    } catch {
      /* gone anyway */
    }
  }
  // What a host's Tessel sends of a conversation: { ok: true, events,
  // truncated } or { ok: false, code } (shareChat.js), checked again here,
  // with a fingerprint of each event (what a guest already has is not sent
  // again).
  function chatMessage(payload) {
    if (!payload || typeof payload !== 'object') return null
    if (payload.ok !== true) return { ok: false, code: CHAT_CODES.includes(payload.code) ? payload.code : 'error' }
    if (!Array.isArray(payload.events)) return null
    const events = payload.events.slice(-CHAT_LIMITS.events)
    const marks = []
    let size = 0
    try {
      for (const ev of events) {
        const text = JSON.stringify(ev)
        size += Buffer.byteLength(text, 'utf8') + 1
        marks.push(crypto.createHash('sha1').update(text).digest('base64'))
      }
    } catch {
      return { ok: false, code: 'error' }
    }
    return size > MAX_CHAT_BYTES ? { ok: false, code: 'unavailable' } : { ok: true, events, truncated: !!payload.truncated, marks }
  }
  // How a guest's copy (had: the fingerprints of the events it has) becomes
  // the new one: its `dropped` oldest go (the window moved on), the first
  // `from` of the rest stay, then the new ones; `total` in the end.
  function chatDelta(had, marks) {
    let dropped = had.length
    let from = 0
    const start = marks.length ? had.indexOf(marks[0]) : -1
    if (start >= 0) {
      dropped = start
      const n = Math.min(had.length - start, marks.length)
      while (from < n && had[start + from] === marks[from]) from++
    }
    return { dropped, from, total: marks.length }
  }
  // A conversation to one guest: what changed since what it has (chatDelta),
  // nothing when nothing did; held while its connection is far behind.
  function sendChatTo(g, id, message) {
    if (g.socket.bufferedAmount > CHAT_BUFFERED) {
      g.chatHeld.add(id)
      if (!g.chatHeldTimer) g.chatHeldTimer = setTimeout(() => sendHeld(g), CHAT_EVERY_MS)
      return
    }
    g.chatHeld.delete(id)
    if (!message.ok) {
      g.chatSent.delete(id)
      send(g, { t: 'chat', id, ok: false, code: message.code })
      return
    }
    const had = g.chatSent.get(id)
    const delta = had ? chatDelta(had.marks, message.marks) : { dropped: 0, from: 0, total: message.marks.length }
    if (had && delta.dropped === 0 && delta.from === had.marks.length && delta.from === delta.total && had.truncated === message.truncated) return
    g.chatSent.set(id, { marks: message.marks, truncated: message.truncated })
    send(g, { t: 'chat', id, ok: true, dropped: delta.dropped, from: delta.from, events: message.events.slice(delta.from), total: delta.total, truncated: message.truncated })
  }
  // Held conversations, once the guest's connection caught up: the latest.
  function sendHeld(g) {
    g.chatHeldTimer = null
    if (!guests.has(g.id)) return
    for (const id of [...g.chatHeld]) {
      if (g.socket.bufferedAmount > CHAT_BUFFERED) break
      g.chatHeld.delete(id)
      const message = chatLast.get(id)
      if (message && g.state === 'joined' && chatLive(g, id)) sendChatTo(g, id, message)
    }
    if (g.chatHeld.size && !g.chatHeldTimer) g.chatHeldTimer = setTimeout(() => sendHeld(g), CHAT_EVERY_MS)
  }
  // The latest of a pane's conversation, to every guest watching it that may
  // still see it.
  function flushChat(id) {
    const message = chatLast.get(id)
    const watchers = chatWatchers.get(id)
    if (!message || !watchers) return
    chatTimes.set(id, { at: Date.now(), timer: null })
    for (const gid of watchers) {
      const g = guests.get(gid)
      if (g && g.state === 'joined' && chatLive(g, id)) sendChatTo(g, id, message)
    }
  }

  // --- Requests and subscriptions (shareChannel.js) ------------------------
  // What an op needs and costs, from the host's Tessel, checked: a change
  // always needs a right.
  function opInfoOf(op) {
    let info
    try {
      info = callbacks.opInfo(op)
    } catch {
      info = null
    }
    if (!info || typeof info !== 'object') return null
    const right = info.right === 'view' || isRightId(info.right) ? info.right : null
    const kind = Object.hasOwn(RATE_LISTS, info.kind) ? info.kind : null
    if (!right || !kind || (kind === 'write' && right === 'view')) return null
    return { right, kind, bulk: info.bulk === true }
  }
  // A guest may still have what it asked for: connected and in, the project
  // one of its own and still shared, the right still on. Asked of the access
  // model itself (not what the connection last heard).
  function stillMay(g, project, right) {
    if (guests.get(g.id) !== g || g.state !== 'joined' || !g.person || !access.person(g.person.hash)) return false
    const e = access.effective(g.person)
    return e.projects.has(project) && sharedIds().has(project) && (right === 'view' || e.rights[right] === true)
  }
  // A host-wide right (the usage right: the host's usage, whatever the
  // project): connected and in, the right still on.
  function stillMayAll(g, right) {
    if (guests.get(g.id) !== g || g.state !== 'joined' || !g.person || !access.person(g.person.hash)) return false
    return access.effective(g.person).rights[right] === true
  }
  // A change still holds every right it was asked with (the type right, say,
  // that lets it write a file which runs things: shareScope.js).
  function keepsRights(g, rights) {
    const now = access.effective(g.person).rights
    return Object.keys(rights).every((r) => rights[r] !== true || now[r] === true)
  }
  // A request still allowed (a change: with all the rights it was asked
  // with; an answer that shows what a right lets see, like the costs in
  // dollars of the task history: with that right, ctx.uses).
  const reqAllowed = (g, entry) => stillMay(g, entry.project, entry.right) && (entry.kind !== 'write' || keepsRights(g, entry.rights)) && entry.also.every((r) => stillMay(g, entry.project, r))
  // A request still stands: not called off, still waited for, still allowed.
  const stands = (g, entry) => !entry.cancelled && g.reqs.get(entry.id) === entry && reqAllowed(g, entry)
  const failRes = (id, code) => ({ t: 'res', id, ok: false, code })
  function busyMore(g, n) {
    const hash = g.person.hash
    const v = (inFlight.get(hash) || 0) + n
    if (v > 0) inFlight.set(hash, v)
    else inFlight.delete(hash)
  }

  function onRequest(g, msg) {
    const req = cleanReq(msg)
    // Not a request, a feature its Tessel did not say, an id it waits for
    // already: nothing (its Tessel never sends those).
    if (!req || !g.features.has(req.feature) || g.reqs.has(req.id)) return
    const info = opInfoOf(req.op)
    if (!info) return send(g, failRes(req.id, 'bad-op'))
    if (!g.projects.has(req.project) || !stillMay(g, req.project, 'view')) return send(g, failRes(req.id, 'no-project'))
    if (!stillMay(g, req.project, info.right)) return send(g, failRes(req.id, 'forbidden'))
    // Its budgets: in flight, then a minute's worth of its kind.
    if ((inFlight.get(g.person.hash) || 0) >= L.inFlight || !within(countsOf(g), RATE_LISTS[info.kind], L[info.kind])) return send(g, failRes(req.id, 'busy'))
    const rights = { ...access.effective(g.person).rights }
    const entry = { id: req.id, op: req.op, project: req.project, right: info.right, kind: info.kind, bulk: info.bulk, rights, also: [], cancelled: false, message: null, size: 0 }
    // The rights the answer shows what they let see (ctx.uses), for every
    // request sharing this run (a heavy one asked again while it runs).
    const shared = { uses: new Set() }
    const ctx = {
      guest: publicGuest(g),
      rights: { ...rights },
      recheck: () => stands(g, entry),
      cancelled: () => entry.cancelled || g.reqs.get(entry.id) !== entry,
      // The git work the request causes by itself: within the person's
      // budget (false: over it, the request answers busy).
      spend: (kind) => kind === 'git' && within(countsOf(g), 'reqGit', L.git),
      // The answer shows what this right lets see: it leaves only while the
      // guest still has it (else 'revoked': asked again, it comes without).
      uses: (right) => {
        if (!isRightId(right)) return
        shared.uses.add(right)
        if (!entry.also.includes(right)) entry.also.push(right)
      }
    }
    const call = () => callbacks.request({ op: req.op, project: req.project, args: req.args }, ctx)
    const run = info.kind === 'heavy' ? heavy(req, ctx, call, shared) : { promise: Promise.resolve().then(call), shared }
    if (!run) return send(g, failRes(req.id, 'busy'))
    g.reqs.set(req.id, entry)
    busyMore(g, 1)
    const done = (result) => {
      for (const r of run.shared.uses) if (!entry.also.includes(r)) entry.also.push(r)
      finish(g, entry, result)
    }
    run.promise.then(done, () => done({ ok: false, code: 'failed' }))
  }

  // A heavy request: one at a time per project, and the same one (the same
  // op, project, arguments and rights) asked again while it waits or runs
  // shares its answer (and what it shows: shared.uses). -> { promise,
  // shared } | null when too many wait on that project.
  function heavy(req, ctx, call, shared) {
    let key
    try {
      key = JSON.stringify([req.op, req.project, req.args, ctx.rights])
    } catch {
      return null
    }
    const same = heavyRuns.get(key)
    if (same) return same
    const waiting = [...heavyRuns.values()].filter((r) => r.project === req.project).length
    if (waiting >= HEAVY_WAITING) return null
    const prev = heavyTails.get(req.project) || Promise.resolve()
    const promise = prev.then(call, call)
    const tail = promise.then(
      () => {},
      () => {}
    )
    heavyTails.set(req.project, tail)
    const run = { promise, project: req.project, shared }
    heavyRuns.set(key, run)
    tail.then(() => {
      heavyRuns.delete(key)
      if (heavyTails.get(req.project) === tail) heavyTails.delete(req.project)
    })
    return run
  }

  // The host's answer, as it leaves: still asked for, the project and the
  // right still the guest's (else 'revoked'), a plain shape, bounded; a
  // large one waits while the connection is behind.
  function finish(g, entry, result) {
    busyMore(g, -1)
    if (g.reqs.get(entry.id) !== entry || entry.cancelled) return
    if (!stands(g, entry)) {
      g.reqs.delete(entry.id)
      entry.cancelled = true
      return send(g, failRes(entry.id, 'revoked'))
    }
    let message
    if (result && typeof result === 'object' && result.ok === true) message = { t: 'res', id: entry.id, ok: true, data: result.data === undefined ? null : result.data }
    else {
      const code = result && typeof result.code === 'string' && CODE.test(result.code) ? result.code : 'failed'
      message = typeof result?.detail === 'string' && result.detail ? { ...failRes(entry.id, code), detail: result.detail.slice(0, 300) } : failRes(entry.id, code)
    }
    let size
    try {
      size = Buffer.byteLength(JSON.stringify(message), 'utf8')
    } catch {
      message = failRes(entry.id, 'failed')
      size = 0
    }
    if (size > L.answerBytes) message = failRes(entry.id, 'too-large')
    if (!entry.bulk || !message.ok) {
      g.reqs.delete(entry.id)
      return send(g, message)
    }
    entry.message = message
    entry.size = size
    // Behind with its waiting line full: told to ask again later.
    if (g.bulk.length >= L.bulkQueue && g.socket.bufferedAmount > L.bulkBuffered) {
      g.reqs.delete(entry.id)
      return send(g, failRes(entry.id, 'busy'))
    }
    g.bulk.push(entry)
    sendBulk(g)
  }
  // Large answers waiting, in order, once the connection caught up and
  // within the person's bytes a minute (past them: 'busy').
  function sendBulk(g) {
    clearTimeout(g.bulkTimer)
    g.bulkTimer = null
    while (g.bulk.length && guests.get(g.id) === g) {
      const entry = g.bulk[0]
      if (g.reqs.get(entry.id) !== entry || entry.cancelled) {
        g.bulk.shift()
        continue
      }
      if (!stands(g, entry)) {
        g.bulk.shift()
        g.reqs.delete(entry.id)
        entry.cancelled = true
        send(g, failRes(entry.id, 'revoked'))
        continue
      }
      if (g.socket.bufferedAmount > L.bulkBuffered) {
        g.bulkTimer = setTimeout(() => sendBulk(g), BULK_RETRY_MS)
        g.bulkTimer.unref?.()
        return
      }
      g.bulk.shift()
      g.reqs.delete(entry.id)
      const counts = countsOf(g)
      const t = now()
      const recent = (Array.isArray(counts.bulkBytes) ? counts.bulkBytes : []).filter((x) => Array.isArray(x) && t - x[0] < 60000)
      const used = recent.reduce((sum, x) => sum + x[1], 0)
      counts.bulkBytes = recent
      if (used + entry.size > L.bulkBytes) {
        send(g, failRes(entry.id, 'busy'))
        continue
      }
      recent.push([t, entry.size])
      send(g, entry.message)
    }
  }
  // The guest stopped waiting for one: its answer is not sent (a change not
  // started is not made: recheck() says no).
  function onCancel(g, msg) {
    const id = cleanId(msg.id)
    const entry = id ? g.reqs.get(id) : null
    if (!entry) return
    entry.cancelled = true
    g.reqs.delete(id)
  }

  function onSub(g, msg) {
    const s = cleanSub(msg)
    if (!s || !g.features.has(s.spec.feature)) return
    if (!within(countsOf(g), 'subChanges', L.subsPerMinute)) return
    const k = subKey(s.topic, s.project, s.key)
    if (!s.on) return unsubscribe(g, k)
    if (g.subs.has(k)) return
    if (s.project && !(g.projects.has(s.project) && stillMay(g, s.project, s.spec.right || 'view'))) return
    if (!s.project && s.spec.right && !stillMayAll(g, s.spec.right)) return
    if (g.subs.size >= L.subs || [...g.subs.values()].filter((x) => x.topic === s.topic).length >= s.spec.max) return
    g.subs.set(k, { topic: s.topic, project: s.project, key: s.key, seq: 0 })
    // Its own stream: the host's Tessel hears this guest's subscription.
    if (s.spec.perGuest) return streamWatch(g, k, true)
    let set = watchers.get(k)
    const first = !set
    if (!set) watchers.set(k, (set = new Set()))
    set.add(g.id)
    if (first) {
      try {
        callbacks.watch?.(s.topic, s.project, s.key, true)
      } catch {
        /* the host's watch going wrong never ends the guest */
      }
      return
    }
    if (lastPush.has(k)) pushTo(g, k, lastPush.get(k))
  }
  function unsubscribe(g, k) {
    const sub = g.subs.get(k)
    if (sub && sub.stream) streamWatch(g, k, false)
    if (!g.subs.delete(k)) return
    if (sub && sub.stream) return
    g.pushHeld.delete(k)
    const set = watchers.get(k)
    if (!set || !set.delete(g.id) || set.size) return
    watchers.delete(k)
    lastPush.delete(k)
    const { topic, project, key } = parseSubKey(k)
    try {
      callbacks.watch?.(topic, project, key, false)
    } catch {
      /* gone anyway */
    }
  }
  // A subscription still good: its feature, its project still the guest's
  // and shared, its right (a host-wide topic's: the person's).
  const subLive = (g, sub) => {
    const spec = Object.hasOwn(TOPICS, sub.topic) ? TOPICS[sub.topic] : null
    if (!spec || !g.features.has(spec.feature)) return false
    if (!sub.project) return !spec.right || stillMayAll(g, spec.right)
    return g.projects.has(sub.project) && stillMay(g, sub.project, spec.right || 'view')
  }
  // A guest's own stream of a perGuest topic (a page it watches): the host's
  // Tessel hears it start and end, and sends to this guest alone while the
  // subscription stands (its project and right still the guest's).
  function streamWatch(g, k, on) {
    const sub = g.subs.get(k)
    if (!sub) return
    if (on && !sub.stream) {
      const live = () => guests.get(g.id) === g && g.state === 'joined' && g.subs.get(k) === sub && subLive(g, sub)
      sub.stream = {
        guest: g.id,
        person: g.person ? g.person.hash : g.id,
        name: g.name || '',
        live,
        behind: () => g.socket.bufferedAmount,
        send: (type, body) => {
          if (!STREAM_MESSAGES.has(type) || !live()) return false
          send(g, { ...(body && typeof body === 'object' ? body : {}), t: type, project: sub.project, page: sub.key })
          return true
        }
      }
    }
    if (!sub.stream) return
    try {
      callbacks.watchGuest?.(sub.topic, sub.project, sub.key, sub.stream, on)
    } catch {
      /* the host's watch going wrong never ends the guest */
    }
  }

  // News of one subscription to one guest: the latest only while its
  // connection is behind ('fs' news gather their paths).
  function pushTo(g, k, data) {
    const sub = g.subs.get(k)
    if (!sub) return
    if (g.socket.bufferedAmount > L.pushBuffered || g.pushHeld.has(k)) {
      const held = g.pushHeld.get(k)
      g.pushHeld.set(k, held !== undefined && sub.topic === 'fs' ? mergePaths(held, data) : data)
      if (!g.pushTimer) {
        g.pushTimer = setTimeout(() => sendHeldPushes(g), PUSH_RETRY_MS)
        g.pushTimer.unref?.()
      }
      return
    }
    send(g, { t: 'push', topic: sub.topic, ...(sub.project ? { project: sub.project } : {}), ...(sub.key ? { key: sub.key } : {}), seq: ++sub.seq, data })
  }
  function mergePaths(a, b) {
    const pa = a && Array.isArray(a.paths) ? a.paths : null
    const pb = b && Array.isArray(b.paths) ? b.paths : null
    if (!pa || !pb) return { paths: null }
    const all = [...new Set([...pa, ...pb])]
    return { paths: all.length > MAX_PUSH_PATHS ? null : all }
  }
  function sendHeldPushes(g) {
    g.pushTimer = null
    if (guests.get(g.id) !== g) return
    if (g.socket.bufferedAmount > L.pushBuffered) {
      g.pushTimer = setTimeout(() => sendHeldPushes(g), PUSH_RETRY_MS)
      g.pushTimer.unref?.()
      return
    }
    const held = [...g.pushHeld]
    g.pushHeld.clear()
    for (const [k, data] of held) {
      const sub = g.subs.get(k)
      if (sub && g.state === 'joined' && subLive(g, sub)) pushTo(g, k, data)
    }
  }
  // What a guest no longer may: its requests about a project or a right it
  // lost are answered 'revoked' now (their late results dropped), and its
  // subscriptions to a project it lost end.
  function revalidate(g) {
    for (const entry of [...g.reqs.values()]) {
      if (reqAllowed(g, entry)) continue
      entry.cancelled = true
      g.reqs.delete(entry.id)
      send(g, failRes(entry.id, 'revoked'))
    }
    for (const [k, sub] of [...g.subs]) if (!subLive(g, sub)) unsubscribe(g, k)
  }
  // A connection that ends: nothing more of its requests or subscriptions.
  function endChannel(g) {
    for (const entry of g.reqs.values()) entry.cancelled = true
    g.reqs.clear()
    g.bulk.length = 0
    clearTimeout(g.bulkTimer)
    clearTimeout(g.pushTimer)
    g.pushHeld.clear()
    for (const k of [...g.subs.keys()]) unsubscribe(g, k)
  }

  // --- Presence (for the host's eyes only) ------------------------------------
  function presenceChanged() {
    try {
      callbacks.onPresence?.()
    } catch {
      /* only a display */
    }
  }
  // Each pane a guest has on screen, typed in lately, or reads as a chat,
  // checked against its projects now: [{ id (pane), guests: [{ id, watching,
  // typing, reading }] }].
  function presence() {
    const t = now()
    const panes = new Map()
    const at = (id, gid) => {
      if (!panes.has(id)) panes.set(id, new Map())
      const m = panes.get(id)
      if (!m.has(gid)) m.set(gid, { id: gid, watching: false, typing: false, reading: false })
      return m.get(gid)
    }
    for (const g of guests.values()) {
      if (g.state !== 'joined') continue
      if (g.focus && canSee(g, g.focus)) at(g.focus, g.id).watching = true
      for (const [id, when] of g.typed) if (t - when < TYPING_MS && canSee(g, id)) at(id, g.id).typing = true
      for (const id of g.chats.keys()) if (chatLive(g, id)) at(id, g.id).reading = true
    }
    return [...panes].map(([id, m]) => ({ id, guests: [...m.values()] }))
  }
  // Typing seen: said when it starts, again every TYPING_AGAIN_MS while it
  // goes on, and once more when it is over.
  function typed(g, id) {
    const t = now()
    const was = g.typed.get(id)
    g.typed.set(id, t)
    if (g.typed.size > 64) g.typed.delete(g.typed.keys().next().value)
    if (!was || t - was >= TYPING_MS || t - (g.typedSaid.get(id) || 0) >= TYPING_AGAIN_MS) {
      g.typedSaid.set(id, t)
      if (g.typedSaid.size > 64) g.typedSaid.delete(g.typedSaid.keys().next().value)
      presenceChanged()
    }
    clearTimeout(typingTimer)
    typingTimer = setTimeout(presenceChanged, TYPING_MS + 50)
    typingTimer.unref?.()
  }

  // A pane's screen, then its output from there on. Output that came before
  // the snapshot is in it and is not sent again; output after it is. The
  // terminal host holds new output while it takes the snapshot, and its
  // answer and the output after it can arrive in one read: so the caller
  // calls ready(snapshot) the moment the answer is read (before that output
  // is passed on), or resolves snapshot()'s promise when order can't matter.
  // The screen's text can take a moment more (snap.data a promise): output
  // from then on waits for it (held), and so does the pane's exit.
  // Each subscription is its own object, taken in the project the pane is in
  // then: a screen that comes back for one already forgotten (the pane left
  // the project, maybe came back) does nothing. Only a pane the guest may
  // see is taken. The screen comes from takeScreen (one at a time per pane).
  function subscribe(g, id) {
    if (g.subscribed.has(id)) return
    const project = paneProject(id)
    if (!project || !g.projects.has(project)) return
    const sub = { state: 'loading', held: false, exit: undefined, project }
    g.subscribed.set(id, sub)
    const current = () => guests.has(g.id) && g.subscribed.get(id) === sub
    let done = false
    const ready = (snap) => {
      if (done) return
      done = true
      if (!current() || sub.state !== 'loading') return
      if (!live(g, id, sub)) return forget(g, id)
      sub.state = 'live'
      const cols = snap?.cols || 0
      const rows = snap?.rows || 0
      const data = snap?.data
      if (!data || typeof data.then !== 'function') {
        send(g, { t: 'snapshot', id, data: typeof data === 'string' ? data : '', cols, rows })
        return
      }
      sub.held = true
      Promise.resolve(data)
        .catch(() => '')
        .then((text) => {
          if (!current() || !sub.held) return
          sub.held = false
          if (!live(g, id, sub)) return forget(g, id)
          send(g, { t: 'snapshot', id, data: typeof text === 'string' ? text : '', cols, rows })
          const exit = sub.exit
          sub.exit = undefined
          flush(g)
          if (exit !== undefined) send(g, { t: 'exit', id, exitCode: exit })
        })
    }
    takeScreen(id, ready)
  }

  // Screens being taken (callbacks.snapshot), by pane: the ready() of each
  // subscription waiting for it. One at a time per pane: a subscription that
  // needs a pane's screen while one is being taken gets that one (the same
  // screen, then the same output after it), so guests joining, coming back
  // or reloading together cost one screen per pane, and a connection that
  // was replaced leaves nothing more running. Done the moment its answer is
  // read: one needed after that is taken anew.
  const taking = new Map() // pane id -> Set of ready()
  function takeScreen(id, ready) {
    const waiting = taking.get(id)
    if (waiting) {
      waiting.add(ready)
      return
    }
    const waiters = new Set([ready])
    taking.set(id, waiters)
    let done = false
    const answered = (snap) => {
      if (done) return
      done = true
      if (taking.get(id) === waiters) taking.delete(id)
      for (const w of waiters) {
        try {
          w(snap)
        } catch {
          /* one guest's screen going wrong never stops the others' */
        }
      }
    }
    Promise.resolve()
      .then(() => callbacks.snapshot(id, answered))
      .then(answered, () => answered(null))
  }

  // The shared projects a guest sees, and where each of their terminals is
  // (a pane listed in two projects is the first one's), and each agent pane
  // it can look at as a chat (only for a guest with the 'chat' feature: the
  // others get the projects as before).
  function projectsOf(g, projects = callbacks.projects()) {
    const chat = speaksChat(g)
    const mine = projects.filter((p) => g.projects.has(p.id)).map((p) => (chat ? { id: p.id, layout: p.layout, panes: p.panes, chats: chatsOf(p) } : { id: p.id, layout: p.layout, panes: p.panes }))
    const where = new Map()
    const chatWhere = new Map()
    for (const p of mine) {
      for (const pane of p.panes) if (!where.has(pane.id)) where.set(pane.id, p.id)
      for (const c of p.chats || []) if (!chatWhere.has(c.id)) chatWhere.set(c.id, p.id)
    }
    return { mine, where, chatWhere }
  }

  // What a guest sees of the share now, sent to it: its projects (layouts and
  // terminals). What it no longer sees is forgotten first (nothing more of it
  // goes out), a pane that moved to another of its projects is taken again,
  // and what it sees is taken (its screen, then its output).
  function sendProjects(g, projects) {
    const { mine, where, chatWhere } = projectsOf(g, projects)
    for (const [id, sub] of [...g.subscribed]) if (where.get(id) !== sub.project) forget(g, id)
    // A conversation it no longer sees: nothing more of it goes out.
    for (const [id, project] of [...g.chats]) if (chatWhere.get(id) !== project) unwatchChat(g, id)
    send(g, { t: 'projects', projects: mine })
    for (const id of where.keys()) subscribe(g, id)
  }

  // What a connected guest gets now, from the access model (its grant, the
  // projects shared now): kept on the connection for the hot paths. true
  // when it changed.
  function syncGrant(g) {
    const e = access.effective(g.person)
    const projectsChanged = e.projects.size !== g.projects.size || [...e.projects].some((id) => !g.projects.has(id))
    const rightsChanged = !sameRights(e.rights, g.rights)
    g.projects = e.projects
    g.rights = e.rights
    return { projectsChanged, rightsChanged }
  }
  // Every guest in gets what it now gets: its projects at once (and loses
  // the others: their panes and conversations stop), its rights.
  function refreshGuests(projects = callbacks.projects()) {
    let any = false
    for (const g of guests.values()) {
      if (g.state !== 'joined' || !g.person) continue
      const { projectsChanged, rightsChanged } = syncGrant(g)
      if (projectsChanged || rightsChanged) revalidate(g)
      if (projectsChanged) sendProjects(g, projects)
      if (rightsChanged) send(g, { t: 'rights', rights: { ...g.rights } })
      if (projectsChanged || rightsChanged) any = true
    }
    if (any) {
      notifyGuests()
      presenceChanged()
    }
  }

  // A subject of the host's window: a guest in (its connection's id), a
  // person let in (k-...), a trusted person (t-...) or an invitation
  // (iv-...). null when it is none (any more).
  function subjectOf(id) {
    const text = String(id || '')
    if (isInviteId(text)) return access.invite(text) ? { invite: text } : null
    if (isTrustId(text)) return trust && trust.byId(text) ? { trust: text.slice(2) } : null
    if (text.startsWith('k-')) {
      const p = access.personById(text)
      return p ? { person: p.hash } : null
    }
    const g = guests.get(text)
    return g && g.state === 'joined' && g.person && access.person(g.person.hash) ? { person: g.person.hash } : null
  }
  const connectionOf = (hash) => [...guests.values()].find((x) => x.state === 'joined' && x.person && x.person.hash === hash) || null

  // In: the guest's person (its reconnect key, name, grant and counters).
  function welcome(g, back = false) {
    g.state = 'joined'
    g.everJoined = true
    g.since = now()
    g.person.name = g.name
    g.person.lastSeen = now()
    syncGrant(g)
    const t = trustedOf(g)
    if (t) {
      trust.seen(t.fp)
      // One connection per trusted identity: the one it had ends.
      for (const other of [...guests.values()]) if (other !== g && other.person && other.person.trust === t.fp) drop(other, 'replaced')
    }
    knownChanged()
    log(`guest ${g.name || '?'} ${back ? 'came back' : 'joined'}${t ? ' (trusted)' : ''}`)
    notifyGuests()
    const { mine, where } = projectsOf(g)
    // This host's key, and its signature of this connection (a returning
    // guest checks it with the key it got the first time).
    const proof = { hostKey: hostKey.publicRaw.toString('base64'), hostSig: signBinding(hostKey, g.binding).toString('base64') }
    const agents = speaksAgents(g) && callbacks.agents ? { agents: cleanAgents(callbacks.agents()) } : {}
    // The share's rendezvous secret (inside the sealed channel).
    const rdv = Buffer.isBuffer(rendezvousSecret) && rendezvousSecret.length === 32 ? { rdv: rendezvousSecret.toString('base64') } : {}
    send(g, { t: 'welcome', host: hostName, protocol: SHARE_PROTOCOL, features: [...hostFeatures], projects: mine, rights: { ...g.rights }, ...agents, ...proof, ...rdv })
    for (const id of where.keys()) subscribe(g, id)
  }

  // A guest coming back: its key signed this connection's binding. In at
  // once, as it was (the connection it had, if any, ends). Anything else:
  // turned away, no question.
  function rejoin(g, back) {
    const key = Buffer.from(String(back.key || ''), 'base64')
    const signature = Buffer.from(String(back.sig || ''), 'base64')
    const person = key.length === KX_BYTES ? access.person(keyHash(key)) : null
    if (!person || !bindingSigned(key, g.binding, signature)) return drop(g, 'rejoin-refused')
    // Linked to a trusted entry that is gone (trust taken back while this
    // share was being taken back): no longer let in by itself.
    if (person.trust && !(trust && trust.get(person.trust))) {
      access.removePerson(person.hash)
      return drop(g, 'rejoin-refused')
    }
    // Back too often (each time, every pane it sees is taken again): turned
    // away until its minute is over, the connection it had kept. Counted for
    // its address like any connection, never against the code (it proved its
    // key); only the times it got in count, so its Tessel trying again every
    // few seconds gets in once the minute is over.
    if (!within(access.countersOf(person), 'rejoins', REJOINS_PER_MINUTE)) {
      g.byHost = true
      return drop(g, 'busy')
    }
    for (const other of [...guests.values()]) if (other !== g && other.person && other.person.hash === person.hash) drop(other, 'replaced')
    // At most a few more than the guests' room (it was one of them). The
    // host's doing: never counted against the code (it proved its key).
    if ([...guests.values()].filter((x) => x.state === 'joined').length >= MAX_GUESTS + 2) {
      g.byHost = true
      return drop(g, 'busy')
    }
    g.person = person
    g.name = person.name || cleanName(g.name)
    g.identity = person.identity
    welcome(g, true)
  }

  // The pane's screen again, then its output (a guest's window reloaded, a
  // pane restarted on the host).
  function resubscribe(g, id) {
    forget(g, id)
    subscribe(g, id)
  }

  // Its identity key, proved for this connection (null: none given, as an
  // older Tessel; false: one given that does not hold).
  function identityOf(g, id) {
    if (id === undefined || id === null) return null
    if (typeof id !== 'object') return false
    const key = Buffer.from(String(id.key || ''), 'base64')
    const sig = Buffer.from(String(id.sig || ''), 'base64')
    return key.length === KX_BYTES && identitySigned(key, g.binding, sig) ? key : false
  }

  async function onJoin(g, msg) {
    g.name = cleanName(msg.name)
    // What its Tessel speaks too (an older one says nothing: none).
    g.features = new Set(cleanFeatures(msg.features).filter((f) => hostFeatures.includes(f)))
    if (msg.rejoin && typeof msg.rejoin === 'object') return rejoin(g, msg.rejoin)
    // A new guest: an invitation's current code, one that lets new guests in.
    const inv = access.liveInvite(g.entry)
    const why = inv ? access.usable(inv) : 'expired'
    if (why) {
      log(`a new guest turned away: invitation ${why === 'revoked' && !inv ? 'replaced or gone' : why}`)
      return drop(g, 'expired')
    }
    // Its reconnect key: it signed this connection with it (it holds it), not
    // a weak one, and not one already known (another guest's); and its
    // identity key, when it gives one, proved the same way.
    const key = Buffer.from(String(msg.key || ''), 'base64')
    const proof = Buffer.from(String(msg.sig || ''), 'base64')
    if (key.length !== KX_BYTES || !bindingSigned(key, g.binding, proof) || access.person(keyHash(key))) return drop(g, 'protocol')
    const identity = identityOf(g, msg.identity)
    if (identity === false) return drop(g, 'protocol')
    g.identity = identity
    const t = identity && trust ? trust.get(identityFingerprint(identity)) : null
    // (Guests that waited too long first make room.)
    expireWaiting()
    const inOrWaiting = [...guests.values()].filter((x) => x.state === 'joined' || x.state === 'waiting')
    // A trusted identity already in comes in its own place (its connection
    // is replaced).
    const replacing = !!t && inOrWaiting.some((x) => x.state === 'joined' && x.person && x.person.trust === t.fp)
    // The room full (guests the host let in, and at most a few waiting): the
    // host's doing, not counted against the invitation, up to ROOM_FULL_FREE
    // in 10 min. A room full with its waiting line full too is still a full
    // room.
    if (inOrWaiting.length >= MAX_GUESTS && !replacing) {
      if (access.noteRoomFull(inv.id)) g.byHost = true
      return drop(g, 'busy')
    }
    // A trusted person: in at once, with its trusted grant, a few times a
    // minute at most (its identity's count: never against the code, it
    // proved its keys).
    if (t) {
      if (!within(access.trustCounters(t.fp), 'joins', TRUSTED_JOINS_PER_MINUTE)) {
        g.byHost = true
        return drop(g, 'busy')
      }
      return admitTrusted(g, key, inv, t.fp)
    }
    // The invitation pausing after a no, or its waiting line full, with room
    // left: counted (anyone can cause those: leave while waiting, or wait
    // as many times as its line holds: they can't be a way around the count).
    const waiting = [...guests.values()].filter((x) => x.state === 'waiting')
    if (access.pausing(inv.id) || waiting.filter((x) => x.guardId === inv.id).length >= MAX_WAITING) return drop(g, 'busy')
    // Every invitation pausing (noes in a row), or the host's waiting line
    // full in all: like a full room (other invitations' guests may cause
    // those: not counted against this one, up to ROOM_FULL_FREE).
    if (access.pausingAll() || waiting.length >= MAX_WAITING_ALL) {
      if (access.noteRoomFull(inv.id)) g.byHost = true
      return drop(g, 'busy')
    }
    g.state = 'waiting'
    g.waitingSince = now()
    g.waitTimer = setTimeout(() => guests.has(g.id) && g.state === 'waiting' && drop(g, 'timeout'), WAITING_MS)
    g.waitTimer.unref?.()
    notifyGuests()
    send(g, { t: 'waiting' })
    const shared = sharedIds()
    const offer = { projects: inv.grant.projects.filter((id) => shared.has(id)), rights: { ...inv.grant.rights } }
    const answer = await new Promise((resolve) => {
      g.resolveApproval = resolve
      Promise.resolve(callbacks.askApproval({ ...publicGuest(g), offer })).then(resolve, () => resolve(false))
    })
    g.resolveApproval = null
    if (!guests.has(g.id)) return
    if (!(answer === true || (answer && typeof answer === 'object' && answer.yes === true))) {
      log(`guest ${g.name || '?'} denied`)
      denied(g, true)
      drop(g, 'denied')
      return
    }
    // The invitation changed while it waited (revoked, expired, a new code,
    // used up): not in.
    if (access.liveInvite(g.entry) !== inv || access.usable(inv) || access.person(keyHash(key))) return drop(g, access.person(keyHash(key)) ? 'protocol' : 'expired')
    // The shared projects the host gave it, as shared at this moment: the
    // ones its answer lists (none when it lists none); a plain yes (true):
    // all of them. Its rights: the answer's (none when not said).
    const given = answer === true ? [...sharedIds()] : cleanProjectIds(answer.projects)
    const grant = cleanGrant({ projects: given.filter((id) => sharedIds().has(id)), rights: answer === true ? null : answer.rights })
    // Trusted from now on, when the host said so (only with an identity key;
    // the host's window checks there is room in the list first).
    if (answer !== true && answer.trust === true && identity && trust) {
      const e = trust.add({ key: identity, name: g.name, projects: grant.projects, rights: grant.rights })
      // (What the host just gave it is all it gets: the invitation's other
      // projects are not added.)
      if (e) return admitTrusted(g, key, inv, e.fp, { answered: true })
      log(`guest ${g.name || '?'} let in without trust: the trusted list is full`)
    }
    g.person = access.addPerson({ key, name: g.name, sid: g.entry.sid, via: inv.id, identity: g.identity, grant })
    if (!g.person) return drop(g, 'busy')
    welcome(g)
    // One more use: past its last, the others waiting with it are turned away.
    if (access.used(inv)) dropNotJoined('expired')
  }

  // A trusted identity in, through an invitation: its one person entry (taken
  // over with this reconnect key; the connection it had ends), no new use
  // for an invitation it used already. The first time it uses an invitation,
  // the shared projects that invitation offers are added to what it is
  // trusted with (shareAccess.js trustedInviteProjects), so it sees them the
  // moment it is in; not when the host just answered its join (answered:
  // its answer is what it gets).
  function admitTrusted(g, key, inv, fp, { answered = false } = {}) {
    const claim = access.claimTrusted(fp, { key, name: g.name, sid: g.entry.sid, via: inv.id, identity: g.identity })
    if (!claim) {
      g.byHost = true
      return drop(g, 'busy')
    }
    if (!answered && access.trustedInviteProjects(inv, fp)) log(`guest ${g.name || '?'} (trusted) given the projects of invitation ${inv.id}`)
    for (const other of [...guests.values()]) if (other !== g && other.person && (other.person === claim.person || claim.replaced.includes(other.person.hash))) drop(other, 'replaced')
    g.person = claim.person
    welcome(g)
    if (access.usedBy(inv, fp)) dropNotJoined('expired')
  }

  // Under a limit a minute of a guest's person (the times of its last ones,
  // kept in its `listName`): counted when it is.
  function within(person, listName, perMinute) {
    const t = now()
    const recent = (person[listName] || []).filter((x) => t - x < 60000)
    person[listName] = recent
    if (recent.length >= perMinute) return false
    recent.push(t)
    return true
  }

  // Under its limit (times of its last asks, kept in its person's `list`), or
  // tells the guest it asked too often.
  function allowed(g, listName, perMinute, inAll = Infinity) {
    if (!g.person) return false
    const counts = countsOf(g)
    if (counts.opened >= inAll || !within(counts, listName, perMinute)) {
      send(g, { t: 'notice', code: 'limit' })
      return false
    }
    return true
  }
  // The agents the host lists now (their ids).
  const agentIds = () => new Set(callbacks.agents ? cleanAgents(callbacks.agents()).map((a) => a.id) : [])

  function onMessage(g, msg) {
    if (!msg || typeof msg.t !== 'string') return drop(g, 'protocol')
    if (g.state === 'secured') {
      if (msg.t !== 'join') return drop(g, 'protocol')
      onJoin(g, msg)
      return
    }
    if (msg.t === 'leave') return drop(g, 'left')
    if (g.state !== 'joined') return
    // Every request about a pane: a pane of the guest's projects, as they
    // are now (not as the guest last heard).
    switch (msg.t) {
      case 'resync': {
        if (!g.subscribed.has(msg.id) || !canSee(g, msg.id)) return
        // Counted in its person: a new connection does not start from zero.
        if (!within(countsOf(g), 'resyncs', RESYNCS_PER_MINUTE)) return
        resubscribe(g, msg.id)
        return
      }
      case 'write': {
        if (!g.rights.type || typeof msg.data !== 'string' || msg.data.length > MAX_WRITE || !canSee(g, msg.id)) return
        const data = stripTerminalReplies(msg.data)
        if (!data) return
        callbacks.write(msg.id, data)
        typed(g, msg.id)
        return
      }
      case 'open': {
        // A terminal or a listed agent, in one of its projects, still shared.
        const spec = openSpec(msg.spec)
        if (!spec || !g.projects.has(spec.project) || !sharedIds().has(spec.project)) return
        if (spec.kind === 'agent' && !agentIds().has(spec.agent)) return send(g, { t: 'notice', code: 'agent' })
        if (g.rights.open) {
          if (!allowed(g, 'opens', OPENS_PER_MINUTE, OPENS_IN_ALL)) return
          countsOf(g).opened++
          knownChanged()
          log(`guest ${g.name || '?'} opened ${spec.kind === 'agent' ? `the agent ${spec.agent}` : 'a terminal'}`)
          callbacks.openPane(spec, publicGuest(g))
          return
        }
        // Without the right: the host is asked (a guest whose Tessel can ask).
        if (!speaksAgents(g) || typeof callbacks.askOpen !== 'function') return
        if (!within(countsOf(g), 'openAsks', OPEN_ASKS_PER_MINUTE)) return send(g, { t: 'notice', code: 'limit' })
        callbacks.askOpen(spec, publicGuest(g))
        return
      }
      case 'close':
        if (!g.rights.close || !canSee(g, msg.id)) return
        if (!allowed(g, 'closes', CLOSES_PER_MINUTE)) return
        knownChanged()
        callbacks.closePane(msg.id, publicGuest(g))
        return
      // Phase 2's requests and subscriptions (shareChannel.js).
      case 'req':
        return onRequest(g, msg)
      case 'cancel':
        return onCancel(g, msg)
      case 'sub':
        return onSub(g, msg)
      // The pane it has on screen now (presence, the host's eyes only): one
      // of its panes, or none; a couple a second at most. It gives nothing.
      case 'focus': {
        if (!g.features.has('presence') || !within(countsOf(g), 'focuses', FOCUS_PER_MINUTE)) return
        const id = typeof msg.id === 'string' && /^[\w-]{1,80}$/.test(msg.id) && canSee(g, msg.id) ? msg.id : null
        if (id === g.focus) return
        g.focus = id
        presenceChanged()
        return
      }
      // An agent pane's conversation, watched or no longer (read only: no
      // right needed, nothing reaches the pane).
      case 'chat': {
        if (!speaksChat(g) || typeof msg.id !== 'string' || !/^[\w-]{1,80}$/.test(msg.id)) return
        const person = countsOf(g)
        // A stop: only for a conversation it watches (of a project it sees:
        // one it lost is let go already).
        if (msg.on !== true) {
          if (g.chats.has(msg.id)) unwatchChat(g, msg.id)
          return
        }
        // All of it again (its copy no longer lines up): its own small limit.
        if (msg.resync === true) {
          if (!g.chats.has(msg.id) || !chatLive(g, msg.id) || !within(person, 'chatResyncs', CHAT_RESYNCS_PER_MINUTE)) return
          g.chatSent.delete(msg.id)
          const last = chatLast.get(msg.id)
          if (last) sendChatTo(g, msg.id, last)
          return
        }
        // Every ask counts (answered or not); past the limit, "busy" once a
        // minute for that pane (its view then waits and asks again later).
        if (!within(person, 'chatAsks', CHATS_PER_MINUTE)) {
          const said = g.chatBusySaid.get(msg.id)
          if (said && now() - said < 60000) return
          if (g.chatBusySaid.size >= 64) g.chatBusySaid.clear()
          g.chatBusySaid.set(msg.id, now())
          return send(g, { t: 'chat', id: msg.id, ok: false, code: 'busy' })
        }
        if (g.chats.has(msg.id)) return
        const project = chatProject(msg.id)
        if (!project || !g.projects.has(project)) return send(g, { t: 'chat', id: msg.id, ok: false, code: 'unavailable' })
        if (g.chats.size >= MAX_CHATS) return send(g, { t: 'chat', id: msg.id, ok: false, code: 'busy' })
        watchChat(g, msg.id, project)
        return
      }
      default:
        return
    }
  }

  // Guests waiting under a code that no longer lets anyone in (its
  // invitation revoked, expired, used up, blocked or given a new code):
  // turned away.
  function dropNotJoined(reason) {
    for (const g of [...guests.values()]) {
      if (g.state !== 'waiting') continue
      const inv = access.liveInvite(g.entry)
      if (inv && !access.usable(inv)) continue
      g.byHost = true
      drop(g, reason)
    }
  }

  const parse = (data, isBinary) => {
    try {
      return isBinary ? null : JSON.parse(data.toString())
    } catch {
      return null
    }
  }

  function onConnection(socket, req) {
    const t = now()
    // Where it comes from: Cloudflare says (the tunnel), else the socket.
    const address = addressKey((req && req.headers && req.headers['cf-connecting-ip']) || (req && req.socket && req.socket.remoteAddress) || '')
    exchanges = exchanges.filter(([x]) => t - x < 60000)
    const shaking = [...guests.values()].filter(inHandshake)
    if (
      stopped ||
      exchanges.length >= EXCHANGES_PER_MINUTE ||
      exchanges.filter(([, a]) => a === address).length >= EXCHANGES_PER_ADDRESS ||
      shaking.length >= HANDSHAKES_AT_ONCE ||
      shaking.filter((x) => x.address === address).length >= HANDSHAKES_PER_ADDRESS
    ) {
      socket.close(CLOSE_BUSY)
      return
    }
    // Counted from the moment it connects, whatever it does next.
    exchanges.push([t, address])
    const hello = JSON.stringify({ t: 'hello', app: 'tessel-liveshare', v: SHARE_PROTOCOL })
    // The codes its address may use: one invitation's (an earlier code of
    // its, kept for its people), or the root ones. None: it hears that this
    // is a Tessel Live Share (the tunnel's check) and is closed as expired.
    const codes = access.codesAt(pathOfUrl(req && req.url))
    if (!codes.length) {
      socket.send(hello)
      socket.close(CLOSE_EXPIRED)
      return
    }
    const g = {
      id: `g${nextGuest++}`,
      name: '',
      address,
      state: 'handshake',
      socket,
      channel: null,
      entry: null, // the code it opened its first message with
      // The invitation it is counted against: its address's live one (none
      // for an earlier code: only coming back works with it).
      guardId: codes.map((c) => access.liveInvite(c)).find(Boolean)?.id || null,
      binding: null,
      code: null,
      person: null,
      identity: null,
      keysSent: false,
      everJoined: false,
      rights: { ...NO_RIGHTS },
      projects: new Set(), // the shared projects it sees (once in)
      features: new Set(), // what its Tessel speaks beyond the protocol (shareChat.js)
      chats: new Map(), // pane id -> the project it was asked in: the conversations it watches
      chatSent: new Map(), // pane id -> { marks, truncated }: what it has of each
      chatHeld: new Set(), // conversations held while its connection is behind
      chatBusySaid: new Map(), // pane id -> when it was last told "busy" (past its limit)
      chatHeldTimer: null,
      focus: null, // the pane it has on screen (presence)
      waitingSince: 0, // when it started waiting for the host's answer
      waitTimer: null,
      typed: new Map(), // pane id -> when it last typed there (presence)
      typedSaid: new Map(), // pane id -> when its typing there was last said
      subscribed: new Map(), // pane id -> { state: 'loading' | 'live', held, exit, project }
      pending: new Map(),
      reqs: new Map(), // request id -> what it asked (shareChannel.js), until answered
      bulk: [], // large answers waiting for the connection to catch up
      bulkTimer: null,
      subs: new Map(), // subscription name -> { topic, project, key, seq }
      pushHeld: new Map(), // subscription name -> its latest news, held while behind
      pushTimer: null,
      flushTimer: null,
      since: 0,
      alive: true
    }
    guests.set(g.id, g)
    const hostNonce = newNonce()
    const pair = newKeyPair()
    let commit = null
    // The keys of this connection under each code its address may use: the
    // first message tells which one the guest has.
    let candidates = null
    const timer = setTimeout(() => {
      if (inHandshake(g)) drop(g, 'timeout')
    }, HANDSHAKE_MS)
    // Silent after the hello (no commitment): gone soon.
    const quiet = setTimeout(() => {
      if (g.state === 'handshake') drop(g, 'timeout')
    }, COMMIT_MS)
    socket.send(hello)
    socket.on('pong', () => (g.alive = true))
    socket.on('message', (data, isBinary) => {
      if (!guests.has(g.id)) return
      // 1. The guest's commitment; then the host's nonce and key.
      if (g.state === 'handshake') {
        const msg = parse(data, isBinary)
        // A Tessel with the first protocol sends its nonce right away.
        if (msg && msg.t === 'nonce') {
          socket.close(CLOSE_OUTDATED)
          return drop(g, 'outdated')
        }
        commit = msg && msg.t === 'commit' ? Buffer.from(String(msg.c || ''), 'base64') : null
        if (!commit || commit.length !== COMMIT_BYTES) return drop(g, 'protocol')
        g.state = 'committed'
        g.keysSent = true
        socket.send(JSON.stringify({ t: 'keys', n: hostNonce.toString('base64'), kx: pair.publicRaw.toString('base64') }))
        return
      }
      // 2. The guest's nonce and key, as committed.
      if (g.state === 'committed') {
        const msg = parse(data, isBinary)
        const guestNonce = msg && msg.t === 'reveal' ? Buffer.from(String(msg.n || ''), 'base64') : null
        const guestKey = msg && msg.t === 'reveal' ? Buffer.from(String(msg.kx || ''), 'base64') : null
        if (!guestNonce || guestNonce.length !== NONCE_BYTES || !commitmentMatches(commit, guestNonce, guestKey)) return drop(g, 'protocol')
        const dh = sharedSecret(pair.privateKey, guestKey)
        if (!dh) return drop(g, 'protocol')
        candidates = codes.filter((c) => access.hasCode(c.sid)).map((c) => ({ code: c, session: sessionKeys(c.secret, hostNonce, guestNonce, 'host', { dh, hostKey: pair.publicRaw, guestKey }) }))
        g.state = 'secured'
        return
      }
      if (!isBinary) return drop(g, 'protocol')
      // 3. Its first sealed message: under which of those codes.
      if (!g.channel) {
        for (const c of candidates) {
          const channel = createChannel(c.session)
          const msg = channel.open(data)
          if (!msg) continue
          g.channel = channel
          g.entry = c.code
          g.code = c.session.code
          g.binding = c.session.binding
          // An earlier code: only coming back works with it, and nothing
          // done with it counts against an invitation.
          g.guardId = access.liveInvite(c.code)?.id || null
          candidates = null
          clearTimeout(timer)
          return onMessage(g, msg)
        }
        return drop(g, 'refused') // not sealed with this address's codes
      }
      const msg = g.channel.open(data)
      if (!msg) return drop(g, 'refused')
      onMessage(g, msg)
    })
    socket.on('close', () => {
      clearTimeout(timer)
      clearTimeout(quiet)
      drop(g, 'closed')
    })
    socket.on('error', () => {})
  }

  // A guest that did not answer the last ping is gone (a dead tunnel or
  // computer): dropped. Started once the server listens. Expired
  // invitations go (their waiting guests are turned away), and people
  // offline too long are forgotten.
  function startPings() {
    clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      access.prune()
      dropNotJoined('expired')
      expireWaiting()
      access.forgetOld()
      for (const g of [...guests.values()]) {
        if (!guests.has(g.id)) continue
        if (!g.alive) {
          drop(g, 'timeout')
          continue
        }
        g.alive = false
        try {
          g.socket.ping()
        } catch {
          /* closes by itself */
        }
      }
    }, PING_MS)
  }

  return {
    // Listens on 127.0.0.1 (port 0: any free port). Resolves the port.
    start(port = 0) {
      clearInterval(pingTimer)
      pingTimer = null
      return new Promise((resolve, reject) => {
        wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          maxPayload: MAX_FRAME,
          perMessageDeflate: false,
          // Tessel never sends an Origin; a web page always does.
          verifyClient: ({ req }) => !req.headers.origin
        })
        const failed = (err) => {
          try {
            wss.close()
          } catch {
            /* not listening */
          }
          wss = null
          reject(err)
        }
        wss.once('error', failed)
        wss.once('listening', () => {
          wss.off('error', failed)
          wss.on('error', (err) => log(`share server: ${err.message}`))
          startPings()
          resolve(wss.address().port)
        })
        wss.on('connection', onConnection)
      })
    },
    stop(reason = 'stopped') {
      stopped = true
      clearInterval(pingTimer)
      clearTimeout(typingTimer)
      for (const g of [...guests.values()]) drop(g, reason)
      for (const st of chatTimes.values()) clearTimeout(st.timer)
      chatTimes.clear()
      heavyRuns.clear()
      heavyTails.clear()
      try {
        wss?.close()
      } catch {
        /* already closed */
      }
      wss = null
    },
    // Output of a pane, as the terminal host sends it (not batched yet: a
    // guest whose snapshot is being taken must skip exactly what came before
    // it), to every guest that has the pane; sent in batches.
    sendData(id, data) {
      const project = paneProject(id)
      if (!project) return
      for (const g of guests.values()) {
        if (g.state !== 'joined' || !g.projects.has(project)) continue
        const sub = g.subscribed.get(id)
        if (!sub || sub.state !== 'live' || sub.project !== project) continue
        g.pending.set(id, (g.pending.get(id) || '') + data)
        if (!g.flushTimer) g.flushTimer = setTimeout(() => flush(g), FLUSH_MS)
      }
    },
    // A pane's conversation as the host's Tessel read it (shareChat.js
    // guestChatPayload: { ok: true, events, truncated } or { ok: false,
    // code }), to every guest watching it that may still see it; at most
    // once every CHAT_EVERY_MS per pane (the latest goes when its time comes).
    sendChat(id, payload) {
      if (!chatWatchers.has(id)) return
      const message = chatMessage(payload)
      if (!message) return
      chatLast.set(id, message)
      const st = chatTimes.get(id)
      if (st && st.timer) return
      const wait = st ? st.at + CHAT_EVERY_MS - Date.now() : 0
      if (wait > 0) {
        chatTimes.set(id, { at: st.at, timer: setTimeout(() => flushChat(id), wait) })
        return
      }
      flushChat(id)
    },
    // News of a topic (shareChannel.js TOPICS), to every guest subscribed to
    // it that may still see it; a topic that keeps it gives it to the next
    // subscriber too.
    push(topic, project = null, key = null, data = null) {
      const spec = Object.hasOwn(TOPICS, topic) ? TOPICS[topic] : null
      const k = subKey(topic, project, key)
      const set = spec ? watchers.get(k) : null
      if (!set) return
      if (spec.keep) lastPush.set(k, data)
      for (const gid of set) {
        const g = guests.get(gid)
        const sub = g && g.subs.get(k)
        if (g && sub && g.state === 'joined' && subLive(g, sub)) pushTo(g, k, data)
      }
    },
    // The subscriptions guests hold now ({ topic, project, key, guests }).
    watched: () => [...watchers].map(([k, set]) => ({ ...parseSubKey(k), guests: [...set] })),
    // A topic the host's Tessel ends (a file now hidden): every guest's
    // subscription to it ends (its watch is told, as when the last leaves).
    endTopic(topic, project = null, key = null) {
      const k = subKey(topic, project, key)
      const set = watchers.get(k)
      // A perGuest topic's subscriptions are each guest's own (no watchers).
      const ids = set ? [...set] : [...guests.values()].filter((g) => g.subs.has(k)).map((g) => g.id)
      for (const gid of ids) {
        const g = guests.get(gid)
        if (g) unsubscribe(g, k)
      }
    },
    // The panes whose conversation guests watch now, and who (guest ids).
    chatsWatched: () => [...chatWatchers].filter(([, set]) => set.size).map(([id, set]) => ({ id, guests: [...set] })),
    presence,
    sendExit(id, exitCode) {
      if (!paneProject(id)) return
      for (const g of guests.values()) {
        const sub = g.subscribed.get(id)
        if (g.state !== 'joined' || !sub || !live(g, id, sub)) continue
        if (sub.held) {
          sub.exit = exitCode
          continue
        }
        flush(g)
        send(g, { t: 'exit', id, exitCode })
      }
    },
    // The host's screen changed (a pane opened, closed, renamed, resized or
    // moved, a project shared or taken out of the share, a layout changed):
    // each guest gets what it sees now.
    panesChanged() {
      const projects = callbacks.projects()
      holding++
      try {
        access.sharedChanged(projects.map((p) => p.id))
      } finally {
        holding--
      }
      let any = heldGrants
      heldGrants = false
      for (const g of guests.values()) {
        if (g.state !== 'joined' || !g.person) continue
        const { projectsChanged, rightsChanged } = syncGrant(g)
        revalidate(g)
        if (rightsChanged) send(g, { t: 'rights', rights: { ...g.rights } })
        if (projectsChanged || rightsChanged) any = true
        sendProjects(g, projects)
      }
      if (any) notifyGuests()
      presenceChanged()
    },
    // The agents guests may ask for changed: guests that list them are told.
    agentsChanged() {
      if (!callbacks.agents) return
      const agents = cleanAgents(callbacks.agents())
      for (const g of guests.values()) if (g.state === 'joined' && speaksAgents(g)) send(g, { t: 'agents', agents })
    },
    // The host's answer to a guest waiting: false, or { projects, rights,
    // trust } (projects: the ones it gets, none when not said).
    approve(guestId, yes, { projects, rights, trust: trustIt = false } = {}) {
      guests.get(guestId)?.resolveApproval?.(yes ? { yes: true, projects, rights, trust: trustIt === true } : false)
    },
    // A pane restarted on the host (same id, a new terminal): guests are told,
    // then get its new screen.
    paneRestarted(id) {
      // A screen being taken now may be the terminal's before: no one gets
      // it from here on (the next is taken anew).
      taking.delete(id)
      if (!paneProject(id)) return
      for (const g of guests.values()) {
        if (g.state !== 'joined' || !g.subscribed.has(id) || !canSee(g, id)) continue
        flush(g)
        send(g, { t: 'restart', id })
        resubscribe(g, id)
      }
    },

    // --- Access (shareAccess.js), as the host's window changes it ----------
    // One project or one right of someone (a guest in, a person let in, a
    // trusted person, an invitation; see subjectOf), against what it has
    // now: two changes in a row never undo each other. A guest in gets it at
    // once (a project taken away: its panes and conversations stop), one
    // offline comes back with it.
    change(subjectId, { project, right, on } = {}) {
      const subject = subjectOf(subjectId)
      if (!subject) return false
      if (project !== undefined && on && !sharedIds().has(project)) return false
      return access.change(subject, project !== undefined ? { project, on: !!on } : { right, on: !!on })
    },
    // Someone's whole grant: { projects (shared ones), rights }.
    setGrant(subjectId, grant = {}) {
      const subject = subjectOf(subjectId)
      if (!subject) return false
      if (subject.invite) return access.updateInvite(subject.invite, grant, { applyRemovals: false }).ok
      return access.setGrant(subject, grant)
    },

    // Invitations (shareAccess.js): created, changed (its people too, when
    // said), revoked (its people removed too, when said), given a new code,
    // duplicated. Guests waiting under a code that no longer lets anyone in
    // are turned away.
    invites: () => access.invites().map(access.publicInvite),
    inviteCode: (id) => {
      const c = access.codeOf(id)
      return c ? { path: c.path, secret: c.secret } : null
    },
    createInvite(spec, opts) {
      const r = access.createInvite(spec, opts)
      return r.ok ? { ok: true, invite: access.publicInvite(r.invite) } : r
    },
    updateInvite(id, patch, opts) {
      const r = access.updateInvite(id, patch, opts)
      if (r.ok) dropNotJoined('expired')
      return r
    },
    revokeInvite(id, { removePeople = false } = {}) {
      const r = access.revokeInvite(id)
      if (!r.ok) return r
      dropNotJoined('expired')
      let removed = 0
      if (removePeople) {
        for (const hash of r.people) {
          if (!access.person(hash)) continue
          const g = connectionOf(hash)
          if (g) drop(g, 'removed')
          access.removePerson(hash)
          removed++
        }
      }
      return { ok: true, removed }
    },
    rotateInvite(id, opts) {
      const r = access.rotateInvite(id, opts)
      if (r.ok) dropNotJoined('expired')
      return r
    },
    duplicateInvite(id) {
      const r = access.duplicateInvite(id)
      return r.ok ? { ok: true, invite: access.publicInvite(r.invite) } : r
    },

    // Trust (shareTrust.js): a guest let in with an identity key, trusted
    // from now on (its grant becomes the trusted one), or no longer (the
    // people it is keep what they had).
    trust(guestId) {
      const subject = subjectOf(guestId)
      if (!subject || !subject.person) return false
      const e = access.trustPerson(subject.person)
      if (!e) return false
      // One connection per trusted identity: this one stays.
      const keep = connectionOf(subject.person)
      for (const other of [...guests.values()]) if (other !== keep && other.state === 'joined' && other.person && other.person.trust === e.fp && keep) drop(other, 'replaced')
      notifyGuests()
      return true
    },
    // No longer trusted: its people are removed (connected ones too): to come
    // back, the host's yes again.
    untrust(id) {
      const fp = isTrustId(id) ? id.slice(2) : null
      const r = fp ? access.untrust(fp) : null
      if (!r) return false
      for (const hash of r.people) {
        const g = [...guests.values()].find((x) => x.person && x.person.hash === hash)
        if (g) drop(g, 'removed')
      }
      notifyGuests()
      return true
    },
    // The trusted people connected now (their fingerprints).
    trustedOnline: () => new Set([...guests.values()].filter((g) => g.state === 'joined' && g.person && g.person.trust).map((g) => g.person.trust)),

    removeGuest(guestId) {
      const g = guests.get(guestId)
      if (!g) return false
      drop(g, 'removed')
      return true
    },
    // Guests let in who are not connected now (their connection dropped, or
    // they are coming back after a restart): { id: 'k-<key hash>', name,
    // rights, projects, invite, trusted, trustable }.
    offlineGuests() {
      access.forgetOld()
      const on = online()
      return access
        .people()
        .filter((p) => !on.has(p.hash))
        .map((p) => {
          const g = access.grantOf(p)
          const shared = sharedIds()
          const t = access.trustedOf(p)
          return { id: personId(p.hash), name: p.name, rights: cleanRights(g.rights), projects: g.projects.filter((x) => shared.has(x)), invite: access.viaOf(p), trusted: !!t, trustId: t ? trustId(t.fp) : null, trustable: !!p.identity }
        })
    },
    // Removes a guest let in, connected or not (its id from offlineGuests):
    // it can't come back with its reconnect key.
    removeKnown(id) {
      const p = access.personById(id)
      if (!p) return false
      const g = connectionOf(p.hash)
      if (g) drop(g, 'removed')
      access.removePerson(p.hash)
      return true
    },
    // The person a guest in or offline is (for trust and removal).
    personOf(guestId) {
      const subject = subjectOf(guestId)
      return subject && subject.person ? access.person(subject.person) : null
    },
    // To keep across a restart of this Tessel: invitations, codes, people.
    accessState: () => access.toJSON(),
    // The secrets of the invitations that still let new guests in
    // (shareRendezvous.js: where the share says its address for a first join).
    liveCodeSecrets: () => access.liveSecrets(),
    guests: () => [...guests.values()].filter((g) => !inHandshake(g)).map(publicGuest)
  }
}
