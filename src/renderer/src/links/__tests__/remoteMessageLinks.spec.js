// Paths in a message of an agent on an SSH host (the Conversations tab, its
// Media view, task card reports, the activity log): they are the host's
// files. They open there, over the remote file system, by their virtual path
// (ssh://<hostId>/…), only while Tessel is connected to that host; never a
// file of this computer with the same relative name.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useMessageLinks } from '../useMessageLinks'
import { fileLinkContextOf } from '../../chat/orca/composables/use-native-chat-file-link-context.js'
import { buildSenderSnapshot, senderRemote } from '../../senderIdentity'
import { conversationLines, terminalLines } from '../../../../shared/conversations'

const quiet = () => ({ preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false })

// An agent started in an SSH terminal pane of a LOCAL project: the terminal
// started from a folder of this computer, its agent works in /srv/game.
const sshLeaf = { id: 'pane-9', kind: 'agent', agentId: 'claude', remoteHostId: 'ssh-box1', remotePath: '/srv/game', startDir: 'C:\\Users\\me\\game', cwd: 'C:\\Users\\me\\game' }

function setup({ leaves = {}, hosts = { 'ssh-box1': { label: '192.99.0.20', saved: true, connected: true } } } = {}) {
  const panel = {
    findLeaf: (id) => leaves[id] || null,
    paneFolder: (leaf) => leaf.startDir || null,
    remoteHostState: vi.fn((id) => hosts[id] || { label: id, saved: false, connected: false }),
    viewFile: vi.fn(async () => true),
    showImage: vi.fn(),
    openTarget: vi.fn(async () => true),
    toast: vi.fn()
  }
  let links
  const wrapper = mount(
    defineComponent({
      setup() {
        links = useMessageLinks()
        return () => null
      }
    }),
    { global: { provide: { panelCtx: panel } } }
  )
  return { panel, links, wrapper }
}

