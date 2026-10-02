// Real channel module, disposable state; no live outboxes or messages.
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const fixed = process.argv.includes('--fixes')
const audit = path.join(__dirname, fixed ? 'fixes-codex-ui' : 'audit-e1d524a')
const sourceRoot = fixed ? path.join(__dirname, 'fixes-codex') : path.join(audit, 'source')
async function main() {
  const source = fs.readFileSync(path.join(sourceRoot, 'src/main/teamChannel.js'), 'utf8')
  const channel = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
  const dir = fs.mkdtempSync(path.join(audit, 'channel-'))
  const teamId = 'audit-team'
  const members = [
    { id: 'pane-a', num: 1, title: 'Codex' },
    { id: 'pane-b', num: 2, title: 'Claude' },
    { id: 'pane-c', num: 3, title: 'Codex C' }
  ]
  const ready = channel.ensureTeamChannel({ dir, teamId, members })
  const aBox = ready.outboxes.find((x) => x.id === 'pane-a').outbox
  fs.writeFileSync(path.join(aBox, 'before-restart.json'), JSON.stringify({ to: '#2', text: 'Review the pending work after you restart.' }))
  const before = channel.pollTeamChannel({ dir, teamId })
  const fresh = { ...members[1], id: 'pane-b-restarted' }
  channel.ensureTeamChannel({ dir, teamId, members: [members[0], fresh, members[2]] })
  const after = channel.pollTeamChannel({ dir, teamId })
  const restart = {
    before: before.deliveries.map((m) => ({ toId: m.toId, text: m.text })),
    after: after.deliveries,
    stranded: after.history.filter((m) => m.status === 'pending'),
    oldRecipient: after.participants.find((m) => m.id === 'pane-b')
  }
  // A backlog of receipts precedes a real new message to a different member.
  const stateFile = path.join(dir, '.tessel/team-channel', teamId, 'state.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  state.messages = Array.from({ length: 200 }, (_, i) => ({ id: `receipt-${i}`, fromId: 'tessel', toId: 'pane-a', status: 'pending', text: 'Delivered to #2 Claude.', createdAt: i }))
  state.messages.push({ id: 'new-to-c', fromId: fresh.id, toId: 'pane-c', status: 'pending', text: 'Please review now.', createdAt: 201 })
  fs.writeFileSync(stateFile, JSON.stringify(state))
  const polled = channel.pollTeamChannel({ dir, teamId, availableIds: ['pane-a', fresh.id, 'pane-c'] })
  const app = fs.readFileSync(path.join(sourceRoot, 'src/renderer/src/App.vue'), 'utf8')
  const deliver = app.match(/^async function deliverChannel\([^]*?^}/m)[0]
  const ctx = vm.createContext({
    TEAM_MESSAGES_IN_TERMINALS: false, channelDir: () => dir,
    channelBoxes: { [teamId]: {} }, teamUnread: {},
    window: { shellApi: { channel: { poll: async (args) => channel.pollTeamChannel(args) } } },
    wakeIfNeeded: () => {}, installTeamToolsOnce: () => {}, restartForTeamTools: () => {}
  })
  vm.runInContext(deliver, ctx)
  await ctx.deliverChannel({ id: teamId }, [members[0], fresh, members[2]])
  const saturation = {
    pendingOnDisk: state.messages.length,
    deliveredListLength: polled.deliveries.length,
    messageToCListed: polled.deliveries.some((m) => m.id === 'new-to-c'),
    unreadBadgeCounts: ctx.teamUnread
  }
  const result = { restart, saturation }
  fs.writeFileSync(path.join(audit, 'channel-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  if (fixed && saturation.unreadBadgeCounts['pane-c'] !== 1) throw new Error('201st message hidden from its recipient')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
