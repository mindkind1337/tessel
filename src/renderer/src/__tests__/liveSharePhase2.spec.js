// Live Share phase 2a in the window (liveShareWindow.js, LiveShareDialog.vue,
// SidePanel.vue). Host: each shared project's task board goes to main as it
// changes; a guest's change of a board is checked again here (still in, with
// the right, seeing the project, the card on that project's board) before it
// is made, and the answer goes back to main; every change a guest makes is a
// toast, and in the dialog's Recent guest actions; the dialog's setting
// "Hide ignored and secret files from guests" is main's. Guest: what the host
// lets it do in each project goes to the panels (and "no access", "the host
// is too old", "the session ended"); the host's board of the project on
// screen is followed and comes as the Tasks tab's source, with the changes
// it may make only with the right.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { reactive, ref, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createLiveShareWindow, actionText } from '../liveShareWindow'
import { lshareAccess, forgetLshareAccess } from '../liveShareGuestAccess'
import { NO_RIGHTS } from '../../../shared/liveShareRights'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import SidePanel from '../components/SidePanel.vue'
import { rightWords } from '../liveShareRights'

const flush = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function setup({ cards = [] } = {}) {
  const listeners = {}
  const api = {
    state: vi.fn(async () => ({ host: { state: 'off', guests: [] }, guest: { state: 'off', panes: [], projects: [] }, defaultName: 'ada' })),
    setLayouts: vi.fn(),
    setAgents: vi.fn(),
    setTasks: vi.fn(),
    taskDone: vi.fn(),
    taskCheck: vi.fn(async () => ({ ok: true })),
    subscribe: vi.fn(async () => ({ ok: true })),
    task: vi.fn(async () => ({ ok: true })),
    share: vi.fn(async () => ({ ok: true })),
    focus: vi.fn(),
    requestDone: vi.fn()
  }
  for (const name of ['onHost', 'onGuest', 'onAsk', 'onHostRequest', 'onNotice', 'onPresence', 'onInviteBlocked', 'onGuestAction', 'onPush']) {
    api[name] = (cb) => {
      listeners[name] = cb
      return () => delete listeners[name]
    }
  }
  window.shellApi = { liveShare: api, attachPty: vi.fn(async () => ({ ok: true, buffer: '', shell: { name: 'Ada' } })) }
  const workspaces = ref([])
  const currentWsId = ref(null)
  const toasts = []
  const board = reactive(cards.map((c) => ({ ...c })))
  let made = 0
  const taskBoard = {
    tasks: () => board,
    add: vi.fn(({ title, wsId }) => board.push({ id: `task-new-${board.length}`, title, column: 'todo', wsId })),
    move: vi.fn((id, column) => (board.find((x) => x.id === id).column = column)),
    rename: vi.fn((id, title) => (board.find((x) => x.id === id).title = title)),
    remove: vi.fn((id) => board.splice(board.findIndex((x) => x.id === id), 1)),
    answer: vi.fn()
  }
  const deps = {
    workspaces: () => workspaces.value,
    currentWs: () => workspaces.value.find((w) => w.id === currentWsId.value) || null,
    currentWsId: () => currentWsId.value,
    maximizedId: () => null,
    setMaximized: () => {},
    makeWorkspace: (name) => reactive({ id: `ws-${++made + 100}`, name, tree: null, activeId: null, cwd: null }),
    selectWorkspace: (id) => (currentWsId.value = id),
    removeWorkspace: vi.fn((id) => (workspaces.value = workspaces.value.filter((w) => w.id !== id))),
    findLeaf: () => null,
    closeLeaf: vi.fn(),
    launch: vi.fn(),
    selectedShell: () => 'pwsh',
    seedBuffer: () => {},
    dropBuffer: () => {},
    showToast: (text, opts) => toasts.push([text, opts && opts.kind]),
    isAgentLeaf: () => false,
    probeRunningWork: vi.fn(async () => ({ running: false, unknown: false, names: [] })),
    killPty: vi.fn(),
    adoptLeaves: vi.fn(),
    hasAgent: () => true,
    layoutReady: () => true,
    taskBoard
  }
  const ls = createLiveShareWindow(deps)
  return { ls, api, listeners, workspaces, currentWsId, toasts, board, taskBoard }
}

