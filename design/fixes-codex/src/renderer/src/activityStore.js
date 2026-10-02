// The agents' activity log (see src/shared/activity.js for the event shapes
// and the maths). App records events here; the main process keeps them in
// activity.json, saved a moment after each change.
import { reactive } from 'vue'
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

function scheduleSave() {
  if (!loaded || !window.shellApi.activity) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveActivityNow, 1500)
}

export async function saveActivityNow() {
  clearTimeout(saveTimer)
  saveTimer = null
  if (!loaded || !window.shellApi.activity) return
  try {
    // Plain objects for IPC (the entries are Vue proxies).
    await window.shellApi.activity.save(JSON.parse(JSON.stringify(activity)))
  } catch {
    /* next change saves again */
  }
}
