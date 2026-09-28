// The agents' activity log (see src/shared/activity.js for the event shapes
// and the maths). App records events here; the main process keeps them in
// activity.json, saved a moment after each change.
import { reactive, toRaw } from 'vue'
import { MAX_EVENTS } from '../../shared/activity'

export const activity = reactive([])

let loaded = false
let saveTimer = null

export function recordActivity(event) {
  activity.push({ t: Date.now(), ...event })
  if (activity.length > MAX_EVENTS + 500) activity.splice(0, activity.length - MAX_EVENTS)
  scheduleSave()
}

// An event already in the log was changed in place: save it.
export function activityChanged() {
  scheduleSave()
}

// Events recorded before the saved log finished loading are kept after it.
export async function loadActivity() {
  try {
    const saved = window.shellApi.activity ? await window.shellApi.activity.load() : []
    if (Array.isArray(saved) && saved.length) activity.splice(0, 0, ...saved)
  } catch {
    /* start with what is recorded from now on */
  }
  loaded = true
  if (activity.length) scheduleSave()
}

// The whole log (up to MAX_EVENTS) is copied and written at each save, which
// freezes the window a moment: at most one save every SAVE_EVERY_MS while
// agents work (a change never pushes the pending save back); closing or
// reloading the window saves at once (App's flushSaves).
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
    // The plain array behind the Vue proxy goes to IPC as is (no JSON copy of
    // the whole log first); JSON only if something in it cannot be cloned.
    let res
    try {
      res = await window.shellApi.activity.save(toRaw(activity))
    } catch {
      res = await window.shellApi.activity.save(JSON.parse(JSON.stringify(activity)))
    }
    return res
  } catch {
    /* next change saves again */
  }
}