const GUEST = (rights = {}) => ({ id: 'g1', name: 'Ana', state: 'joined', rights: { ...NO_RIGHTS, ...rights }, projects: ['ws-1'] })
const sharing = (guests) => ({ state: 'sharing', projectIds: ['ws-1'], invites: [], guests, offline: [], trusted: [], presence: [], settings: { hideIgnored: true }, actions: [] })

describe('Live Share phase 2 in the window, as the host', () => {
  let t
  afterEach(() => t.ls.dispose())

  async function host(cards, rights) {
    t = setup({ cards })
    await t.ls.init()
    t.workspaces.value.push(reactive({ id: 'ws-1', name: 'site', cwd: 'C:\\site', tree: null, activeId: null }), reactive({ id: 'ws-2', name: 'other', cwd: 'C:\\other', tree: null, activeId: null }))
    t.listeners.onHost(sharing([GUEST(rights)]))
    await flush()
  }
  const ask = async (op, args, extra = {}) => {
    t.listeners.onHostRequest({ action: 'task', request: 't1', op, project: 'ws-1', args, guest: { id: 'g1', name: 'Ana' }, ...extra })
    await flush()
  }

  it('sends each shared project\u2019s board, and again when it changes; its folder goes with the layouts', async () => {
    await host([{ id: 'task-1', title: 'One', column: 'todo', wsId: 'ws-1' }, { id: 'task-2', title: 'Elsewhere', column: 'todo', wsId: 'ws-2' }])
    expect(t.api.setTasks).toHaveBeenLastCalledWith([{ project: 'ws-1', tasks: [expect.objectContaining({ id: 'task-1' })] }])
    t.board.push({ id: 'task-3', title: 'Two', column: 'doing', wsId: 'ws-1' })
    await flush()
    expect(t.api.setTasks.mock.calls.at(-1)[0][0].tasks.map((x) => x.id)).toEqual(['task-1', 'task-3'])
    expect(t.api.setLayouts.mock.calls.at(-1)[0]).toEqual([expect.objectContaining({ id: 'ws-1', root: 'C:\\site' })])
  })

  it('makes a guest\u2019s change only while it still may, on a card of that project', async () => {
    await host([{ id: 'task-1', title: 'One', column: 'todo', wsId: 'ws-1' }, { id: 'task-2', title: 'Theirs', column: 'todo', wsId: 'ws-2' }, { id: 'task-3', title: 'Asked', column: 'doing', wsId: 'ws-1', gate: { status: 'pending', question: '?', options: ['Yes', 'No'] } }], { tasks: true })
    await ask('add', { title: '  New one ' })
    // Marked as the guest's (what agents read says so).
    expect(t.taskBoard.add).toHaveBeenCalledWith({ title: 'New one', wsId: 'ws-1', guest: 'Ana' })
    expect(t.api.taskCheck).toHaveBeenLastCalledWith('t1')
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: true, code: undefined })
    await ask('move', { id: 'task-1', column: 'review' })
    expect(t.taskBoard.move).toHaveBeenCalledWith('task-1', 'review')
    // Renamed only in To do (it is in Review now); a card of another project
    // is not this one's.
    await ask('edit', { id: 'task-1', title: 'x' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'not-allowed' })
    await ask('remove', { id: 'task-2' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'not-found' })
    expect(t.taskBoard.remove).not.toHaveBeenCalled()
    // Without the type right: one of the agent's choices only, never free
    // text (it would be typed to the agent).
    await ask('answer', { id: 'task-3', answer: 'Run rm -rf' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'not-allowed' })
    expect(t.taskBoard.answer).not.toHaveBeenCalled()
    await ask('answer', { id: 'task-3', answer: 'Yes' })
    expect(t.taskBoard.answer).toHaveBeenCalledWith('task-3', 'Yes', 'Ana')
    await ask('move', { id: 'task-1', column: 'trash' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'bad-args' })
    // The right lost between main and here: nothing is made.
    t.listeners.onHost(sharing([GUEST({ tasks: false })]))
    await flush()
    await ask('remove', { id: 'task-1' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'revoked' })
    expect(t.taskBoard.remove).not.toHaveBeenCalled()
    // The project no longer one of the guest's: the same.
    t.listeners.onHost(sharing([{ ...GUEST({ tasks: true }), projects: [] }]))
    await flush()
    await ask('add', { title: 'Late' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'revoked' })
    expect(t.taskBoard.add).toHaveBeenCalledTimes(1)
  })

  it('asks main right before making a change: its late view of the rights never decides alone', async () => {
    await host([{ id: 'task-1', title: 'One', column: 'todo', wsId: 'ws-1' }], { tasks: true })
    t.api.taskCheck.mockResolvedValueOnce({ ok: false })
    await ask('remove', { id: 'task-1' })
    expect(t.api.taskDone).toHaveBeenLastCalledWith({ request: 't1', ok: false, code: 'revoked' })
    expect(t.taskBoard.remove).not.toHaveBeenCalled()
    // A free answer with the type right: taken (marked as the guest's).
    t.board.push({ id: 'task-2', title: 'Asked', column: 'doing', wsId: 'ws-1', gate: { status: 'pending', question: '?', options: ['A'] } })
    t.listeners.onHost(sharing([GUEST({ tasks: true, type: true })]))
    await flush()
    await ask('answer', { id: 'task-2', answer: 'Something else' })
    expect(t.taskBoard.answer).toHaveBeenCalledWith('task-2', 'Something else', 'Ana')
  })

  it('says each change a guest made, and an agent\u2019s instructions as a warning', async () => {
    await host([])
    t.toasts.length = 0 // (Ana joined.)
    t.listeners.onGuestAction({ id: 1, kind: 'save', name: 'Ana', path: 'src/app.js', count: 1, flagged: false })
    t.listeners.onGuestAction({ id: 2, kind: 'save', name: 'Ana', path: 'CLAUDE.md', count: 1, flagged: true })
    t.listeners.onGuestAction({ id: 3, kind: 'commit', name: 'Ana', detail: 'Fix it', count: 0, flagged: false })
    t.listeners.onGuestAction({ id: 4, kind: 'nope', name: 'Ana' })
    expect(t.toasts).toEqual([
      ['Ana saved src/app.js', undefined],
      ['Ana saved CLAUDE.md (an agent’s instructions)', 'error'],
      ['Ana committed “Fix it”', undefined]
    ])
    expect(actionText({ kind: 'stage', name: 'Ana', count: 1, paths: ['a.js'] })).toBe('Ana staged a.js')
    expect(actionText({ kind: 'discard', name: 'Ana', count: 3, paths: ['a', 'b', 'c'] })).toBe('Ana discarded the changes of 3 files')
    expect(actionText({ kind: 'taskMove', name: 'Ana', detail: 'One', column: 'done' })).toBe('Ana moved “One” to Done')
    // What a guest wrote that agents read: in the toast and the audit.
    expect(actionText({ kind: 'taskAnswer', name: 'Ana', detail: 'One', answer: 'Yes' })).toBe('Ana answered “Yes” on “One”')
    expect(actionText({ kind: 'taskEdit', name: 'Ana', detail: 'New', from: 'Old' })).toBe('Ana renamed the task “Old” to “New”')
  })
})

