// Settings > Context: what each agent loads into its context before the
// user types anything, and what it costs in tokens, so the user sees why an
// agent starts heavy and what to turn off:
//   rules     its rules and memory files (rulesFiles.js);
//   skills    each skill's name and description, which the agent lists up
//             front (its SKILL.md is read only when the skill is used);
//   mcp       each MCP server's tool definitions, in every conversation,
//             once measured (starting the server is a click: Measure);
//   tessel    Tessel's team tools (their instructions and definitions) and
//             its task board rule in the memory file.
// Not counted: the agent's own system prompt and built-in tools.
// Counting (counts.js) runs in its own process or, for models with no public
// tokenizer, through the provider's count API, only on view or click, and
// only the agent's own provider's API (a model named in a repository's
// settings never sends that repository's rules to another provider).
// A pane card's hover (kept: true) starts no process: it uses the server
// lists the last page view read, and counts only what is kept or local.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { tokenCounterFor, TOKENIZERS } from '../../shared/tokenCounters'
import { readRules, createFileReader, findGitRoot, readBudget, RULE_AGENTS } from './rulesFiles'
import { TOKENIZER_FILES } from './catalog'
import { ollamaName, ollamaCounter } from './ollama'
import { approvalsFrom, approvalSources, mcpApprovalState } from './mcpApproval'

export const CONTEXT_AGENTS = RULE_AGENTS
export const TEAM_SERVER = 'tessel_team'
// (An agent not set up again yet still has its former name.)
const isTeamServer = (name) => name === TEAM_SERVER || name === 'tessel_apps' || name === 'tessel-team'
const MCP_RECORD_LIMIT = 2 * 1024 * 1024
const LIST_TTL_MS = 60 * 1000
// A kept MCP measurement older than this is deleted (a server or config gone).
export const MCP_RECORD_MAX_AGE_MS = 30 * 24 * 3600 * 1000
const MCP_SWEEP_EVERY_MS = 3600 * 1000

// The provider each agent signs in with: the only count API its text may go
// to. The others count locally or are estimated.
export const AGENT_PROVIDERS = Object.freeze({ claude: 'anthropic', codex: 'openai', gemini: 'google', antigravity: 'google' })
export function ownProviderOnly(agent, counter) {
  if (!counter || counter.kind !== 'api' || counter.api === 'ollama' || AGENT_PROVIDERS[agent] === counter.api) return counter
  return { ...counter, noRemote: 'otherProvider' }
}

const sha = (text) => createHash('sha256').update(text).digest('hex')
// A tool name an API takes: letters, digits, _ and -, 64 at most.
const toolName = (name) => String(name || 'tool').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool'

// A server's tools as the agent presents them (Claude Code names them
// mcp__<server>__<tool>), in the shape the counters take.
export function shapeTools(server, defs, agent) {
  const seen = new Set()
  return (defs || []).map((d, i) => {
    let name = toolName(agent === 'claude' ? `mcp__${server}__${d.name}` : d.name)
    if (seen.has(name)) name = toolName(`${name.slice(0, 58)}_${i}`)
    seen.add(name)
    const schema = d.inputSchema && typeof d.inputSchema === 'object' ? d.inputSchema : { type: 'object', properties: {} }
    return { name, description: String(d.description || ''), input_schema: schema.type ? schema : { type: 'object', ...schema } }
  })
}

// The line an agent lists a skill with.
export const skillLine = (skill) => `- ${skill.name}: ${skill.description || ''}`.trimEnd()

// The MCP servers listMcp found for an agent (agentTools.js), loaded ones.
export function agentServers(listed, agent) {
  if (!listed) return []
  const list = agent === 'claude' ? listed.claude : agent === 'codex' ? listed.codex : listed.others && listed.others[agent] && listed.others[agent].servers
  return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.name === 'string')
}

// The totals of one agent's items (counted ones). -> { total, groups: { rules,
// skills, mcp, tessel }, exact: 'all' | 'some' | 'none', optional, pending }
export function summarize(items) {
  const groups = { rules: 0, skills: 0, mcp: 0, tessel: 0 }
  let total = 0
  let exactCount = 0
  let counted = 0
  let optional = 0
  let pending = 0
  for (const item of items) {
    if (!item.loaded) continue
    if (!item.result) {
      pending++
      continue
    }
    const n = item.result.tokens || 0
    groups[item.group] = (groups[item.group] || 0) + n
    total += n
    counted++
    if (item.result.exact) exactCount++
    if (item.optional) optional += n
  }
  return { total, groups, optional, pending, exact: !counted ? 'none' : exactCount === counted ? 'all' : exactCount ? 'some' : 'none' }
}