describe('a message from an agent on an SSH host', () => {
  const had = globalThis.window.shellApi
  afterEach(() => {
    globalThis.window.shellApi = had
  })
  // Anything that would look at or open a file of this computer.
  function localSpies() {
    const chatFiles = { stat: vi.fn(async () => 'file'), open: vi.fn(async () => ({ ok: true })) }
    const viewImage = vi.fn(async () => ({ ok: false }))
    globalThis.window.shellApi = { chatFiles, viewImage, remoteHome: vi.fn(async () => ({ ok: false })) }
    return { chatFiles, viewImage }
  }

  it('its pane open: the host folder, not the folder its terminal started from', () => {
    const ctx = fileLinkContextOf(sshLeaf, { paneFolder: () => 'C:\\Users\\me\\game' })
    expect(ctx).toMatchObject({ remote: true, remoteRoot: 'ssh://ssh-box1/srv/game', worktreePath: 'ssh://ssh-box1/srv/game' })
    expect(ctx.roots).toEqual(['ssh://ssh-box1/srv/game'])
    // No folder named: the host's home folder.
    expect(fileLinkContextOf({ ...sshLeaf, remotePath: null }).remoteRoot).toBe('ssh://ssh-box1/~')
    const { links, wrapper } = setup({ leaves: { [sshLeaf.id]: sshLeaf } })
    try {
      expect(links.contextFor(sshLeaf.id, { folder: 'C:\\Users\\me\\game' })).toMatchObject({ remoteRoot: 'ssh://ssh-box1/srv/game', remoteHost: { id: 'ssh-box1', label: '192.99.0.20' } })
    } finally {
      wrapper.unmount()
    }
  })

  it('its pane closed: the host its sender record names, never the local project folder', () => {
    const { links, wrapper } = setup()
    try {
      const host = senderRemote({ host: 'ssh', hostId: 'ssh-box1', remotePath: '/srv/game', hostLabel: '192.99.0.20' })
      const ctx = links.contextFor('pane-gone', { folder: 'C:\\Users\\me\\game', host })
      expect(ctx).toMatchObject({ remote: true, remoteRoot: 'ssh://ssh-box1/srv/game' })
      expect(JSON.stringify(ctx)).not.toContain('C:\\\\Users')
      // An SSH project's line (no record): the project's host folder.
      expect(links.contextFor('pane-gone', { folder: null, remote: { hostId: 'ssh-box1', path: '~/game', host: 'Box' } })).toMatchObject({ remoteRoot: 'ssh://ssh-box1/~/game' })
      // A local agent's line still reads against its project's folder.
      expect(links.contextFor('pane-gone', { folder: 'C:\\proj' })).toMatchObject({ worktreePath: 'C:\\proj' })
      expect(links.contextFor('pane-gone', { folder: 'C:\\proj' }).remote).toBeFalsy()
    } finally {
      wrapper.unmount()
    }
  })

  it('a relative path opens the file on the host, in the editor, by its virtual path', async () => {
    const { chatFiles } = localSpies()
    const { links, panel, wrapper } = setup()
    try {
      const ctx = links.contextFor('pane-gone', { folder: 'C:\\Users\\me\\game', host: { hostId: 'ssh-box1', path: '/srv/game', label: '192.99.0.20' } })
      await links.openPath({ path: 'client/main.lua' }, ctx, quiet())
      await vi.waitFor(() => expect(panel.viewFile).toHaveBeenCalled())
      expect(panel.viewFile.mock.calls[0][0]).toMatchObject({ file: 'ssh://ssh-box1/srv/game/client/main.lua' })
      // A full host path inside its folder too, never as a path of this PC.
      await links.openPath({ path: '/srv/game/locales/fr.lua', line: 4 }, ctx, quiet())
      await vi.waitFor(() => expect(panel.viewFile).toHaveBeenCalledTimes(2))
      expect(panel.viewFile.mock.calls[1][0]).toMatchObject({ file: 'ssh://ssh-box1/srv/game/locales/fr.lua', line: 4 })
      // Nothing of this computer was looked at or opened.
      expect(chatFiles.stat).not.toHaveBeenCalled()
      expect(chatFiles.open).not.toHaveBeenCalled()
      expect(panel.openTarget).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('a path out of the host folder is refused (no traversal)', async () => {
    localSpies()
    const { links, panel, wrapper } = setup()
    try {
      const ctx = links.contextFor(null, { host: { hostId: 'ssh-box1', path: '/srv/game', label: 'Box' } })
      await links.openPath({ path: '../../etc/passwd' }, ctx, quiet())
      await vi.waitFor(() => expect(panel.toast).toHaveBeenCalled())
      expect(panel.viewFile).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('its host not connected (or no longer saved): a toast, nothing opened', async () => {
    const { chatFiles } = localSpies()
    const { links, panel, wrapper } = setup({ hosts: { 'ssh-box1': { label: '192.99.0.20', saved: true, connected: false } } })
    try {
      const ctx = links.contextFor('pane-gone', { folder: 'C:\\Users\\me\\game', host: { hostId: 'ssh-box1', path: '/srv/game', label: '192.99.0.20' } })
      await links.openPath({ path: 'client/main.lua' }, ctx, quiet())
      expect(panel.toast).toHaveBeenCalledWith('192.99.0.20 is not connected', { kind: 'error' })
      const gone = links.contextFor('pane-gone', { host: { hostId: 'ssh-gone', path: '/srv', label: 'Old box' } })
      await links.openPath({ path: 'a.lua' }, gone, quiet())
      expect(panel.toast).toHaveBeenLastCalledWith('Old box is not connected', { kind: 'error' })
      expect(panel.viewFile).not.toHaveBeenCalled()
      expect(panel.openTarget).not.toHaveBeenCalled()
      expect(chatFiles.stat).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('an older record that names no host id: its paths open nothing, not even an absolute one', async () => {
    const { chatFiles } = localSpies()
    const { links, panel, wrapper } = setup()
    try {
      const ctx = links.contextFor('pane-gone', { folder: 'C:\\Users\\me\\game', host: senderRemote({ host: 'ssh', hostLabel: '192.99.0.20' }) })
      expect(ctx).toMatchObject({ remote: true, remoteRoot: null })
      await links.openPath({ path: 'client/main.lua' }, ctx, quiet())
      await links.openPath({ path: '/etc/hosts' }, ctx, quiet())
      expect(panel.toast).toHaveBeenCalledWith('This path is on 192.99.0.20: Tessel cannot open it from here.', { kind: 'error' })
      expect(panel.viewFile).not.toHaveBeenCalled()
      expect(panel.openTarget).not.toHaveBeenCalled()
      expect(chatFiles.stat).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('a folder (Media view) goes to the Files tab by its virtual path', async () => {
    localSpies()
    const { links, panel, wrapper } = setup()
    try {
      const ctx = links.contextFor(null, { host: { hostId: 'ssh-box1', path: '/srv/game', label: 'Box' } })
      await links.openItem({ type: 'folder', path: 'locales', id: 'p:locales' }, ctx, quiet())
      await vi.waitFor(() => expect(panel.openTarget).toHaveBeenCalled())
      expect(panel.openTarget.mock.calls[0][0]).toEqual({ kind: 'dir', path: 'ssh://ssh-box1/srv/game/locales' })
      expect(panel.viewFile).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('a Live Share guest still opens no path at all', async () => {
    localSpies()
    const { links, panel, wrapper } = setup()
    try {
      const ctx = links.contextFor(null, { host: { hostId: 'ssh-box1', path: '/srv/game', label: 'Box' } })
      expect(await links.openItem({ type: 'file', path: 'client/main.lua' }, ctx, quiet(), { guest: true })).toBe(false)
      expect(panel.viewFile).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })
})

describe('the host travels with the message', () => {
  it("the sender snapshot names the pane's saved host (terminal pane or chat on the host)", () => {
    const s = buildSenderSnapshot({ ...sshLeaf, num: 2, paneName: 'Ada' }, { host: { label: '192.99.0.20' } })
    expect(s).toMatchObject({ host: 'ssh', hostId: 'ssh-box1', hostLabel: '192.99.0.20', remotePath: '/srv/game' })
    const chat = buildSenderSnapshot({ id: 'pane-c', kind: 'chat', paneName: 'Bea', cwd: 'ssh://ssh-box1/~/game' }, {})
    expect(chat).toMatchObject({ host: 'ssh', hostId: 'ssh-box1', remotePath: '~/game' })
    expect(buildSenderSnapshot({ id: 'pane-l', paneName: 'Cy', cwd: 'C:\\proj' }, {})).toMatchObject({ host: 'local' })
    expect(buildSenderSnapshot({ id: 'pane-l', paneName: 'Cy', cwd: 'C:\\proj' }, {}).hostId).toBeUndefined()
  })

  it('a Conversations line keeps it (team message, report) and a terminal line names its host', () => {
    const sender = buildSenderSnapshot({ ...sshLeaf, paneName: 'Ada' }, { host: { label: '192.99.0.20' } })
    const lines = conversationLines([
      { t: 1, type: 'message', source: 'agent', scope: 'team-chat', paneId: 'pane-2', agent: { title: 'Bob' }, from: 'Ada', teamId: 'team-1', text: '[from an agent on 192.99.0.20] Files: client/main.lua', sender },
      { t: 2, type: 'reply', kind: 'report', paneId: sshLeaf.id, agent: { title: 'Ada' }, text: 'Done.\nFiles: client/main.lua', sender }
    ])
    expect(lines.map((l) => senderRemote(l.sender))).toEqual([
      { hostId: 'ssh-box1', path: '/srv/game', label: '192.99.0.20' },
      { hostId: 'ssh-box1', path: '/srv/game', label: '192.99.0.20' }
    ])
    const term = terminalLines([{ paneId: 'pane-9', wsId: 'w', title: 'Ada', agentId: 'claude', host: 'ssh', hostId: 'ssh-box1', hostLabel: 'Box', items: [{ role: 'user', t: 3, text: 'open client/main.lua' }] }])
    expect(term[0].remoteHost).toEqual({ hostId: 'ssh-box1', label: 'Box' })
  })

  it('each surface reads it: Conversations, activity log, task card report (kept on the card by Tessel)', () => {
    const read = (f) => readFileSync(join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n')
    expect(read('App.vue')).toMatch(/const onHost = paneRemote\(from\)[\s\S]{0,400}remote: \{ hostId: onHost\.hostId/)
    expect(read('components/ConversationsPanel.vue')).toMatch(/links\.contextFor\(paneId, \{[^}]*host: lineHost\(line, paneId, project\)/)
    expect(read('components/ActivityPanel.vue')).toMatch(/links\.contextFor\(paneId, \{ host \}\)/)
    expect(read('components/TaskCard.vue')).toMatch(/report\.remote[\s\S]{0,200}links\.contextFor\([^)]*\{ host: remote \}\)/)
  })
})
