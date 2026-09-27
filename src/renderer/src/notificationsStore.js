// The notification inbox (toolbar bell): what needed you, kept after its toast
// or Windows notification is gone. Read / unread per entry; opening its pane
// marks it read. Kept in this window's storage (a convenience: an empty inbox
// is fine), at most 100 entries.
import { reactive, computed } from 'vue'

const KEY = 'tessel.notifications'
const MAX = 100

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list.filter((n) => n && typeof n.id === 'string' && typeof n.title === 'string').slice(0, MAX) : []
  } catch {
    return []
  }
}

export const notifications = reactive(load())
export const unreadCount = computed(() => notifications.filter((n) => !n.read).length)

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(notifications.slice(0, MAX)))
  } catch {
    // storage full or blocked: the inbox lives for this session
  }
}

// { kind: 'done'|'limit'|'alert', title, body, paneId } -> the entry. The same
// pane and kind within 5 s is one entry (a burst is not several).
export function addNotification({ kind = 'info', title, body = '', paneId = null } = {}) {
  if (!title) return null
  const now = Date.now()
  const same = notifications.find((n) => n.paneId === paneId && n.kind === kind && now - n.at < 5000)
  if (same) {
    Object.assign(same, { title, body, at: now, read: false })
    save()
    return same
  }
  const entry = { id: `n-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind, title, body, paneId, at: now, read: false }
  notifications.unshift(entry)
  if (notifications.length > MAX) notifications.splice(MAX)
  save()
  return entry
}

export function setRead(id, read = true) {
  const n = notifications.find((x) => x.id === id)
  if (n && n.read !== read) {
    n.read = read
    save()
  }
}

// Opening a pane: its entries are read.
export function readForPane(paneId) {
  let changed = false
  for (const n of notifications) {
    if (n.paneId === paneId && !n.read) {
      n.read = true
      changed = true
    }
  }
  if (changed) save()
}

export function markAllRead() {
  for (const n of notifications) n.read = true
  save()
}

export function clearNotifications() {
  notifications.splice(0)
  save()
}

// A short sound for a new entry (Settings > Agent alerts), made here: no file.
export function playAlertSound(kind) {
  if (!kind || kind === 'none') return
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ac = new Ctx()
    const notes = kind === 'ping' ? [[1320, 0, 0.12]] : [[880, 0, 0.12], [1175, 0.11, 0.18]]
    for (const [freq, start, len] of notes) {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ac.currentTime + start)
      gain.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + start + len)
      osc.connect(gain).connect(ac.destination)
      osc.start(ac.currentTime + start)
      osc.stop(ac.currentTime + start + len + 0.02)
    }
    setTimeout(() => ac.close().catch(() => {}), 1000)
  } catch {
    // no sound available
  }
}
