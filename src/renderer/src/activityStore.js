// The agents' activity log (see src/shared/activity.js for the event shapes
// and the maths). App records events here; the main process keeps them in
// activity.json, saved a moment after each change.
import { reactive, toRaw } from 'vue'
import { MAX_EVENTS, parseActivityText, activityText, mergeSavedActivity, settledBatch } from '../../shared/activity'

export const activity = reactive([])

let loaded = false
let saveTimer = null
// How many of the first events are in the archive already (settled: see
// "Stored in pieces" in shared/activity.js). activity.json holds the rest.
let archived = 0
// The live file's text as last saved: an unchanged log is not sent again.
let lastSaved = null
// Goes up each time old events leave the log (App's indexes of it rebuild).
let trimmed = 0
export const trimCount = () => trimmed

export function recordActivity(event) {
  activity.push({ t: Date.now(), ...event })
  if (activity.length > MAX_EVENTS + 500) {
    const cut = activity.length - MAX_EVENTS
    activity.splice(0, cut)
    archived = Math.max(0, archived - cut)
    trimmed++
  }
  scheduleSave()
}

// An event already in the log was changed in place: save it.
export function activityChanged() {
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
    if (res && typeof res.text === 'string') {
      if (typeof res.archive === 'string' && res.archive) {
        const merged = mergeSavedActivity(res.text, res.archive)
        saved = merged.events
        archived = merged.archived
      } else {
        saved = parseActivityText(res.text)
      }
    }
    if (Array.isArray(saved) && saved.length) activity.splice(0, 0, ...saved)
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
let tail = null
export function saveActivityNow() {
  clearTimeout(saveTimer)
  saveTimer = null
  const p = tail ? tail.then(doSave, doSave) : doSave()
  const mine = p.finally(() => {
    if (tail === mine) tail = null
  })
  tail = mine
  return p
}

async function doSave() {
  const api = window.shellApi.activity
  if (!loaded || !api) return
  try {
    const raw = toRaw(activity)
    // The settled events go to the archive first, a batch at a time; they
    // leave activity.json only once the main process has stored them (a
    // failure keeps them in it, so nothing is lost).
    if (typeof api.archive === 'function') {
      for (;;) {
        const batch = settledBatch(raw, archived)
        if (!batch.length) break
        const res = await api.archive(JSON.stringify(batch))
        if (!res || res.ok !== true) break
        // The log may have been cut at the front meanwhile: counted from the batch's last event.
        const at = raw.lastIndexOf(batch[batch.length - 1])
        archived = at < 0 ? 0 : at + 1
      }
    }
    const text = activityText(raw.slice(archived))
    if (text === lastSaved) return { ok: true, unchanged: true }
    const res = await api.save(text)
    if (res && res.ok !== false) lastSaved = text
    return res
  } catch {
    /* next change saves again */
  }
}
