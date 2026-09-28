// The status bar's pure logic, ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): resource-usage-metrics.tsx (formatMemory / formatCpu),
// agent-awake-copy.ts, the Resource Manager tree and the Ports summary.

export function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatCpu(percent) {
  return Number.isFinite(percent) ? `${percent.toFixed(1)}%` : '—'
}

// Tessel's keepAwake ('on' | 'agents' | 'off') with Orca's words.
const MODE_LABELS = { on: 'On', agents: 'Agent', off: 'Off' }
export function awakeCopy(mode, active) {
  const modeLabel = MODE_LABELS[mode] || 'Off'
  const statusText = `${modeLabel} · ${active ? 'Active' : 'Inactive'}`
  return { title: 'Keep computer awake', modeLabel, statusText, ariaLabel: `Keep computer awake, ${statusText}` }
}

// snapshot + terminals ([{ id, label, group, groupKey }]) -> groups of
// sessions per workspace, sorted like Orca's popover (memory by default).
export function resourceTree(snapshot, terminals, sortBy = 'memory') {
  const groups = new Map()
  for (const t of terminals || []) {
    const s = snapshot && snapshot.sessions ? snapshot.sessions[t.id] : null
    const key = t.groupKey || t.group || 'Terminals'
    if (!groups.has(key)) groups.set(key, { key, name: t.group || 'Terminals', cpu: 0, memory: 0, sessions: [] })
    const g = groups.get(key)
    const session = { id: t.id, label: t.label, bound: !!s, cpu: s ? s.cpu : 0, memory: s ? s.memory : 0 }
    g.sessions.push(session)
    g.cpu += session.cpu
    g.memory += session.memory
  }
  const cmp = (a, b) =>
    sortBy === 'name'
      ? (a.name || a.label).localeCompare(b.name || b.label)
      : sortBy === 'cpu'
        ? b.cpu - a.cpu
        : b.memory - a.memory
  const list = [...groups.values()]
  for (const g of list) g.sessions.sort(cmp)
  list.sort(cmp)
  const app = snapshot && snapshot.app
  return {
    groups: list,
    app: app
      ? [
          { key: 'main', label: 'Main', ...app.main },
          { key: 'renderer', label: 'Renderer', ...app.renderer },
          ...(app.other && app.other.memory > 0 ? [{ key: 'other', label: 'Other', ...app.other }] : [])
        ]
      : []
  }
}

// The Ports segment's numbers: workspace ports (shown), external ones.
export function portsSummary(groups, external) {
  const withPorts = (groups || []).filter((g) => g.ports && g.ports.length)
  const workspaceCount = withPorts.reduce((n, g) => n + g.ports.length, 0)
  const externalCount = (external || []).length
  return { groups: withPorts, workspaceCount, externalCount, totalCount: workspaceCount + externalCount }
}
