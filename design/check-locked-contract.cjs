const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { execFileSync } = require('child_process')

async function main() {
  const root = 'C:/Tessel-codex/stabilize'
  const ref = process.argv[2] || 'f847d34'
  const source = execFileSync('git', ['show', `${ref}:src/main/index.js`], { cwd: root, encoding: 'utf8' })
  const matched = source.match(/ipcMain\.handle\('layout:load', (\(\) => \{[\s\S]*?\n\})\)/)
  if (!matched) throw new Error('Layout handler not found')
  const { readJsonSafe, writeJsonSafe } = await import(pathToFileURL(path.join(root, 'src/main/safeJson.js')).href)
  const app = execFileSync('git', ['show', `${ref}:src/renderer/src/App.vue`], { cwd: root, encoding: 'utf8' })
  const sync = app.slice(app.indexOf('async function syncBoard('), app.indexOf('\nconst boardSigs ='))
  const save = app.match(/function saveBoard\(\) \{[\s\S]*?\n\}/)[0]
  const env = {
    boardLocked: true, teamRound: 1, boardTasks: [], appliedRequests: new Set(), boardSigs: {},
    roundGone: () => false, findLeaf: () => ({ id: 'pane-a', num: 1 }),
    agentInfo: () => ({}), paneLabel: () => '#1', recordActivity: () => {},
    scheduleTaskSave: () => {}, tellAgents: () => {}
  }
  const boardCalls = { requests: 0, mutations: 0, published: 0, saves: 0, acknowledgements: 0 }
  env.addTask = data => {
    boardCalls.mutations++
    const task = { id: 'new-task', ...data }
    env.boardTasks.push(task)
    return task
  }
  env.updateTask = (id, changes) => Object.assign(env.boardTasks.find(t => t.id === id), changes)
  env.boardToSave = () => ({ tasks: env.boardTasks, appliedRequests: [...env.appliedRequests] })
  env.window = { shellApi: {
    taskBoard: { save: async () => { boardCalls.saves++; return { ok: true } } },
    team: {
      requests: async () => { boardCalls.requests++; return { ok: true, requests: [{ fromId: 'pane-a', file: 'add.json', action: 'add', title: 'Pending request', column: 'doing' }] } },
      requestsDone: async () => { boardCalls.acknowledgements++; return { ok: true, removed: ['add.json'] } },
      tasks: async () => { boardCalls.published++; return { ok: true } }
    }
  } }
  env.saveBoard = Function('env', `with(env) { return (${save}) }`)(env)
  await Function('env', `with(env) { return (${sync}) }`)(env)({ key: 'team', dir: 'unused', target: { teamId: 'team' }, wsId: 'ws-1', members: [{ id: 'pane-a', num: 1 }] })
  process.stdout.write(JSON.stringify({ ref, boardLocked: true, boardCalls, inMemoryTasks: env.boardTasks.length }) + '\n')
  if (boardCalls.mutations || boardCalls.published || boardCalls.saves || boardCalls.acknowledgements) process.exitCode = 1
  env.boardLocked = false
  env.boardTasks = []
  env.appliedRequests.clear()
  env.boardSigs = {}
  for (const key of Object.keys(boardCalls)) boardCalls[key] = 0
  await Function('env', `with(env) { return (${sync}) }`)(env)({ key: 'team', dir: 'unused', target: { teamId: 'team' }, wsId: 'ws-1', members: [{ id: 'pane-a', num: 1 }] })
  process.stdout.write(JSON.stringify({ ref, boardLocked: false, boardCalls, inMemoryTasks: env.boardTasks.length }) + '\n')
  if (Object.values(boardCalls).some(count => count !== 1) || env.boardTasks.length !== 1) process.exitCode = 1
  const retryCode = app.match(/async function loadUnlocked\([^]*?\n\}/)[0]
  const loadUnlocked = Function('setTimeout', `return (${retryCode})`)(callback => callback())
  let attempts = 0
  const recovered = await loadUnlocked(async () => ++attempts < 3 ? { locked: true } : { workspaces: ['current'] }, 3)
  if (attempts !== 3 || recovered.workspaces?.[0] !== 'current') process.exitCode = 1
  attempts = 0
  const fallback = await loadUnlocked(async () => { attempts++; return { locked: true, backup: {} } }, 3)
  if (attempts !== 3 || !fallback.locked) process.exitCode = 1
  process.stdout.write(JSON.stringify({ retryRecovered: recovered, persistentLock: fallback }) + '\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-layout-contract-'))
  const file = path.join(dir, 'layout.json')
  const log = []
  const original = fs.readFileSync
  try {
    writeJsonSafe(file, { workspaces: ['previous'] })
    writeJsonSafe(file, { workspaces: ['previous', 'latest'] })
    const handler = Function('readJsonSafe', 'layoutFile', 'isLayout', 'log', 'logCrashContext', `return (${matched[1]})`)(
      readJsonSafe, () => file, d => d && typeof d === 'object' && !Array.isArray(d),
      { warn: (...a) => log.push(a.join(' ')) }, message => log.push(message)
    )
    fs.readFileSync = (name, ...args) => {
      if (name === file) throw Object.assign(new Error('temporary lock'), { code: 'EBUSY' })
      return original(name, ...args)
    }
    const result = await handler()
    fs.readFileSync = original
    let saveBlocked = false
    try { writeJsonSafe(file, {}) } catch (e) { saveBlocked = e.code === 'EJSONUNREAD' }
    const fresh = readJsonSafe(file)
    const output = { ref, result, saveBlocked, fresh: fresh.data, log }
    process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    if (!result?.locked || !saveBlocked || fresh.data.workspaces.length !== 2) process.exitCode = 1
  } finally {
    fs.readFileSync = original
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
