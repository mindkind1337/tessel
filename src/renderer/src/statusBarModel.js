// The status bar's pure logic, ported from Orca (MIT, Copyright (c) 2026
// Lovecast Inc.): resource-usage-metrics.tsx (formatMemory / formatCpu),
// agent-awake-copy.ts, the Resource Manager tree and the Ports summary.

import { t, intlLocale } from './i18n'

function fixed(value, digits) {
  return new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false
  }).format(value)
}

export function formatMemory(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes < 1024 * 1024) return t('statusBar.units.kb', '{{value}} KB', { value: fixed(bytes / 1024, 0) })
  if (bytes < 1024 * 1024 * 1024)
    return t('statusBar.units.mb', '{{value}} MB', { value: fixed(bytes / (1024 * 1024), 1) })
  return t('statusBar.units.gb', '{{value}} GB', { value: fixed(bytes / (1024 * 1024 * 1024), 2) })
}

export function formatCpu(percent) {
  return Number.isFinite(percent) ? t('statusBar.units.percent', '{{value}}%', { value: fixed(percent, 1) }) : '—'
}

// Tessel's keepAwake ('on' | 'agents' | 'off') with Orca's words.
function modeLabelFor(mode) {
  if (mode === 'on') return t('statusBar.awake.on', 'On')
  if (mode === 'agents') return t('statusBar.awake.agent', 'Agent')
  return t('statusBar.awake.off', 'Off')
}
export function awakeCopy(mode, active) {
  const modeLabel = modeLabelFor(mode)
  const statusText = t('statusBar.awake.status', '{{mode}} · {{state}}', {
    mode: modeLabel,
    state: active ? t('statusBar.awake.active', 'Active') : t('statusBar.awake.inactive', 'Inactive')
  })
  const title = t('statusBar.awake.title', 'Keep computer awake')
  return {
    title,
    modeLabel,
    statusText,
    ariaLabel: t('statusBar.awake.ariaLabel', '{{title}}, {{status}}', { title, status: statusText })
  }
}

// snapshot + terminals ([{ id, label, group, groupKey }]) -> groups of
// sessions per workspace, sorted like Orca's popover (memory by default).
export function resourceTree(snapshot, terminals, sortBy = 'memory') {
  const groups = new Map()
  for (const term of terminals || []) {
    const s = snapshot && snapshot.sessions ? snapshot.sessions[term.id] : null
    const key = term.groupKey || term.group || 'Terminals' // i18n-ignore
    if (!groups.has(key))
      groups.set(key, {
        key,
        name: term.group || t('statusBar.resources.terminals', 'Terminals'),
        cpu: 0,
        memory: 0,
        sessions: []
      })
    const g = groups.get(key)
    const session = { id: term.id, label: term.label, bound: !!s, cpu: s ? s.cpu : 0, memory: s ? s.memory : 0 }
    g.sessions.push(session)
    g.cpu += session.cpu
    g.memory += session.memory
  }
  const cmp = (a, b) =>
    sortBy === 'name'
      ? (a.name || a.label).localeCompare(b.name || b.label, intlLocale())
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
          { key: 'main', label: t('statusBar.resources.main', 'Main'), ...app.main },
          { key: 'renderer', label: t('statusBar.resources.renderer', 'Renderer'), ...app.renderer },
          ...(app.other && app.other.memory > 0
            ? [{ key: 'other', label: t('statusBar.resources.other', 'Other'), ...app.other }]
            : [])
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
