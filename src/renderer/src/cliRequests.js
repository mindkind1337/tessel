// What the window does for the tessel command (src/cli/tessel.js; the main
// process checks each request first, src/main/cliServer.js): open a folder as
// a project, a file in the editor, a new terminal or agent pane, list the
// panes, add a card to the task board. Nothing here types into a terminal or
// answers a confirmation; a pane it opens is an ordinary pane, started the
// way the new-pane menu starts it (your agent settings apply).
import { t } from './i18n'
import { getAgentSessionOptionCatalog, modelOptions, safeSessionValue, listedModelValues } from '../../shared/agentSessionOptions'

export class CliRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const norm = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

// Is `p` the folder `root` or inside it?
export function insideFolder(p, root) {
  const a = norm(p)
  const b = norm(root)
  if (!a || !b) return false
  return a === b || a.startsWith(`${b}\\`)
}

// A model / effort asked on the command line: only a model the agent lists
// (its catalog, with what its CLI listed) and an effort among that model's
// choices. -> null when fine, else the reason.
export function sessionChoiceError(agentId, model, effort, models) {
  if (!model) return null
  const catalog = getAgentSessionOptionCatalog(agentId)
  if (!catalog) return t('app.cli.noModelChoice', 'Tessel cannot choose the model of this agent.')
  const list = Array.isArray(models) && models.length ? models : catalog.models
  const ids = list.map((m) => m.id)
  // An exact Cursor variant id (gpt-5.3-codex-high-fast) is one it listed;
  // its effort is in the id (it launches as given).
  if (!ids.includes(model) && listedModelValues(list, model)) return null
  if (!safeSessionValue(model) || !ids.includes(model))
    return t('app.cli.unknownModel', 'Unknown model “{{model}}”. Available: {{list}}', { model, list: ids.join(', ') || '—' })
  if (!effort) return null
  const option = modelOptions(catalog, list, model).find((o) => o.id === 'effort')
  const choices = option && option.kind && option.kind.type === 'select' ? option.kind.choices.map((c) => c.value) : []
  if (!choices.includes(effort))
    return choices.length
      ? t('app.cli.unknownEffort', 'Unknown effort “{{effort}}” for {{model}}. Available: {{list}}', { effort, model, list: choices.join(', ') })
      : t('app.cli.noEffort', '{{model}} has no effort choice.', { model })
  return null
}

export function folderName(p) {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p || '')
}

