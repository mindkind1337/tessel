// The agents' activity log (see src/shared/activity.js for the event shapes
// and the maths). App records events here; the main process keeps them in
// activity.json, saved a moment after each change.
import { reactive, toRaw } from 'vue'
import { MAX_EVENTS, ARCHIVE_BATCH, SETTLE_MS, parseActivityText, activityText, mergeSavedActivity, messageId } from '../../shared/activity'

export const activity = reactive([])

let loaded = false
let saveTimer = null
// The events the archive holds (settled: see "Stored in pieces" in
// shared/activity.js), as the objects of the log: activity.json holds the
// others. Known event by event, not as "the first n": the log is not in the
// order the events were recorded (a team message is logged with the time it
// was sent, a log read back is sorted by time), and counting a prefix sent
// thousands of archived events to the archive again at each start.
const inArchive = new WeakSet()
// When an event was recorded or last changed in this window: it settles
// SETTLE_MS after that as well as after its own time, so a message logged
// long after it was sent can still be marked read in activity.json.
const touchedAt = new WeakMap()
// The live file's text as last saved: an unchanged log is not sent again.
let lastSaved = null
// Goes up each time old events leave the log (App's indexes of it rebuild).
let trimmed = 0
export const trimCount = () => trimmed

export function recordActivity(event) {
  const e = { t: Date.now(), ...event }
  touchedAt.set(e, Date.now())
  activity.push(e)
  if (activity.length > MAX_EVENTS + 500) trimLog()
  scheduleSave()
}

// Back to MAX_EVENTS: the first ones go (the oldest), those the archive holds
// first; the others are only in activity.json and would be lost.
function trimLog() {
  const raw = toRaw(activity)
  let over = raw.length - MAX_EVENTS
  let kept = raw.filter((e) => {
    if (over > 0 && inArchive.has(e)) {
      over--
      return false
    }
    return true
  })
  if (over > 0) kept = kept.slice(over)
  activity.splice(0, activity.length, ...kept)
  trimmed++
}

// Events already in the log were changed in place: save them. A team message
// the archive holds already (read long after it was logged) is stored again,
// read (the archive keeps each message once per status, and reading it back
// keeps the read copy).
export function activityChanged(...events) {
  const now = Date.now()
  for (const ev of events) {
    const e = ev && typeof ev === 'object' ? toRaw(ev) : null
    if (!e) continue
    if (inArchive.has(e)) {
      if (!messageId(e)) continue
      inArchive.delete(e)
    }
    touchedAt.set(e, now)
  }
  scheduleSave()
}

// Events recorded before the saved log finished loading are kept after it.
// The log comes as JSON text (a string crosses from the main process at once;
// thousands of objects took a third of a second to copy) and is checked here.
// Loaded once per window: a second call (App's start run again by a hot
// reload in development) gets the first one's result, it does not put the
// saved log in front of the log a second time.
let loading = null
export function loadActivity() {
  if (!loading) loading = readSavedActivity()
  return loading
}
async function readSavedActivity() {
  try {
    const res = window.shellApi.activity ? await window.shellApi.activity.load({ text: true }) : []
    let saved = res
    let archivedOnes = null
    if (res && typeof res.text === 'string') {
      if (typeof res.archive === 'string' && res.archive) {
        const merged = mergeSavedActivity(res.text, res.archive)
        saved = merged.events
        archivedOnes = merged.inArchive
      } else {
        saved = parseActivityText(res.text)
      }
    }
    if (Array.isArray(saved) && saved.length) {
      if (archivedOnes) for (const e of archivedOnes) inArchive.add(e)
      activity.splice(0, 0, ...saved)
    }
  } catch {
    /* start with what is recorded from now on */
  }
  loaded = true
  if (activity.length) scheduleSave()
}

// The recent events are written at each save (the settled ones are appended
// to the archive once, see doSave): at most one save every SAVE_EVERY_MS
// while agents work (a change never pushes the pending save back); closing
// or reloading the window saves at once (App's flushSaves). It goes as JSON
// text: copying thousands of objects to the main process froze the window
// each time.
export const SAVE_EVERY_MS = 15000
function scheduleSave() {
  if (!loaded || !window.shellApi.activity) return
  if (saveTimer) return
  saveTimer = setTimeout(saveActivityNow, SAVE_EVERY_MS)
}

// One save at a time (the timer's and a closing window's would otherwise
// archive the same events twice). Started at once when none is running.
// closing: the window is going away (closing, reloading, installing an
// update): the recent events are sent first, at once and without waiting for
// a save in progress, the archive is left for the next start. A save that
// waited for the archive could be cut off before it sent anything.
let tail = null
export function saveActivityNow(opts = {}) {
  clearTimeout(saveTimer)
  saveTimer = null
  if (opts && opts.closing) return doSave({ closing: true })
  const run = () => doSave({})
  const p = tail ? tail.then(run, run) : doSave({})
  const mine = p.finally(() => {
    if (tail === mine) tail = null
  })
  tail = mine
  return p
}

const settled = (e, now) => now - Math.max(e.t, touchedAt.get(e) || 0) >= SETTLE_MS

async function doSave({ closing = false } = {}) {
  const api = window.shellApi.activity
  if (!loaded || !api) return
  try {
    const raw = toRaw(activity)
    // The settled events go to the archive first, a batch at a time; they
    // leave activity.json only once the main process has stored them (a
    // failure keeps them in it, so nothing is lost; the archive ignores an
    // event it holds already, so sending one twice stores it once).
    if (!closing && typeof api.archive === 'function') {
      const now = Date.now()
      const due = raw.filter((e) => !inArchive.has(e) && settled(e, now))
      for (let i = 0; i < due.length; i += ARCHIVE_BATCH) {
        const batch = due.slice(i, i + ARCHIVE_BATCH)
        const res = await api.archive(JSON.stringify(batch))
        if (!res || res.ok !== true) break
        for (const e of batch) inArchive.add(e)
      }
    }
    const text = activityText(raw.filter((e) => !inArchive.has(e)))
    if (text === lastSaved) return { ok: true, unchanged: true }
    const res = await api.save(text)
    if (res && res.ok !== false) lastSaved = text
    return res
  } catch {
    /* next change saves again */
  }
}