export function createContextCost({
  userData,
  counter,
  worker,
  files,
  apis = {},
  listSkills,
  listMcp,
  testMcp,
  agentModel = () => null,
  claudeDir = async () => null,
  // (cwd, claudeDir) -> settings objects that may approve project servers
  // (mcpApproval.js approvalSources).
  mcpApprovals = (cwd, dir) => approvalSources({ cwd, home, claudeDir: dir }),
  // A skill about to be added, as the main process holds it (skillsManager.js
  // getPackage): { name, description, skillMd }.
  getPackage = () => null,
  home = os.homedir(),
  env = () => process.env,
  request = globalThis.fetch,
  clock = Date.now,
  log = null
}) {
  const reader = createFileReader()
  // The skill and server lists, read again after LIST_TTL_MS or when counting
  // over the network (a page opened, a click). kept: only a list already
  // read (any age), never a new read of the servers (it starts processes).
  const lists = new Map() // `${kind}|${cwd}` -> { at, promise }
  function listed(kind, cwd, mode, read) {
    const key = `${kind}|${cwd || ''}`
    const seen = lists.get(key)
    if (mode === 'kept') return seen ? seen.promise : Promise.resolve(null)
    if (mode !== 'fresh' && seen && clock() - seen.at < LIST_TTL_MS) return seen.promise
    const promise = Promise.resolve()
      .then(read)
      .catch(() => null)
    lists.set(key, { at: clock(), promise })
    return promise
  }
  const skillsOf = (cwd, mode) => listed('skills', cwd, mode === 'kept' ? 'cached' : mode, () => listSkills({ cwd })).then((r) => (r && r.skills) || [])
  const mcpOf = (cwd, mode) => listed('mcp', cwd, mode, () => listMcp(cwd))
  const mcpDir = path.join(userData, 'context-cost', 'mcp')
  let tessel = null // { instructions, tools } from the counting process
  let swept = 0

  async function tesselContext() {
    if (tessel) return tessel
    const reply = await worker.request({ op: 'tessel' })
    if (reply && reply.tessel) tessel = reply.tessel
    return tessel
  }

  // A measurement is kept by agent, scope, name (and project, for a project
  // or local server), with the server's command or URL inside: a server
  // whose command changed since is shown as not measured.
  const mcpKey = (agent, s, cwd) => sha(JSON.stringify([agent, s.scope || 'user', s.name, (s.scope || 'user') === 'user' ? '' : String(cwd || '').toLowerCase()]))
  async function mcpRecord(agent, s, cwd) {
    try {
      const record = JSON.parse(await fs.readFile(path.join(mcpDir, `${mcpKey(agent, s, cwd)}.json`), 'utf8'))
      if (!record || !Number.isFinite(record.at) || clock() - record.at >= MCP_RECORD_MAX_AGE_MS) return null
      if (s.target !== undefined && record.target !== undefined && record.target !== String(s.target || '')) return null
      return record
    } catch {
      return null
    }
  }
  // Old measurements go (at most once an hour, on a page view).
  async function sweepRecords() {
    if (clock() - swept < MCP_SWEEP_EVERY_MS) return
    swept = clock()
    let names
    try {
      names = (await fs.readdir(mcpDir)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
    } catch {
      return
    }
    for (const name of names) {
      const file = path.join(mcpDir, name)
      try {
        const record = JSON.parse(await fs.readFile(file, 'utf8'))
        if (record && Number.isFinite(record.at) && clock() - record.at < MCP_RECORD_MAX_AGE_MS) continue
      } catch {
        // unreadable: dropped too
      }
      await fs.rm(file, { force: true }).catch(() => {})
    }
  }

  const modelOf = (agent, cwd, given) => {
    if (typeof given === 'string' && given) return given
    try {
      const found = agentModel({ agentId: agent, cwd })
      return found && found.model ? found.model : null
    } catch {
      return null
    }
  }

  // The counter for an agent's model, its own provider's API only; an Ollama
  // model tokenCounters.js does not place is asked about (ollama.js, not when
  // kept), else Ollama counts it itself.
  async function resolveCounter(agent, model, { kept = false } = {}) {
    const base = ownProviderOnly(agent, tokenCounterFor(model, agent))
    const name = ollamaName(agent, model)
    if (!name || base.kind !== 'estimate') return base
    const viaShow = kept ? null : await ollamaCounter(name, { request }).catch(() => null)
    if (viaShow) return { ...viaShow, defaulted: base.defaulted }
    return { kind: 'api', api: 'ollama', id: `ollama:${name}`, model: name, factor: base.factor, factorKey: 'other', defaulted: base.defaulted }
  }

  // One agent's items, before counting.
  async function itemsFor(agent, { cwd, skills, mcp, budget }) {
    const items = []
    const dir = agent === 'claude' ? await claudeDir().catch(() => null) : null
    const rules = await readRules(agent, { cwd, home, env: env(), claudeDir: dir, gitRoot: cwd ? await findGitRoot(cwd) : null, budget }, reader)
    for (const r of rules) {
      // The imports past the summary's limit: one line, with their number.
      if (r.note === 'more') {
        items.push({ key: r.id, group: 'rules', type: 'more', label: '', count: r.count, note: 'more', loaded: false, optional: true })
        continue
      }
      const notRead = ['outside', 'skipped', 'limit'].includes(r.note)
      if (!notRead && (!r.text || !r.text.trim())) continue
      items.push({
        key: r.id,
        group: r.tessel ? 'tessel' : 'rules',
        type: r.tessel ? 'boardRule' : 'file',
        label: path.basename(r.path),
        path: r.path,
        scope: r.scope,
        note: r.note,
        loaded: notRead ? false : r.loaded,
        optional: true,
        ...(notRead ? {} : { kind: 'text', text: r.text })
      })
    }
    for (const s of skills) {
      if (!Array.isArray(s.seenBy) || !s.seenBy.includes(agent)) continue
      items.push({ key: `skill:${s.skillFile}`, group: 'skills', type: 'skill', label: s.name, path: s.skillFile, scope: s.scope, loaded: true, optional: true, kind: 'text', text: skillLine(s) })
    }
    const servers = agentServers(mcp, agent)
    const approvals = agent === 'claude' && servers.some((s) => s.scope === 'project') ? approvalsFrom(await Promise.resolve(mcpApprovals(cwd, dir)).catch(() => [])) : approvalsFrom([])
    for (const s of servers) {
      if (isTeamServer(s.name)) continue
      const state = s.enabled === false ? 'disabled' : mcpApprovalState(agent, s, approvals)
      const record = state === 'approved' ? await mcpRecord(agent, s, cwd) : null
      const base = { key: `mcp:${agent}:${s.scope || 'user'}:${s.name}`, group: 'mcp', type: 'mcp', label: s.name, scope: s.scope || 'user', optional: true, ref: { agent, name: s.name, scope: s.scope || 'user' } }
      if (state === 'disabled') items.push({ ...base, loaded: false, note: 'off' })
      else if (state === 'unapproved') items.push({ ...base, loaded: false, note: 'notApproved' })
      else if (record && Array.isArray(record.defs)) items.push({ ...base, loaded: true, kind: 'tools', tools: shapeTools(s.name, record.defs, agent), toolCount: record.defs.length, measuredAt: record.at })
      else items.push({ ...base, loaded: true, note: 'notMeasured' })
    }
    if (servers.some((s) => isTeamServer(s.name) && s.enabled !== false)) {
      const team = await tesselContext()
      if (team) {
        items.push({ key: 'tessel:instructions', group: 'tessel', type: 'teamInstructions', label: TEAM_SERVER, loaded: true, optional: true, kind: 'text', text: team.instructions })
        items.push({ key: 'tessel:tools', group: 'tessel', type: 'teamTools', label: TEAM_SERVER, loaded: true, optional: true, kind: 'tools', tools: shapeTools(TEAM_SERVER, team.tools.map((tl) => ({ ...tl, inputSchema: tl.inputSchema })), agent), toolCount: team.tools.length })
      }
    }
    return items
  }

  // What leaves this function: labels, paths, counts. Never a file's text.
  const publicItem = (item) => {
    const rest = { ...item }
    delete rest.text
    delete rest.tools
    return rest
  }

  // auth: the call's own sign-in choices (index.js), down to the count APIs.
  async function countItems(items, counterInfo, remote, auth) {
    const countable = items.filter((i) => i.kind && (i.kind === 'text' ? !!i.text : true))
    const results = countable.length ? await counter.count(countable, counterInfo, { remote, auth }) : {}
    return items.map((item) => ({ ...item, result: results[item.key] || null }))
  }

  return {
    // agents: [{ id, model? }]. -> { agents: [{ id, model, counter, items, summary }] }
    // remote: the page is looked at (count APIs asked, lists read again);
    // kept: a pane card's hover (no process started, no count API asked;
    // nothing when the servers were never listed), which shows the totals
    // only: its reply carries no items.
    async summary({ cwd = null, agents = [], remote = false, kept = false, auth = null } = {}) {
      const wanted = agents.filter((a) => a && CONTEXT_AGENTS.includes(a.id))
      const mode = kept ? 'kept' : remote ? 'fresh' : 'cached'
      const [skillList, mcp] = await Promise.all([skillsOf(cwd, mode), wanted.length ? mcpOf(cwd, mode) : null])
      if (kept && wanted.length && !mcp) return { agents: [], notListed: true }
      if (remote) sweepRecords().catch(() => {})
      const budget = readBudget()
      const out = []
      for (const a of wanted) {
        const model = modelOf(a.id, cwd, a.model)
        const counterInfo = await resolveCounter(a.id, model, { kept })
        const items = await countItems(await itemsFor(a.id, { cwd, skills: skillList, mcp, budget }), counterInfo, remote && !kept, auth)
        out.push({ id: a.id, model: counterInfo.model, defaulted: counterInfo.defaulted, counter: counterInfo, ...(kept ? {} : { items: items.map(publicItem) }), summary: summarize(items) })
      }
      return { agents: out }
    },

    // The Skills page's tags: each skill's up-front cost for the first agent
    // that reads it. -> { [skillFile]: { agent, counter, result } }
    async skills({ cwd = null, agents = null, remote = false, auth = null } = {}) {
      const list = await skillsOf(cwd, remote ? 'fresh' : 'cached')
      const order = CONTEXT_AGENTS
      const byAgent = new Map()
      for (const s of list) {
        const agent = order.find((a) => (s.seenBy || []).includes(a) && (!agents || agents.includes(a)))
        if (!agent) continue
        if (!byAgent.has(agent)) byAgent.set(agent, [])
        byAgent.get(agent).push(s)
      }
      const out = {}
      for (const [agent, skills] of byAgent) {
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        const results = await counter.count(skills.map((s) => ({ key: s.skillFile, kind: 'text', text: skillLine(s) })), counterInfo, { remote, auth })
        for (const s of skills) out[s.skillFile] = { agent, model: counterInfo.model, counter: counterInfo, result: results[s.skillFile] || null }
      }
      return out
    },

    // One skill's details: for each agent that reads it, the up-front cost
    // and its whole SKILL.md (read when the skill is used).
    async skillDetail({ cwd = null, skillFile, agents = null, remote = false, auth = null } = {}) {
      const list = await skillsOf(cwd, 'cached')
      const skill = list.find((s) => s.skillFile === skillFile)
      if (!skill) return { rows: [] }
      const md = await reader.read(skill.skillFile)
      const rows = []
      for (const agent of CONTEXT_AGENTS.filter((a) => (skill.seenBy || []).includes(a) && (!agents || agents.includes(a)))) {
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        const items = [{ key: 'upfront', kind: 'text', text: skillLine(skill) }]
        if (md && md.text) items.push({ key: 'full', kind: 'text', text: md.text })
        const results = await counter.count(items, counterInfo, { remote, auth })
        rows.push({ agent, model: counterInfo.model, counter: counterInfo, upfront: results.upfront || null, full: results.full || null })
      }
      return { rows }
    },

    // A skill about to be added (Skills > Add, its preview): for each agent
    // chosen to get it, the up-front cost and its whole SKILL.md, from the
    // package already held here (its text never comes from the window).
    async skillPackage({ cwd = null, id, agents = null, remote = false, auth = null } = {}) {
      const pkg = typeof id === 'string' ? getPackage(id) : null
      if (!pkg) return { rows: [] }
      const wanted = (Array.isArray(agents) && agents.length ? agents : ['claude', 'codex']).filter((a) => CONTEXT_AGENTS.includes(a)).slice(0, 10)
      const skill = { name: String(pkg.name || ''), description: pkg.description ? String(pkg.description) : '' }
      const md = typeof pkg.skillMd === 'string' ? pkg.skillMd.slice(0, 256 * 1024) : ''
      const rows = []
      for (const agent of wanted) {
        const counterInfo = await resolveCounter(agent, modelOf(agent, cwd))
        const items = [{ key: 'upfront', kind: 'text', text: skillLine(skill) }]
        if (md) items.push({ key: 'full', kind: 'text', text: md })
        const results = await counter.count(items, counterInfo, { remote, auth })
        rows.push({ agent, model: counterInfo.model, counter: counterInfo, upfront: results.upfront || null, full: results.full || null })
      }
      return { rows }
    },

    // Settings > MCP servers' and Context's Measure: starts the server (or
    // connects to it) the way Test does, keeps its tool definitions, counts
    // them for the agent's model. A project server Claude Code has not been
    // allowed to start is started only once the user confirmed (confirmed),
    // after seeing its command (code 'needsConfirm', target); one the user
    // turned off never.
    async measureMcp({ agent, name, scope = 'user', cwd = null, model = null, confirmed = false, auth = null } = {}) {
      if (!CONTEXT_AGENTS.includes(agent) || typeof name !== 'string') return { ok: false, error: 'unknown server' } // i18n-ignore internal
      const servers = await mcpOf(cwd, 'fresh')
      const s = agentServers(servers, agent).find((x) => x.name === name && (x.scope || 'user') === scope)
      if (!s) return { ok: false, error: 'unknown server' } // i18n-ignore internal
      const dir = agent === 'claude' ? await claudeDir().catch(() => null) : null
      const approvals = s.scope === 'project' ? approvalsFrom(await Promise.resolve(mcpApprovals(cwd, dir)).catch(() => [])) : approvalsFrom([])
      const state = s.enabled === false ? 'disabled' : mcpApprovalState(agent, s, approvals)
      if (state === 'disabled') return { ok: false, code: 'disabled' }
      if (state === 'unapproved' && confirmed !== true) return { ok: false, code: 'needsConfirm', target: String(s.target || '').slice(0, 500) }
      const res = await testMcp({ agent, name, scope, cwd }, { defs: true })
      if (!res || !res.ok || !Array.isArray(res.defs)) return { ok: false, status: res && res.status, error: (res && res.error) || null }
      const record = { at: clock(), target: String(s.target || ''), defs: res.defs }
      const text = JSON.stringify(record)
      if (text.length <= MCP_RECORD_LIMIT) {
        await fs.mkdir(mcpDir, { recursive: true })
        await fs.writeFile(path.join(mcpDir, `${mcpKey(agent, s, cwd)}.json`), text)
      }
      const counterInfo = await resolveCounter(agent, modelOf(agent, cwd, model))
      const results = await counter.count([{ key: 'tools', kind: 'tools', tools: shapeTools(name, res.defs, agent) }], counterInfo, { remote: true, auth })
      log?.info?.('context', `measured ${agent} MCP server ${name}: ${res.defs.length} tool(s)`) // i18n-ignore
      return { ok: true, tools: res.defs.length, counter: counterInfo, result: results.tools || null, at: record.at }
    },

    // The kept measurements of the servers the MCP page's tags show
    // (servers: [{ agent, scope, name }], at most 200): read only, no server
    // started, no list of servers read, no count API asked.
    async mcpMeasures({ cwd = null, servers = [], auth = null } = {}) {
      const out = {}
      const counters = new Map()
      for (const s of (Array.isArray(servers) ? servers : []).slice(0, 200)) {
        if (!s || !CONTEXT_AGENTS.includes(s.agent) || typeof s.name !== 'string' || isTeamServer(s.name)) continue
        const scope = typeof s.scope === 'string' ? s.scope : 'user'
        const record = await mcpRecord(s.agent, { name: s.name, scope }, cwd)
        if (!record || !Array.isArray(record.defs)) continue
        if (!counters.has(s.agent)) counters.set(s.agent, await resolveCounter(s.agent, modelOf(s.agent, cwd), { kept: true }))
        const counterInfo = counters.get(s.agent)
        const results = await counter.count([{ key: 'tools', kind: 'tools', tools: shapeTools(s.name, record.defs, s.agent) }], counterInfo, { remote: false, auth })
        out[`${s.agent}:${scope}:${s.name}`] = { tools: record.defs.length, at: record.at, counter: counterInfo, result: results.tools || null }
      }
      return out
    },

    // The downloadable tokenizers, with their size and licence.
    async tokenizers() {
      const status = await files.status()
      return Object.fromEntries(Object.keys(TOKENIZER_FILES).map((id) => [id, { ...status[id], name: (TOKENIZERS[id] && TOKENIZERS[id].name) || id }]))
    },
    downloadTokenizer: (id) => files.download(id),
    removeTokenizer: (id) => files.remove(id),
    // Retry: ask the count APIs again even after a rate limit or a refusal.
    retry() {
      for (const service of Object.values(apis)) service?.reset?.()
    }
  }
}
