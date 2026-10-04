import { t } from './i18n'

// A team as a short mark: "Team 2" -> "2"; a team named otherwise: its
// first two letters. Shown at the far left of its agents' rows and panes.
export function teamNumber(name) {
  const label = String(name || '').trim()
  const n = /(\d+)\s*$/.exec(label)
  return n ? n[1] : label.slice(0, 2)
}

// Every team shows its own number, across all workspaces: a later team
// whose number another already shows (e.g. "Team 2" and "Équipe 2") is
// renamed to the next free "Team N" (in the app's language). A team still
// under its default name ("Team 2", "Équipe 2") shows it in the app's
// current language; a name the user gave is kept. Nothing to change: the
// same list back.
export function dedupeTeamNumbers(list) {
  const numberOf = (name) => (/(\d+)\s*$/.exec(String(name || '')) || [])[1] || null
  const defaultName = (n) => t('app.team.defaultName', 'Team {{n}}', { n })
  const taken = new Set()
  const out = []
  let changed = false
  for (const raw of list) {
    const dflt = /^\s*(?:team|[ée]quipe)\s+(\d+)\s*$/i.exec(String(raw.name || ''))
    const localName = dflt ? defaultName(Number(dflt[1])) : null
    const team = localName && localName !== raw.name ? { ...raw, name: localName } : raw
    const n = numberOf(team.name)
    if (!n || !taken.has(n)) {
      if (n) taken.add(n)
      if (team !== raw) changed = true
      out.push(team)
      continue
    }
    let i = 1
    while (taken.has(String(i))) i++
    taken.add(String(i))
    changed = true
    out.push({ ...team, name: defaultName(i) })
  }
  return changed ? out : list
}
