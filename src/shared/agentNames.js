// Persistent human addresses, independent of the agent program and conversation.
export const AGENT_NAMES = Object.freeze([
  'Ada', 'Bohr', 'Curie', 'Darwin', 'Euler', 'Fermi', 'Gauss', 'Hopper',
  'Kepler', 'Lovelace', 'Noether', 'Turing', 'Archimedes', 'Babbage', 'Bell',
  'Bose', 'Boyle', 'Brahe', 'Carson', 'Cavendish', 'Chadwick', 'Clarke',
  'Copernicus', 'Crick', 'Dalton', 'Dirac', 'Edison', 'Einstein', 'Euclid',
  'Faraday', 'Feynman', 'Fibonacci', 'Fleming', 'Franklin', 'Galileo',
  'Goodall', 'Halley', 'Hamilton', 'Hardy', 'Hawking', 'Herschel', 'Hilbert',
  'Hubble', 'Hypatia', 'Joule', 'Katherine', 'Lagrange', 'Lamarck', 'Laplace',
  'Leibniz', 'Lise', 'Lorentz', 'Maxwell', 'Mendel', 'Newton', 'Nobel',
  'Ohm', 'Pascal', 'Pasteur', 'Planck', 'Poincare', 'Ramanujan', 'Rosalind',
  'Rutherford', 'Sagan', 'Shannon', 'Tesla', 'Vera', 'Volta', 'Watt', 'Wu'
])

export const isNamedAgent = (pane) => !!pane && (pane.kind === 'agent' || pane.kind === 'chat')
export const nameKey = (value) => String(value || '').trim().toLowerCase()
export function agentProgramLabel(pane, agents = []) {
  return agents.find((agent) => agent.id === pane.agentId)?.name || pane.agentId || pane.title || ''
}
export function validAgentName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 &&
    !/[\r\n\t\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>/\\]/.test(value) && !/^(?:#|@|\d+$)/.test(value.trim()) &&
    !['team', 'all', 'tessel'].includes(nameKey(value))
}
export function nextAgentName(used) {
  for (let suffix = 1; ; suffix++) {
    for (const base of AGENT_NAMES) {
      const name = suffix === 1 ? base : `${base} ${suffix}`
      if (!used.has(nameKey(name))) return name
    }
  }
}
export function ensureAgentNames(panes) {
  for (const pane of panes) if (!isNamedAgent(pane) && pane.paneName) delete pane.paneName
  const agents = panes.filter(isNamedAgent)
  const used = new Set()
  const missing = []
  for (const pane of agents) {
    const key = nameKey(pane.paneName)
    if (validAgentName(pane.paneName) && !used.has(key)) used.add(key)
    else missing.push(pane)
  }
  for (const pane of missing) {
    pane.paneName = nextAgentName(used)
    used.add(nameKey(pane.paneName))
  }
}
export function renameAgentName(panes, id, name) {
  const pane = panes.find((p) => p.id === id && isNamedAgent(p))
  if (!pane || !validAgentName(name)) return 'invalid'
  if (panes.some((p) => p.id !== id && isNamedAgent(p) && nameKey(p.paneName) === nameKey(name))) return 'taken'
  pane.paneName = name.trim()
  return null
}
export function resolveAgentAddress(panes, value) {
  const address = String(value || '').trim()
  const legacy = /^#(\d+)$/.exec(address)
  const matches = panes.filter((p) => legacy ? p.num === Number(legacy[1]) : nameKey(p.paneName) === nameKey(address))
  return matches.length === 1 ? matches[0] : null
}
