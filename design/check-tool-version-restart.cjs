// Actual version-aware restart guard, fake agent/PTY only.
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { execFileSync } = require('child_process')
const revision = process.argv[2] || 'b4a04b1'
const app = execFileSync('git', ['show', `${revision}:src/renderer/src/App.vue`], { cwd: 'C:/Tessel', encoding: 'utf8', maxBuffer: 2e6 })
const fn = name => app.match(new RegExp('^(?:async )?function ' + name + '\\([^]*?^}', 'm'))[0]
async function run(kind) {
  const leaf = { id: 'pane-fixture', num: 1, title: 'Codex CLI', kind: 'agent', agentId: 'codex', sessionId: 'session', teamTools: true, toolsVersion: '1.2.0' }
  if (kind === 'current-version') leaf.toolsVersion = '1.3.0'
  if (kind === 'no-session') leaf.sessionId = null
  const restarted = []
  const ctx = vm.createContext({
    Date, teamToolsReady: true, teamToolsVersion: '1.3.0', restarting: false, restartedForTools: new Set(),
    teams: { value: [{ id: 'team' }] }, teamMembers: () => [leaf],
    trackedState: { [leaf.id]: { state: kind === 'working' ? 'working' : 'idle', since: Date.now() - 90000 } },
    activeId: { value: kind === 'focused' ? leaf.id : 'other-pane' }, document: { hasFocus: () => true },
    userDraft: kind === 'draft' ? { [leaf.id]: true } : {},
    draftUnknown: kind.startsWith('unknown-') ? { [leaf.id]: true } : {},
    lastUserKey: {}, USER_QUIET_MS: 30000,
    approvals: kind === 'approval' ? { [leaf.id]: true } : {},
    pendingMessages: kind === 'pending' ? { [leaf.id]: [{}] } : {},
    unsent: kind === 'uncertain-message' ? { [leaf.id]: {} } : {}, delivering: new Set(),
    paneLabel: l => l.title, showToast() {}, window: { shellApi: {} },
    findLeaf: () => leaf,
    getPane: () => ({ promptShowsPlaceholder: () => kind === 'unknown-but-empty' }),
    restartInPlace: async (id, opts) => { restarted.push({ id, opts }); return true }
  })
  vm.runInContext(['hasCurrentTools', 'userIsTyping', 'inputShownEmpty', 'restartForTeamTools'].map(fn).join('\n'), ctx)
  await ctx.restartForTeamTools()
  return { kind, restarted }
}
async function main() {
  const cases = []
  for (const kind of ['idle-old-version', 'current-version', 'no-session', 'working', 'focused', 'draft', 'approval', 'pending', 'uncertain-message', 'unknown-history-draft', 'unknown-but-empty']) cases.push(await run(kind))
  const result = { revision, cases }
  fs.writeFileSync(path.join(__dirname, 'tool-version-restart-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
