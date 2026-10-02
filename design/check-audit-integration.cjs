const fs = require('fs')
const vm = require('vm')
const path = require('path')
const root = process.argv[2] || 'C:/Tessel-claude'
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8')
function fn(name) {
  const match = app.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))
  if (!match) throw new Error('Missing function ' + name)
  return match[0]
}
async function restart(stillRunning, closedDuringStart = false) {
  const old = { id: 'agent', num: 2, title: 'Codex', kind: 'agent', agentCommand: 'codex', startDir: 'C:/project/branch', team: 'team', sessionId: 'conversation' }
  const ws = { tree: old, cwd: 'C:/project', activeId: 'agent' }
  const team = { id: 'team', leadId: old.id }
  const tasks = [{ id: 'task', paneId: old.id }]
  const starts = [], kills = [], notices = []
  const context = vm.createContext({
    restartingLeaves: new Set(), settings: { resumeAgents: true },
    wsOfLeaf: () => ws, findLeaf: id => ws.tree?.id === id ? ws.tree : null,
    forEachLeaf: (tree, cb) => tree && cb(tree), teamById: () => team,
    createLeaf: async (shell, agent, cwd, worktree, opts) => {
      starts.push({ cwd, opts })
      if (closedDuringStart) ws.tree = null
      return { ...old, id: opts.id || 'fresh-id' }
    },
    replaceNode: (tree, id, replace) => replace(), boardTasks: tasks,
    updateTask: (id, change) => Object.assign(tasks[0], change), maximizedId: { value: null },
    window: { shellApi: { killPty: id => kills.push(id), attachPty: async () => ({ ok: stillRunning }) } },
    dropBuffer() {}, clearAgentStatus() {}, showToast: (...a) => notices.push(a),
    setTimeout: cb => cb(), Date
  })
  vm.runInContext(fn('restartInPlace') + '\n' + fn('restartLeaf'), context)
  await context.restartLeaf('agent')
  return { paneId: ws.tree?.id, starts, killCount: kills.length, leadId: team.leadId, tasks, notices }
}
async function main() {
  const result = {
    normalRestart: await restart(false),
    cannotStopOldProcess: await restart(true),
    closedDuringStart: await restart(false, true)
  }
  fs.writeFileSync(path.join(__dirname, 'audit-integration-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
