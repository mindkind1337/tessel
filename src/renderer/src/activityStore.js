// The agents' activity log (see src/shared/activity.js for the event shapes
// and the maths). App records events here; the main process keeps them in
// activity.json, saved a moment after each change.
import { reactive, toRaw } from 'vue'
import { MAX_EVENTS, parseActivityText, activityText } from '../../shared/activity'

export const activity = reactive([])

let loaded = false
let saveTimer = null
// Goes up each time old events leave the log (App's indexes of it rebuild).
let trimmed = 0
export const trimCount = () => trimmed

export function recordActivity(event) {
  activity.push({ t: Date.now(), ...event })
  if (activity.length > MAX_EVENTS + 500) {
    activity.splice(0, activity.length - MAX_EVENTS)
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
export async function loadActivity() {
  try {
    const res = window.shellApi.activity ? await window.shellApi.activity.load({ text: true }) : []
    const saved = res && typeof res.text === 'string' ? parseActivityText(res.text) : res
    if (Array.isArray(saved) && saved.length) activity.splice(0, 0, ...saved)
  } catch {
    /* start with what is recorded from now on */
  }
  loaded = true
  if (activity.length) scheduleSave()
}

// The whole log (up to MAX_EVENTS) is written at each save: at most one save
// every SAVE_EVERY_MS while agents work (a change never pushes the pending
// save back); closing or reloading the window saves at once (App's
// flushSaves). It goes as JSON text: copying thousands of objects to the main
// process froze the window each time.
export const SAVE_EVERY_MS = 15000
function scheduleSave() {
  if (!loaded || !window.shellApi.activity) return
  if (saveTimer) return
  saveTimer = setTimeout(saveActivityNow, SAVE_EVERY_MS)
}

export async function saveActivityNow() {
  clearTimeout(saveTimer)
  saveTimer = null
  if (!loaded || !window.shellApi.activity) return
  try {
    return await window.shellApi.activity.save(activityText(toRaw(activity)))
  } catch {
    /* next change saves again */
  }
}
