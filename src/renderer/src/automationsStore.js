// The window's copy of the scheduled automations (the main process keeps
// them: src/main/automations.js). Updated from every change it announces;
// the page (AutomationsPage.vue) calls the actions below.
import { reactive } from 'vue'

export const automationsState = reactive({
  loaded: false,
  error: null,
  automations: [],
  runs: [],
  settings: { maxConcurrent: 2 }
})

function api() {
  return typeof window !== 'undefined' && window.shellApi ? window.shellApi.automations || null : null
}

export function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return
  automationsState.loaded = snap.loaded !== false
  automationsState.error = snap.error || null
  automationsState.automations = Array.isArray(snap.automations) ? snap.automations : []
  automationsState.runs = Array.isArray(snap.runs) ? snap.runs : []
  if (snap.settings) automationsState.settings = { ...snap.settings }
}

export async function loadAutomations() {
  const a = api()
  if (!a) return
  try {
    applySnapshot(await a.list())
  } catch {
    // shown as not loaded
  }
}

let off = null
export function subscribeAutomations() {
  const a = api()
  if (!a || off) return () => {}
  off = a.onChanged(applySnapshot)
  return () => {
    if (off) off()
    off = null
  }
}

// Each action -> { ok, ... } or { ok: false, code, error } (the main
// process's words, in the interface's language).
async function call(name, ...args) {
  const a = api()
  if (!a || typeof a[name] !== 'function') return { ok: false, code: 'unavailable', error: '' }
  try {
    const res = await a[name](...args)
    return res || { ok: false, code: 'unavailable', error: '' }
  } catch (err) {
    return { ok: false, code: 'unavailable', error: (err && err.message) || '' }
  }
}

export const createAutomation = (input) => call('create', input)
export const updateAutomation = (id, input) => call('update', id, input)
export const setAutomationEnabled = (id, enabled, confirmed = false) => call('setEnabled', id, enabled, confirmed)
export const removeAutomation = (id) => call('remove', id)
export const runAutomationNow = (id, confirmed = false) => call('runNow', id, confirmed)
export const setAutomationSettings = (patch) => call('setSettings', patch)

export function runsOf(automationId) {
  return automationsState.runs.filter((r) => r.automationId === automationId)
}