describe('Live Share phase 2 in the window, as a guest', () => {
  let t
  beforeEach(async () => {
    forgetLshareAccess()
    t = setup()
    await t.ls.init()
  })
  afterEach(() => t.ls.dispose())
  const joined = (extra = {}) => ({ state: 'joined', host: 'Cedric', session: 1, panes: [], projects: [{ id: 'ws-1', layout: { project: 'site', tree: null } }, { id: 'ws-2', layout: { project: 'blog', tree: null } }], rights: { ...NO_RIGHTS }, features: ['chat', 'files', 'scm', 'tasks'], ...extra })

  it('tells the panels what it may do in each project, and why not', async () => {
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, edit: true } }))
    await flush()
    expect(lshareAccess['ws-1']).toEqual({ edit: true, git: false, tasks: false, state: 'ok' })
    expect(lshareAccess['ws-2']).toEqual({ edit: true, git: false, tasks: false, state: 'ok' })
    // Rights changed live; a project taken away.
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, git: true }, projects: [{ id: 'ws-1', layout: { project: 'site', tree: null } }] }))
    await flush()
    expect(lshareAccess['ws-1']).toEqual({ edit: false, git: true, tasks: false, state: 'ok' })
    expect(lshareAccess['ws-2']).toEqual({ edit: false, git: false, tasks: false, state: 'no-access' })
    // The session over: every project's tabs stay, read-only.
    t.listeners.onGuest({ state: 'ended', host: 'Cedric', session: 1, panes: [], projects: [], reason: 'left' })
    await flush()
    expect(lshareAccess['ws-1'].state).toBe('ended')
    expect(lshareAccess['ws-1'].git).toBe(false)
  })

  it('an older host: its projects say it needs to update', async () => {
    t.listeners.onGuest(joined({ features: ['chat'] }))
    await flush()
    expect(lshareAccess['ws-1'].state).toBe('outdated-host')
    expect(t.ls.taskSource('ws-1').state).toBe('outdated-host')
  })

  it('follows the host\u2019s board of the project on screen, with the changes it may make', async () => {
    t.listeners.onGuest(joined())
    await flush()
    const ws = t.workspaces.value.find((w) => w.liveShare && w.liveShare.project === 'ws-1')
    t.currentWsId.value = ws.id
    await flush()
    expect(t.api.subscribe).toHaveBeenLastCalledWith({ topic: 'tasks', project: 'ws-1', on: true })
    let src = t.ls.taskSource('ws-1')
    expect(src).toMatchObject({ tasks: [], loaded: false, state: 'ok' })
    expect(src.add).toBeUndefined()
    t.listeners.onPush({ topic: 'tasks', project: 'ws-1', data: { tasks: [{ id: 'task-1', title: 'One', column: 'todo' }] } })
    t.listeners.onPush({ topic: 'tasks', project: 'ws-9', data: { tasks: [{ id: 'task-9', title: 'Not mine', column: 'todo' }] } })
    src = t.ls.taskSource('ws-1')
    expect(src).toMatchObject({ loaded: true, state: 'ok' })
    expect(src.tasks.map((x) => x.id)).toEqual(['task-1'])
    expect(t.ls.taskSource('ws-9').state).toBe('no-access')
    // With the right: its changes go to the host; a refusal is said.
    t.listeners.onGuest(joined({ rights: { ...NO_RIGHTS, tasks: true } }))
    await flush()
    src = t.ls.taskSource('ws-1')
    await src.move('task-1', 'doing')
    expect(t.api.task).toHaveBeenLastCalledWith({ op: 'move', project: 'ws-1', args: { id: 'task-1', column: 'doing' } })
    t.api.task.mockResolvedValueOnce({ ok: false, code: 'forbidden' })
    expect(await src.add({ title: 'New' })).toBe(false)
    expect(t.toasts.at(-1)[0]).toBe('Cedric did not make this change: you can no longer manage its tasks.')
    // Another project on screen: the first board is no longer followed.
    const ws2 = t.workspaces.value.find((w) => w.liveShare && w.liveShare.project === 'ws-2')
    t.currentWsId.value = ws2.id
    await flush()
    expect(t.api.subscribe).toHaveBeenCalledWith({ topic: 'tasks', project: 'ws-1', on: false })
    expect(t.api.subscribe).toHaveBeenLastCalledWith({ topic: 'tasks', project: 'ws-2', on: true })
  })
})

