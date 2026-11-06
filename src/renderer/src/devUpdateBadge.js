// The toolbar's yellow update badge: shown for new builds, and after an update
// only when a restart is really needed. When only the window's code changed, it
// has already reloaded and there is nothing left to do (DevUpdateDialog.vue says
// the same).
export function devUpdateBadgeShown(status) {
  const s = status || {}
  if (s.state === 'available') return true
  return s.state === 'updated' && (!!s.depsChanged || s.mainChanged !== false)
}
