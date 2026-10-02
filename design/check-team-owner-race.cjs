const fs = require('fs')
const path = require('path')
async function main() {
  const root = process.argv[2] || 'C:/Tessel-claude'
  const asUrl = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64')
  const channelUrl = asUrl(fs.readFileSync(path.join(root, 'src/main/teamChannel.js'), 'utf8'))
  const noticesUrl = asUrl(fs.readFileSync(path.join(root, 'src/main/teamNotices.js'), 'utf8').replace("'./teamChannel'", JSON.stringify(channelUrl)))
  const channel = await import(channelUrl)
  const notices = await import(noticesUrl)
  const dir = fs.mkdtempSync(path.join(__dirname, 'owner-race-'))
  channel.ensureTeamChannel({ dir, teamId: 'team-a', members: [{ id: 'pane-a', num: 1, title: 'A' }] })
  channel.ensureTeamChannel({ dir, teamId: 'team-b', members: [{ id: 'pane-b', num: 2, title: 'B' }] })
  const current = path.join(dir, '.tessel/team-channel/current.json')
  fs.writeFileSync(current, JSON.stringify({ version: 1, panes: {}, owners: {} }))
  const read = fs.readFileSync
  let intercepted = false
  fs.readFileSync = function(file, ...args) {
    const contents = read.call(this, file, ...args)
    if (!intercepted && path.resolve(file) === current) {
      intercepted = true
      // A read the old map; before A writes it, the other process B publishes.
      notices.writeCurrentTeams({ dir, owner: 'window-b', panes: { 'pane-b': { team: 'team-b', num: 2 } } })
    }
    return contents
  }
  try {
    notices.writeCurrentTeams({ dir, owner: 'window-a', panes: { 'pane-a': { team: 'team-a', num: 1 } } })
  } finally { fs.readFileSync = read }
  const after = JSON.parse(fs.readFileSync(current, 'utf8'))
  const retired = notices.retireOldTeams({ dir, owner: 'window-a', liveTeamIds: ['team-a'] })
  const b = channel.pollTeamChannel({ dir, teamId: 'team-b' })
  const result = { dir, interleaving: 'A reads -> B reads/writes -> A writes -> A retires', current: after, retired, otherWindowMembers: b.participants }
  fs.writeFileSync(path.join(__dirname, 'team-owner-race-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