describe('the rights’ words', () => {
  it('say that deleting a card is for good, and that hooks stay the host’s', () => {
    expect(rightWords('tasks').label).toContain('delete for good')
    expect(rightWords('edit').hint).toContain('git hooks')
    expect(rightWords('git').hint).toContain('without your git hooks')
  })
})

describe('the Live Share dialog: the setting and the recent guest actions', () => {
  let setSettings
  let hostStatus
  beforeEach(() => {
    setSettings = vi.fn(async ({ hideIgnored }) => ({ ok: true, settings: { hideIgnored } }))
    hostStatus = { ...sharing([GUEST()]), actions: [{ id: 2, at: Date.now(), kind: 'save', name: 'Ana', project: 'ws-1', path: 'CLAUDE.md', count: 1, flagged: true }, { id: 1, at: Date.now(), kind: 'commit', name: 'Ana', project: 'ws-1', detail: 'Fix', count: 0, flagged: false }] }
    window.shellApi = {
      liveShare: {
        state: vi.fn(async () => ({ host: hostStatus, guest: { state: 'off', panes: [], projects: [] }, defaultName: 'ada' })),
        onHost: () => () => {},
        onGuest: () => () => {},
        setSettings
      }
    }
  })
  afterEach(() => {
    delete window.shellApi
    document.body.innerHTML = ''
  })

  it('turns the setting off and on through main, and lists what guests changed', async () => {
    // The setting is in Settings, the recent actions in the overview.
    const w = mount(LiveShareDialog, { props: { open: true, initialSection: 'settings', projects: [{ id: 'ws-1', name: 'site' }], projectIds: ['ws-1'] }, attachTo: document.body })
    await flushPromises()
    const box = w.get('[data-test="ls-hide-ignored"]')
    expect(box.element.checked).toBe(true)
    await box.setValue(false)
    await flushPromises()
    expect(setSettings).toHaveBeenCalledWith({ hideIgnored: false })
    expect(w.get('[data-test="ls-hide-ignored"]').element.checked).toBe(false)
    await w.get('[data-test="ls-section-overview"]').trigger('click')
    const items = w.findAll('.ls-recent-item')
    expect(items.map((i) => i.get('.ls-recent-text').text())).toEqual(['Ana saved CLAUDE.md', 'Ana committed “Fix”'])
    expect(w.get('[data-test="ls-recent-2"]').classes()).toContain('flagged')
    expect(w.get('[data-test="ls-recent-2"]').text()).toContain('Agent instructions')
    w.unmount()
  })

  it('"Find me again after a restart (uses ntfy.sh)": on by default, turned off through main', async () => {
    setSettings.mockImplementation(async (patch) => ({ ok: true, settings: { hideIgnored: true, rendezvous: patch.rendezvous } }))
    const w = mount(LiveShareDialog, { props: { open: true, initialSection: 'settings', projects: [{ id: 'ws-1', name: 'site' }], projectIds: ['ws-1'] }, attachTo: document.body })
    await flushPromises()
    const box = w.get('[data-test="ls-rendezvous"]')
    expect(box.element.checked).toBe(true)
    expect(box.element.closest('label').textContent).toContain('ntfy.sh')
    await box.setValue(false)
    await flushPromises()
    expect(setSettings).toHaveBeenCalledWith({ rendezvous: false })
    expect(w.get('[data-test="ls-rendezvous"]').element.checked).toBe(false)
    w.unmount()
  })

  it('says when no guest changed anything yet', async () => {
    hostStatus.actions = []
    const w = mount(LiveShareDialog, { props: { open: true, projects: [{ id: 'ws-1', name: 'site' }], projectIds: ['ws-1'] }, attachTo: document.body })
    await flushPromises()
    expect(w.find('[data-test="ls-recent-none"]').exists()).toBe(true)
    w.unmount()
  })
})

describe('the side panel of a Live Share host\u2019s project', () => {
  afterEach(() => {
    delete window.shellApi
    document.body.innerHTML = ''
  })

  it('shows the host\u2019s board in the Tasks tab, read-only without the right', async () => {
    window.shellApi = { scm: { status: vi.fn(async () => ({ ok: false })) }, explorer: { watch: vi.fn(async () => ({ ok: true })), unwatch: vi.fn(), onChanged: () => () => {} }, jobCost: { forCards: vi.fn(async () => ({})), onChanged: vi.fn(() => () => {}) } }
    const source = reactive({ tasks: [{ id: 'task-1', title: 'From the host', column: 'todo' }], loaded: true, state: 'ok' })
    const w = mount(SidePanel, { props: { tab: 'tasks', root: 'lshare://ws-1', taskSource: source, workspaceId: 'ws-101' }, attachTo: document.body })
    await flushPromises()
    expect(w.text()).toContain('From the host')
    expect(w.find('[data-test="board-read-only"]').exists()).toBe(true)
    expect(w.find('[data-test="add-task-form"]').exists()).toBe(false)
    expect(window.shellApi.explorer.watch).toHaveBeenCalledWith('lshare://ws-1')
    w.unmount()
  })
})
