// The Dashboard tab (AgentDashboard.vue): every agent row (sidebarModel.js
// paneRow, with its project) sorted into five states, filtered, searched and
// grouped by state or by project. Pure functions; the tab renders the result.
import { reactive } from 'vue'

// The order of the groups, the chips and the bar.
export const DASHBOARD_STATES = ['waiting', 'working', 'done', 'idle', 'sleeping']

// Grouping, filter and search of the tab, kept while Tessel runs.
export const dashboardView = reactive({ groupBy: 'status', filter: 'all', query: '' })

// A row's state on the dashboard: asks you (approval, usage limit) >
// working (or monitoring its background work) > done (its turn ended) >
// sleeping > idle (idle, not reporting, a stopped or interrupted chat).
export function dashboardBucket(row) {
  if (row.sleeping) return 'sleeping'
  switch (row.dotState) {
    case 'waiting':
    case 'blocked':
      return 'waiting'
    case 'working':
    case 'monitoring':
      return 'working'
    case 'done':
      return 'done'
  }
  return 'idle'
}

function matches(row, q) {
  if (!q) return true
  return [row.primary, row.subline, row.typeLabel, row.projectName, row.branch, row.title]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(q))
}

// Within a group: the most recent change of state first, then pane order.
function byRecent(a, b) {
  return (b.since || 0) - (a.since || 0) || (a.num || 0) - (b.num || 0)
}

// rows: paneRow(...) + { projectId, projectName, branch }.
// -> { counts: { state: n } (every row, before filter and search),
//      groups: [{ key, label, rows }] (filtered, searched) }; each row gets
//      its bucket.
export function buildDashboard(rows, { filter = 'all', query = '', groupBy = 'status' } = {}) {
  const counts = Object.fromEntries(DASHBOARD_STATES.map((s) => [s, 0]))
  const all = (rows || []).map((r) => ({ ...r, bucket: dashboardBucket(r) }))
  for (const r of all) counts[r.bucket]++
  const q = String(query || '').trim().toLowerCase()
  const shown = all.filter((r) => (filter === 'all' || r.bucket === filter) && matches(r, q))
  let groups
  if (groupBy === 'project') {
    const map = new Map()
    for (const r of shown) {
      const key = r.projectId || ''
      if (!map.has(key)) map.set(key, { key: 'project-' + key, label: r.projectName || '', rows: [] })
      map.get(key).rows.push(r)
    }
    const order = (r) => DASHBOARD_STATES.indexOf(r.bucket)
    groups = [...map.values()]
    for (const g of groups) g.rows.sort((a, b) => order(a) - order(b) || byRecent(a, b))
  } else {
    groups = DASHBOARD_STATES.map((s) => ({ key: s, label: s, rows: shown.filter((r) => r.bucket === s).sort(byRecent) })).filter(
      (g) => g.rows.length
    )
  }
  return { counts, groups }
}
