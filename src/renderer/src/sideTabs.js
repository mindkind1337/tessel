// The right side panel's own tabs (SidePanel.vue), in their order, and the
// tab a saved layout opens on (App.vue). One list for both, so a new tab
// is restored like the others.
export const SIDE_TABS = ['dashboard', 'files', 'changes', 'tasks', 'taskHistory', 'history']

// The saved tab -> the tab to show, or null to keep the default. A web page
// tab that is gone opens the Dashboard.
export function restoredSideTab(saved, browsers = []) {
  if (typeof saved !== 'string' || !saved) return null
  if (SIDE_TABS.includes(saved) || (browsers || []).some((b) => b && b.id === saved)) return saved
  if (saved.startsWith('web-')) return 'dashboard'
  return null
}
