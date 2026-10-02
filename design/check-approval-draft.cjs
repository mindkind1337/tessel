const fs = require('fs')
const vm = require('vm')
const { execFileSync } = require('child_process')
const ref = process.argv[2] || '233086c'
const source = execFileSync('git', ['show', `${ref}:src/renderer/src/App.vue`], { cwd: 'C:/Tessel', encoding: 'utf8' })
const names = ['noteUserInput', 'readDrafts', 'setDraft', 'setDraftUnknown', 'wakeAllowed', 'inputShownEmpty']
const functions = names.map(name => {
  const match = source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))
  if (!match) throw new Error(`Missing ${name}`)
  return match[0]
}).join('\n')
function scenario(name, { approval, keys, initialDraft = false, empty, elapsed = 31000, expected }) {
  let now = 1000000
  const storage = {}
  const env = {
    approvals: { pane: approval }, userDraft: { pane: initialDraft }, draftUnknown: {},
    lastUserKey: {}, shellEnterAt: {}, USER_AWAY_MS: 30000, DRAFTS_KEY: 'drafts',
    Date: { now: () => now }, activeId: { value: 'another-pane' },
    document: { hasFocus: () => false },
    findLeaf: () => ({ agentId: 'codex' }),
    getPane: () => ({ promptShowsPlaceholder: () => empty }),
    localStorage: { getItem: key => storage[key] || null, setItem: (key, value) => { storage[key] = value } }
  }
  vm.createContext(env)
  vm.runInContext(functions, env)
  for (const key of keys) env.noteUserInput('pane', key)
  env.approvals.pane = false
  now += elapsed
  const allowed = env.wakeAllowed('pane')
  return { name, expected, allowed, draft: env.userDraft.pane, unknown: !!env.draftUnknown.pane, stored: storage.drafts || null, pass: allowed === expected }
}
const results = [
  scenario('approval choice followed by proven empty input', { approval: true, keys: ['y'], empty: true, expected: true }),
  scenario('ordinary unfinished user draft', { approval: false, keys: [...'review this'], empty: false, expected: false }),
  scenario('text entered while approval detector is still set', { approval: true, keys: [...'review this'], empty: false, expected: false }),
  scenario('a prior draft is not erased by a key while approval is set', { approval: true, initialDraft: true, keys: ['a'], empty: false, expected: false }),
  scenario('stale draft flag recovers only with proven empty input', { approval: false, initialDraft: true, keys: [], empty: true, expected: true }),
  scenario('recent choice still respects the quiet interval', { approval: true, keys: ['y'], empty: true, elapsed: 1000, expected: false })
]
process.stdout.write(JSON.stringify({ ref, results }, null, 2) + '\n')
if (results.some(r => !r.pass)) process.exitCode = 1
