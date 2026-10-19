// Live Share phase 2: the request and subscription channel a guest's panels
// use, inside the sealed connection (shareHost.js, shareGuest.js).
//
// A guest asks the host for something about one of its projects (a folder's
// entries, a file, git's status, a change to a task card) with a request,
// and gets one answer:
//   guest -> host  { t: 'req', id, op, project, args }
//   host -> guest  { t: 'res', id, ok: true, data }
//                  { t: 'res', id, ok: false, code, detail? }
//   guest -> host  { t: 'cancel', id }       (it stopped waiting)
// and follows what changes on the host with a subscription, whose news come
// as pushes (the latest wins: a guest far behind gets the latest only):
//   guest -> host  { t: 'sub', topic, project?, key?, on }
//   host -> guest  { t: 'push', topic, project?, key?, seq, data }
//
// Every op and topic belongs to a feature both sides say they speak in the
// sealed join and welcome (shareChat.js SHARE_FEATURES): a guest that did not
// say it gets nothing for it, and a host that does not speak it is an older
// Tessel (its guest says so without asking). What each op needs, and how
// much of the host's work it costs, is the host's table (shareHost.js
// callbacks.opInfo); the checks and budgets are shareHost.js'.
//
// Adding an op: a name `<area>.<verb>` whose area is in OP_AREAS (a new area:
// its feature too), and its entry in the host's table ({ right, kind, bulk });
// the guest calls request(op, project, args). Adding a topic: an entry in
// TOPICS, and the host's watch callback for it (shareHost.js callbacks.watch:
// told when the first guest subscribes and the last one leaves), which sends
// its news with push(topic, project, key, data).
//
// This file is plain data and checks: no network, no Electron.
import { isProjectId } from './shareGrant.js'
import { cleanRel } from '../../shared/liveSharePath'

// The feature each op area needs (an op is `<area>.<verb>`): phase 2b's
// agents.* (panes2: a pane's sub-agents), history.* (history: the task
// history, a file's Local History) and review.* (history: a task branch's
// changes); phase 2c's sessions.* (history: a project's past agent
// conversations and its terminal agents', shareHistory.js); paste.* (paste:
// an image pasted into a pane, sharePaste.js).
export const OP_AREAS = Object.freeze({ fs: 'files', notes: 'files', scm: 'scm', tasks: 'tasks', agents: 'panes2', history: 'history', review: 'history', sessions: 'history', paste: 'paste' })

// Topics a guest subscribes to:
// - feature: what both sides must speak;
// - project: the topic is about one of the guest's projects (else host-wide,
//   like the usage of the next phase);
// - key: what a key is (null: none; 'rel': a file of the project, relative;
//   'id': a pane of the project, by its id);
// - right: the right it needs beyond seeing the project (null: none);
// - max: subscriptions of that topic one guest holds at once;
// - keep: the host keeps the latest news and gives it to a new subscriber
//   at once (a board, a list); without it, only changes go out;
// - perGuest: each guest's subscription is its own stream (the host's
//   callbacks.watchGuest hears each one, and sends to that guest alone with
//   its own messages): a page's frames, made at each guest's pace.
// fs: files of the project changed ({ paths: [rel] | null }: null when too
// many); scm: its git state changed (a hint to read the status again); file:
// a file open in the guest's editor changed ({ exists, size, mtimeMs, sig });
// tasks: the project's task board ({ tasks }); agents: what the project's
// panes run and how they are (model, state, task: sharePanels.js, at most
// once a second); usage: the host's usage (host-wide, with the usage right:
// shareUsage.js); activity: what its agents and teams did and said ({ events,
// teams }, shareActivity.js); page: one of its browser pages, watched (the
// guest's own stream of 'frame' and 'page' messages, sharePageFeed.js; one
// page per guest).
export const TOPICS = Object.freeze({
  fs: Object.freeze({ feature: 'files', project: true, key: null, right: null, max: 16, keep: false }),
  scm: Object.freeze({ feature: 'scm', project: true, key: null, right: null, max: 16, keep: false }),
  file: Object.freeze({ feature: 'files', project: true, key: 'rel', right: null, max: 64, keep: false }),
  tasks: Object.freeze({ feature: 'tasks', project: true, key: null, right: null, max: 16, keep: true }),
  agents: Object.freeze({ feature: 'panes2', project: true, key: null, right: null, max: 16, keep: true }),
  usage: Object.freeze({ feature: 'usage', project: false, key: null, right: 'usage', max: 1, keep: true }),
  activity: Object.freeze({ feature: 'history', project: true, key: null, right: null, max: 16, keep: true }),
  page: Object.freeze({ feature: 'pages', project: true, key: 'id', right: 'pagesView', max: 1, keep: false, perGuest: true })
})

// What one guest may cost the host (shareHost.js), counted per person so a
// new connection does not start from zero.
export const CHANNEL_LIMITS = Object.freeze({
  inFlight: 8, // requests being answered at once
  light: 120, // light requests a minute
  heavy: 12, // heavy ones (searches, status, history, the file list)
  write: 30, // changes
  git: 60, // git runs a request causes by itself (git check-ignore), a minute
  bulkBytes: 16 * 1024 * 1024, // bytes of large answers a minute
  bulkBuffered: 2 * 1024 * 1024, // past this behind, a large answer waits
  bulkQueue: 8, // large answers waiting at once
  pushBuffered: 1024 * 1024, // past this behind, news is held (the latest)
  subs: 128, // subscriptions held at once
  subsPerMinute: 240, // subscription changes a minute
  answerBytes: 12 * 1024 * 1024 // one answer at most (the guest's frame is 64 MB)
})

// What a guest's request names, checked before anything else: a positive
// id, an op `<area>.<verb>` of a known area, a project id, and args as an
// object (each op checks its own). -> { id, op, project, args, feature } |
// null (not a request: ignored).
export function cleanReq(msg) {
  if (!msg || typeof msg !== 'object') return null
  const { id, op, project, args } = msg
  if (!Number.isSafeInteger(id) || id < 1 || id > 2 ** 31) return null
  if (typeof op !== 'string' || !/^[a-z]{2,16}\.[A-Za-z]{2,40}$/.test(op)) return null
  const feature = OP_AREAS[op.slice(0, op.indexOf('.'))]
  if (!feature || !isProjectId(project)) return null
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) return null
  return { id, op, project, args: args || {}, feature }
}

// A request id the guest names to stop waiting for.
export const cleanId = (id) => (Number.isSafeInteger(id) && id >= 1 && id <= 2 ** 31 ? id : null)

// What a guest subscribes to: a known topic, its project when it has one,
// its key when it takes one. -> { topic, project, key, on, spec } | null.
export function cleanSub(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.topic !== 'string' || !Object.hasOwn(TOPICS, msg.topic)) return null
  const spec = TOPICS[msg.topic]
  const project = spec.project ? (isProjectId(msg.project) ? msg.project : null) : null
  if (spec.project && !project) return null
  let key = null
  if (spec.key === 'rel') {
    key = cleanRel(msg.key)
    if (!key) return null
  } else if (spec.key === 'id') {
    if (typeof msg.key !== 'string' || !/^[\w-]{1,80}$/.test(msg.key)) return null
    key = msg.key
  } else if (msg.key !== undefined && msg.key !== null) return null
  return { topic: msg.topic, project, key, on: msg.on === true, spec }
}

// One subscription's name (topic, project, key).
export const subKey = (topic, project, key) => `${topic}\n${project || ''}\n${key || ''}`
export function parseSubKey(k) {
  const [topic, project, key] = String(k).split('\n')
  return { topic, project: project || null, key: key || null }
}