// deps:
//   workspaces(): the projects; currentWs(); selectWorkspace(id)
//   addProjects({ projects, source }): as the Add project dialog
//   openInEditor({ file, line, col, ws }) -> leaf | null; viewFile({ file, line })
//   agentFor(id) -> agent | null (launchable and installed); agentIds() -> [ids]
//   modelsFor(agentId) -> the models its picker lists
//   shellFor(id) -> shell id | null; openPane({ ws, agent, shellId, sessionOptions }) -> leaf
//   focusPane(id); paneLabel(leaf); forEachLeaf(tree, fn); agentState(leafId) -> state
//   addCard({ title, note, ws }) -> task; notify(text)
//   createTeam({ dir, teamName, pane }) -> { teamId, lead, inbox, ... }
export function createCliRequests(deps) {
  // The project the folder is in (the deepest one), a local one.
  function projectFor(p) {
    if (!p) return null
    let best = null
    for (const ws of deps.workspaces()) {
      if (ws.remote || !ws.cwd || !insideFolder(p, ws.cwd)) continue
      if (!best || norm(ws.cwd).length > norm(best.cwd).length) best = ws
    }
    return best
  }
  const projectOrCurrent = (p) => projectFor(p) || deps.currentWs() || null

  async function openProject({ path }) {
    let ws = deps.workspaces().find((w) => !w.remote && w.cwd && norm(w.cwd) === norm(path))
    const created = !ws
    if (!ws) {
      await deps.addProjects({ projects: [{ cwd: path, name: folderName(path) }], source: 'cli' })
      ws = deps.workspaces().find((w) => !w.remote && w.cwd && norm(w.cwd) === norm(path))
      if (!ws) throw new CliRequestError('failed', t('app.cli.projectFailed', 'Tessel could not open {{path}} as a project.', { path }))
    } else deps.selectWorkspace(ws.id)
    return { kind: 'folder', project: ws.name, created }
  }

  function openFile({ path, line, col }) {
    const ws = projectOrCurrent(path)
    if (ws) deps.selectWorkspace(ws.id)
    const leaf = ws ? deps.openInEditor({ file: path, line: line || null, col: col || null, ws }) : null
    if (!leaf) deps.viewFile({ file: path, line: line || null })
    return { kind: 'file', file: folderName(path), project: ws ? ws.name : null }
  }

  async function newPane({ cwd, agent: agentId, model, effort, shell }) {
    const ws = projectOrCurrent(cwd)
    if (!ws) throw new CliRequestError('no_project', t('app.cli.noProject', 'No project is open in Tessel. Open one first (tessel open <folder>).'))
    let agent = null
    if (agentId) {
      agent = deps.agentFor(agentId)
      if (!agent) {
        const ids = deps.agentIds()
        throw new CliRequestError(
          'unknown_agent',
          t('app.cli.unknownAgent', 'No agent “{{id}}” is installed and turned on. Available: {{list}}', { id: agentId, list: ids.length ? ids.join(', ') : '—' })
        )
      }
    }
    let shellId = null
    if (shell) {
      shellId = deps.shellFor(shell)
      if (!shellId) throw new CliRequestError('unknown_shell', t('app.cli.unknownShell', 'No shell “{{id}}” in Tessel.', { id: shell }))
    }
    if (agent && model) {
      const why = sessionChoiceError(agent.id, model, effort, deps.modelsFor ? deps.modelsFor(agent.id) : null)
      if (why) throw new CliRequestError('invalid_argument', why)
    }
    const sessionOptions = agent && model ? { model, ...(effort ? { effort } : {}) } : null
    deps.selectWorkspace(ws.id)
    const leaf = await deps.openPane({ ws, agent, shellId, sessionOptions })
    if (!leaf) throw new CliRequestError('failed', t('app.cli.paneFailed', 'Tessel could not open the pane.'))
    deps.focusPane(leaf.id)
    deps.notify(t('app.cli.paneOpened', 'Opened from the command line: {{pane}}', { pane: deps.paneLabel(leaf) }))
    return { project: ws.name, pane: deps.paneLabel(leaf), id: leaf.id, kind: agent ? 'agent' : 'terminal', agent: agent ? agent.id : null }
  }

  function status() {
    const current = deps.currentWs()
    const projects = deps.workspaces().map((ws) => {
      const panes = []
      deps.forEachLeaf(ws.tree, (leaf) => {
        const kind = (leaf.kind === 'agent' || leaf.kind === 'chat') ? 'agent' : leaf.kind === 'editor' ? 'editor' : 'terminal'
        panes.push({
          id: leaf.id,
          name: leaf.paneName || null,
          kind,
          title: String(leaf.title || '').slice(0, 200),
          ...(kind === 'agent' ? { agentId: leaf.agentId || null, state: deps.agentState(leaf.id) || null } : {}),
          active: ws.activeId === leaf.id
        })
      })
      return {
        name: ws.name,
        path: ws.cwd || (ws.remote ? `ssh:${ws.remote.hostId}:${ws.remote.path}` : null), // i18n-ignore
        active: ws === current,
        panes
      }
    })
    return { projects }
  }

  function addTask({ title, note, cwd }) {
    const ws = projectOrCurrent(cwd)
    const task = deps.addCard({ title, note: note || '', ws })
    deps.notify(t('app.cli.cardAdded', 'Card added from the command line: {{title}}', { title: task.title }))
    return { id: task.id, title: task.title, project: ws ? ws.name : null }
  }

  // A team for this agent, with it as the lead: the one thing a team tool
  // asks for before there is a team to be in. It goes through the window
  // (deps.createTeam -> preload team.create), because the window owns the
  // pane-to-team map: it rewrites it from its own state, so a team made
  // behind its back would be erased again.
  const teamCreations = new Map()
  function createTeam({ teamName, cwd, pane }) {
    const ws = cwd ? projectFor(cwd) : null
    if (cwd && !ws) throw new CliRequestError('no_project', t('app.cli.noProject', 'No project is open in Tessel. Open one first (tessel open <folder>).'))
    // A retry while the first request is still running shares its outcome.
    if (teamCreations.has(pane)) return teamCreations.get(pane)
    const pending = Promise.resolve().then(() => deps.createTeam({ dir: ws?.cwd || null, teamName: teamName || null, pane }))
      .finally(() => teamCreations.delete(pane))
    teamCreations.set(pane, pending)
    return pending
  }

  const METHODS = { openProject, openFile, newPane, status, addTask, createTeam }

  // -> the result, or throws CliRequestError.
  async function handle(req) {
    const fn = req && METHODS[req.method]
    if (!fn) throw new CliRequestError('unknown_method', t('app.cli.unknownRequest', 'Unknown request.'))
    const params = req.params && typeof req.params === 'object' ? req.params : {}
    return fn(params)
  }

  return { handle, projectFor }
}
