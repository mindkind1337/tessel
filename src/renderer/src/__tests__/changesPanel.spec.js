import { setSelectValue, selectOptions } from './selectTestUtils'
// Source Control (ChangesPanel.vue, after Orca's): never "clean" without a git
// status that worked; late answers dropped; Orca's groups, per-row stage /
// unstage / discard (asked first), the commit box with its primary action and
// menu, Generate, the filter, and the review notes shelf.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ChangesPanel from '../components/ChangesPanel.vue'
import { setTasks } from '../taskBoardStore'
import { scmStatus } from '../scmState'
import { addNote, notesFor, clearNotes } from '../reviewNotes'
import { setNotesDelivery } from '../notesDelivery'
import { settings, resetSettings } from '../settings'

const ROOT = 'C:\\proj'
let w
let confirmAnswer
let asked
let calls

function status(entries, extra = {}) {
  return { ok: true, repo: true, top: ROOT, branch: 'main', hasUpstream: true, upstream: 'origin/main', ahead: 0, behind: 0, remotes: ['origin'], entries, ...extra }
}
function api(scm) {
  calls = []
  const rec = (name, fn) =>
    vi.fn(async (q) => {
      calls.push([name, q])
      return fn(q)
    })
  window.shellApi = {
    scm: {
      status: rec('status', scm.status),
      stage: rec('stage', scm.stage || (() => ({ ok: true }))),
      unstage: rec('unstage', scm.unstage || (() => ({ ok: true }))),
      discard: rec('discard', scm.discard || (() => ({ ok: true }))),
      commit: rec('commit', scm.commit || (() => ({ ok: true, sha: 'a'.repeat(40) }))),
      push: rec('push', scm.push || (() => ({ ok: true }))),
      pull: rec('pull', () => ({ ok: true })),
      sync: rec('sync', () => ({ ok: true })),
      fetch: rec('fetch', () => ({ ok: true })),
      generate: rec('generate', scm.generate || (() => ({ ok: true, message: 'Generated message' }))),
      cancelGenerate: rec('cancelGenerate', () => ({ ok: true })),
      ...(scm.branchCompare ? { branchCompare: rec('branchCompare', scm.branchCompare) } : {}),
      ...(scm.history ? { history: rec('history', scm.history) } : {}),
      ...(scm.commitFiles ? { commitFiles: rec('commitFiles', scm.commitFiles) } : {})
    },
    writeClipboard: vi.fn(),
    openExternal: vi.fn()
  }
}
function make(props = {}) {
  asked = []
  w = mount(ChangesPanel, {
    props: { root: ROOT, ...props },
    attachTo: document.body,
    global: {
      provide: {
        askConfirm: async (q) => {
          asked.push(q)
          return confirmAnswer
        }
      }
    }
  })
  return w
}
const names = () => w.findAll('[data-test="changes-row"]').map((r) => r.find('.explorer-name').text())
const rowOf = (path, area) => w.find(`[data-test="changes-row"][data-path="${path}"][data-area="${area}"]`)

beforeEach(() => {
  setTasks([])
  confirmAnswer = true
  for (const k of Object.keys(scmStatus)) delete scmStatus[k]
  clearNotes(ROOT)
})
afterEach(() => {
  if (w) w.unmount()
  w = null
  delete window.shellApi
  document.body.innerHTML = ''
})

describe('Source Control: status', () => {
  it('a failed status is shown as an error, not as a clean copy', async () => {
    api({ status: () => ({ ok: false, error: 'Git status failed' }) })
    make()
    await flushPromises()
    expect(w.text()).not.toContain('everything is committed')
    expect(w.find('[data-test="changes-error"]').text()).toContain('Git status failed')
  })

  it('a status that throws is an error too', async () => {
    api({
      status: () => {
        throw new Error('IPC gone')
      }
    })
    make()
    await flushPromises()
    expect(w.find('[data-test="changes-error"]').text()).toContain('IPC gone')
  })

  it("shows Orca's groups: Changes, Staged Changes, Untracked Files, with letters, counts and line counts", async () => {
    api({
      status: () =>
        status([
          { path: 'src/b.js', area: 'staged', status: 'added', added: 4, removed: 0 },
          { path: 'a.js', area: 'unstaged', status: 'modified', added: 2, removed: 1 },
          { path: 'dir x/new file.txt', area: 'untracked', status: 'untracked' }
        ])
    })
    make()
    await flushPromises()
    expect(w.findAll('.sc-section-label').map((s) => s.text())).toEqual(['Changes', 'Staged Changes', 'Untracked Files'])
    expect(names()).toEqual(['a.js', 'b.js', 'new file.txt'])
    expect(rowOf('a.js', 'unstaged').find('.sc-status').text()).toBe('M')
    expect(rowOf('a.js', 'unstaged').find('.sc-counts').text()).toBe('+2 -1')
    // Tree view (the default): the folder is its own row, with its file count.
    const stagedDirs = w.find('[data-section="staged"]').findAll('[data-test="sc-dir"]')
    expect(stagedDirs.map((d) => [d.find('.sc-dir-name').text(), d.find('.sc-dir-count').text()])).toEqual([['src', '1']])
    expect(rowOf('src/b.js', 'staged').find('.explorer-hit-dir').exists()).toBe(false)
    expect(w.find('[data-test="sc-branch"]').text()).toContain('main')
    expect(w.find('[data-test="sc-empty"]').exists()).toBe(false)
  })

  it('Settings > Git & Source Control, Source Control Group Order: the chosen group first', async () => {
    api({
      status: () =>
        status([
          { path: 'src/b.js', area: 'staged', status: 'added', added: 4, removed: 0 },
          { path: 'a.js', area: 'unstaged', status: 'modified', added: 2, removed: 1 },
          { path: 'n.txt', area: 'untracked', status: 'untracked' }
        ])
    })
    settings.sourceControlGroupOrder = 'untracked-first'
    try {
      make()
      await flushPromises()
      expect(w.findAll('.sc-section-label').map((s) => s.text())).toEqual(['Untracked Files', 'Changes', 'Staged Changes'])
      settings.sourceControlGroupOrder = 'staged-first'
      await flushPromises()
      expect(w.findAll('.sc-section-label').map((s) => s.text())).toEqual(['Staged Changes', 'Changes', 'Untracked Files'])
    } finally {
      resetSettings()
    }
  })

  it('a clean repository says so', async () => {
    api({ status: () => status([]) })
    make()
    await flushPromises()
    expect(w.find('[data-test="sc-empty"]').text()).toContain('No changes')
  })

  it('an answer for the previous folder never shows in the new one', async () => {
    const answers = []
    api({ status: (q) => new Promise((resolve) => answers.push({ q, resolve })) })
    make({ root: 'C:\\one' })
    await w.setProps({ root: 'C:\\two' })
    answers[1].resolve({ ...status([{ path: 'b.js', area: 'unstaged', status: 'modified' }]), top: 'C:\\two' })
    await flushPromises()
    answers[0].resolve({ ...status([{ path: 'a.js', area: 'unstaged', status: 'modified' }]), top: 'C:\\one' })
    await flushPromises()
    expect(names()).toEqual(['b.js'])
  })

  it('a click opens the diff of that file and area', async () => {
    api({ status: () => status([{ path: 'src/x y.js', area: 'staged', status: 'renamed', oldPath: 'src/old.js' }]) })
    make()
    await flushPromises()
    await rowOf('src/x y.js', 'staged').trigger('click')
    expect(w.emitted('open-diff')[0][0]).toMatchObject({ root: ROOT, rel: 'src/x y.js', oldRel: 'src/old.js', area: 'staged', file: 'C:\\proj\\src\\x y.js', preview: true })
    await rowOf('src/x y.js', 'staged').trigger('dblclick')
    expect(w.emitted('open-diff')[1][0].preview).toBe(false)
  })

  it('the filter keeps matching files only', async () => {
    api({
      status: () =>
        status([
          { path: 'a.js', area: 'unstaged', status: 'modified' },
          { path: 'readme.md', area: 'unstaged', status: 'modified' }
        ])
    })
    make()
    await flushPromises()
    await w.find('[data-test="source-control-filter-toggle"]').trigger('click')
    await w.find('[data-test="source-control-filter-input"]').setValue('READ')
    expect(names()).toEqual(['readme.md'])
  })
})

describe('Source Control: stage, unstage, discard', () => {
  const entries = [
    { path: 'a.js', area: 'unstaged', status: 'modified' },
    { path: 'b.js', area: 'staged', status: 'modified' },
    { path: 'n.txt', area: 'untracked', status: 'untracked' },
    { path: 'c.js', area: 'unstaged', status: 'modified', conflictStatus: 'unresolved', conflictKind: 'both_modified' }
  ]
  it('row actions: stage, unstage; a conflict can be neither staged nor discarded', async () => {
    api({ status: () => status(entries, { operation: 'merge' }) })
    make()
    await flushPromises()
    await rowOf('a.js', 'unstaged').find('[data-test="sc-stage"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'stage')[1]).toEqual({ root: ROOT, paths: ['a.js'] })
    await rowOf('b.js', 'staged').find('[data-test="sc-unstage"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'unstage')[1]).toEqual({ root: ROOT, paths: ['b.js'] })
    const conflict = rowOf('c.js', 'unstaged')
    expect(conflict.find('[data-test="sc-stage"]').exists()).toBe(false)
    expect(conflict.find('[data-test="sc-discard"]').exists()).toBe(false)
    expect(conflict.text()).toContain('both modified')
    expect(w.findAll('.sc-section-label')[0].text()).toBe('Conflicts')
    expect(w.text()).toContain('Merge conflicts: 1 unresolved')
    // Unresolved conflicts block the commit.
    expect(w.find('[data-test="sc-primary"]').attributes('title')).toBe('Resolve conflicts before committing')
  })

  it("discard asks first (Orca's words); cancelled, nothing is touched", async () => {
    api({ status: () => status(entries) })
    make()
    await flushPromises()
    confirmAnswer = false
    await rowOf('a.js', 'unstaged').find('[data-test="sc-discard"]').trigger('click')
    await flushPromises()
    expect(asked[0]).toMatchObject({ title: 'Discard changes to "a.js"?', confirmLabel: 'Discard', danger: true })
    expect(calls.some(([n]) => n === 'discard')).toBe(false)
    confirmAnswer = true
    await rowOf('n.txt', 'untracked').find('[data-test="sc-discard"]').trigger('click')
    await flushPromises()
    expect(asked[1]).toMatchObject({ title: 'Delete "n.txt"?', confirmLabel: 'Delete' })
    expect(asked[1].text).toContain('Recycle Bin')
    expect(calls.find(([n]) => n === 'discard')[1]).toEqual({ root: ROOT, paths: ['n.txt'] })
  })

  it.each(['single', 'bulk'])('never discards in a different repository after a delayed %s confirmation', async mode => {
    let confirm
    confirmAnswer = new Promise(resolve => { confirm = resolve })
    api({ status: () => status(entries.slice(0, 3)) })
    make()
    await flushPromises()
    if (mode === 'single') await rowOf('a.js', 'unstaged').find('[data-test="sc-discard"]').trigger('click')
    else await w.find('[data-section="unstaged"]').find('[data-test="sc-discard-all"]').trigger('click')
    expect(asked).toHaveLength(1)
    await w.setProps({ root: 'C:/another-project' })
    await flushPromises()
    confirm(true)
    await flushPromises()
    expect(calls.filter(([name]) => name === 'discard')).toEqual([])
    expect(w.emitted('toast').at(-1)[0]).toContain('repository changed')
  })

  it('section actions: Stage all, Unstage all, Discard all (asked)', async () => {
    api({ status: () => status(entries.slice(0, 3)) })
    make()
    await flushPromises()
    const changes = w.find('[data-section="unstaged"]')
    await changes.find('[data-test="sc-stage-all"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'stage')[1].paths).toEqual(['a.js'])
    await w.find('[data-section="staged"]').find('[data-test="sc-unstage-all"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'unstage')[1].paths).toEqual(['b.js'])
    expect(w.find('[data-section="staged"]').find('[data-test="sc-discard-all"]').exists()).toBe(false)
    await w.find('[data-section="untracked"]').find('[data-test="sc-discard-all"]').trigger('click')
    await flushPromises()
    expect(asked.pop()).toMatchObject({ title: 'Delete 1 untracked file?' })
    expect(calls.find(([n]) => n === 'discard')[1].paths).toEqual(['n.txt'])
  })

  it('cancels discard when an agent finishes the task whose copy was selected', async () => {
    const task = { id: 't1', title: 'Fix it', wsId: 'ws1', column: 'review', worktree: { path: 'C:/copy', branch: 'agent/fix' } }
    setTasks([task])
    api({ status: q => status([{ path: 'a.js', area: 'unstaged', status: 'modified' }], { top: q.root }) })
    make({ workspaceId: 'ws1' })
    await flushPromises()
    await setSelectValue(w.find('[data-test="changes-target"]'), 't1')
    await flushPromises()
    let confirm
    confirmAnswer = new Promise(resolve => { confirm = resolve })
    await rowOf('a.js', 'unstaged').find('[data-test="sc-discard"]').trigger('click')
    setTasks([{ ...task, column: 'done' }])
    await flushPromises()
    confirm(true)
    await flushPromises()
    expect(calls.filter(([name]) => name === 'discard')).toEqual([])
    expect(w.emitted('toast').at(-1)[0]).toContain('repository changed')
  })

  it('a failed stage is said', async () => {
    api({ status: () => status(entries.slice(0, 1)), stage: () => ({ ok: false, error: 'index.lock exists' }) })
    make()
    await flushPromises()
    await rowOf('a.js', 'unstaged').find('[data-test="sc-stage"]').trigger('click')
    await flushPromises()
    expect(w.emitted('toast')[0][0]).toContain('index.lock exists')
  })
})

describe('Source Control: commit', () => {
  it('the primary action follows Orca: Stage All, then Commit (needs a message), then Push', async () => {
    let st = status([{ path: 'a.js', area: 'unstaged', status: 'modified' }])
    api({ status: () => st })
    make()
    await flushPromises()
    await w.find('[data-test="sc-commit-message"]').setValue('')
    const primary = () => w.find('[data-test="sc-primary"]')
    expect(primary().text()).toBe('Stage All')
    st = status([{ path: 'a.js', area: 'staged', status: 'modified' }])
    await primary().trigger('click')
    await flushPromises()
    expect(primary().text()).toBe('Commit')
    expect(primary().attributes('disabled')).toBeDefined()
    expect(primary().attributes('title')).toBe('Enter a commit message to commit')
    await w.find('[data-test="sc-commit-message"]').setValue('Fix a')
    expect(primary().attributes('disabled')).toBeUndefined()
    st = status([], { ahead: 1 })
    await primary().trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'commit')[1]).toEqual({ root: ROOT, message: 'Fix a' })
    expect(w.find('[data-test="sc-commit-message"]').element.value).toBe('')
    expect(primary().text()).toBe('Push')
    expect(primary().attributes('title')).toBe('Push 1 commit')
  })

  it("Ctrl+Enter commits; a failed commit shows git's message", async () => {
    api({ status: () => status([{ path: 'a.js', area: 'staged', status: 'modified' }]), commit: () => ({ ok: false, error: 'pre-commit hook failed' }) })
    make()
    await flushPromises()
    const box = w.find('[data-test="sc-commit-message"]')
    await box.setValue('msg')
    await box.trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(calls.some(([n]) => n === 'commit')).toBe(true)
    expect(w.find('[data-test="sc-commit-error"]').text()).toBe('pre-commit hook failed')
    expect(box.element.value).toBe('msg')
  })

  it('the chevron menu: Commit & Push commits then pushes; rows are disabled with their reason', async () => {
    api({ status: () => status([{ path: 'a.js', area: 'staged', status: 'modified' }]) })
    make()
    await flushPromises()
    // Commit message drafts are kept per repository: start empty.
    await w.find('[data-test="sc-commit-message"]').setValue('')
    await w.find('[data-test="sc-chevron"]').trigger('click')
    const menu = () => document.querySelector('[data-test="sc-commit-menu"]')
    const labels = [...menu().querySelectorAll('.sc-menu-item')].map((b) => b.textContent.trim())
    expect(labels).toEqual(['Commit', 'Commit & Push', 'Commit & Sync', 'Push', 'Pull', 'Fast-forward', 'Sync', 'Fetch', 'Publish Branch'])
    const cp = menu().querySelector('[data-kind="commit_push"]')
    expect(cp.disabled).toBe(true)
    expect(cp.title).toBe('Enter a commit message to commit')
    expect(menu().querySelector('[data-kind="publish"]').title).toBe('Branch is already published')
    await w.find('[data-test="sc-commit-message"]').setValue('Ship it')
    menu().querySelector('[data-kind="commit_push"]').click()
    await flushPromises()
    expect(calls.map(([n]) => n).filter((n) => n === 'commit' || n === 'push')).toEqual(['commit', 'push'])
  })

  it('Generate fills an empty message from the staged changes (disabled with nothing staged)', async () => {
    let st = status([{ path: 'a.js', area: 'unstaged', status: 'modified' }])
    api({ status: () => st })
    make()
    await flushPromises()
    await w.find('[data-test="sc-commit-message"]').setValue('')
    const gen = () => w.find('[data-test="sc-generate"]')
    expect(gen().attributes('aria-disabled')).toBe('true')
    expect(gen().attributes('title')).toBe('Stage at least one file to generate a message.')
    await gen().trigger('click')
    expect(calls.some(([n]) => n === 'generate')).toBe(false)
    st = status([{ path: 'a.js', area: 'staged', status: 'modified' }])
    await w.vm.load()
    await flushPromises()
    await gen().trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'generate')[1]).toMatchObject({ root: ROOT })
    expect(w.find('[data-test="sc-commit-message"]').element.value).toBe('Generated message')
  })
})

describe('Source Control: notes and task copies', () => {
  it('lists the review notes, sends them to an agent and clears them once delivered', async () => {
    api({ status: () => status([{ path: 'a.js', area: 'unstaged', status: 'modified' }]) })
    addNote({ repo: ROOT, filePath: 'a.js', lineNumber: 3, body: 'Rename this' })
    addNote({ repo: ROOT, filePath: 'a.js', lineNumber: 1, startLine: 1, body: 'Why?' })
    let delivered = null
    const sent = []
    setNotesDelivery({
      targets: () => [
        { id: 'p1', label: '#1 Claude Code', stateLabel: 'Ready', disabledReason: '' },
        { id: 'p2', label: '#2 Codex', stateLabel: '', disabledReason: 'Agent needs permission' }
      ],
      send: (id, text, { onDelivered }) => {
        sent.push([id, text])
        delivered = onDelivered
      }
    })
    make()
    await flushPromises()
    expect(rowOf('a.js', 'unstaged').find('.sc-row-notes').text()).toBe('2')
    await w.find('[data-test="sc-notes-toggle"]').trigger('click')
    expect(w.findAll('[data-test="sc-note"]').map((n) => n.find('.sc-note-body').text())).toEqual(['Why?', 'Rename this'])
    await w.find('[data-test="sc-notes"] [data-test="notes-send"]').trigger('click')
    const targets = [...document.querySelectorAll('[data-test="notes-send-target"]')]
    expect(targets.map((t) => t.disabled)).toEqual([false, true])
    targets[0].click()
    await flushPromises()
    expect(sent[0][0]).toBe('p1')
    expect(sent[0][1]).toBe('File: a.js\nLine: 3\nUser comment: "Rename this"\n\nFile: a.js\nLine: 1\nUser comment: "Why?"')
    expect(notesFor(ROOT)).toHaveLength(2) // not yet taken by the agent
    delivered()
    await flushPromises()
    expect(notesFor(ROOT)).toHaveLength(0)
    expect(w.find('[data-test="sc-notes"]').exists()).toBe(false)
  })

  it('a task copy shows its own changes and keeps Review & merge', async () => {
    setTasks([{ id: 't1', title: 'Fix it', wsId: 'ws1', column: 'review', worktree: { path: 'C:\\proj.worktrees\\fix', branch: 'agent/fix' } }])
    api({
      status: (q) =>
        q.root === ROOT
          ? status([{ path: 'a.js', area: 'unstaged', status: 'modified' }])
          : { ...status([{ path: 'copy.js', area: 'unstaged', status: 'modified' }]), top: q.root, branch: 'agent/fix' }
    })
    make({ workspaceId: 'ws1' })
    await flushPromises()
    expect(names()).toEqual(['a.js'])
    await setSelectValue(w.find('[data-test="changes-target"]'), 't1')
    await flushPromises()
    expect(names()).toEqual(['copy.js'])
    await rowOf('copy.js', 'unstaged').find('[data-test="sc-stage"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'stage')[1]).toEqual({ root: 'C:\\proj.worktrees\\fix', paths: ['copy.js'] })
    await w.find('[data-test="review-changes"]').trigger('click')
    expect(w.emitted('review')).toEqual([['t1']])
  })
})

describe("Source Control: Orca's folder tree", () => {
  const treeEntries = [
    { path: 'src/renderer/a.js', area: 'unstaged', status: 'modified', added: 264, removed: 3 },
    { path: 'src/renderer/b.js', area: 'unstaged', status: 'modified', added: 1, removed: 0 },
    { path: 'src/main/c.js', area: 'unstaged', status: 'modified', added: 2, removed: 2 },
    { path: 'top.md', area: 'unstaged', status: 'modified' },
    { path: 'docs/guide/new.md', area: 'untracked', status: 'untracked', added: 12, removed: 0 }
  ]
  const rowsOf = (section) =>
    w
      .find(`[data-section="${section}"]`)
      .findAll('[data-scm-row]')
      .map((r) => (r.attributes('data-test') === 'sc-dir' ? `${r.find('.sc-dir-name').text()}/ ${r.find('.sc-dir-count').text()}` : r.find('.explorer-name').text()))

  it('folders first with their file counts, chains of one folder in one row, indented by depth', async () => {
    api({ status: () => status(treeEntries) })
    make()
    await flushPromises()
    expect(rowsOf('unstaged')).toEqual(['src/ 3', 'main/ 1', 'c.js', 'renderer/ 2', 'a.js', 'b.js', 'top.md'])
    expect(rowsOf('untracked')).toEqual(['docs/guide/ 1', 'new.md'])
    const a = rowOf('src/renderer/a.js', 'unstaged')
    expect(a.attributes('style')).toContain('padding-left: 44px') // depth 2: 2 * 12 + 20
    expect(a.find('.sc-counts').text()).toBe('+264 -3')
    expect(a.find('.sc-status').text()).toBe('M')
    // Untracked files show their line count, green, and "U".
    const n = rowOf('docs/guide/new.md', 'untracked')
    expect(n.find('.sc-plus').text()).toBe('+12')
    expect(n.find('.sc-status').text()).toBe('U')
  })

  it('a folder folds and unfolds; its actions stage or discard what it holds', async () => {
    api({ status: () => status(treeEntries) })
    make()
    await flushPromises()
    const renderer = () => w.findAll('[data-test="sc-dir"]').find((d) => d.find('.sc-dir-name').text() === 'renderer')
    await renderer().find('.sc-dir-toggle').trigger('click')
    expect(rowsOf('unstaged')).toEqual(['src/ 3', 'main/ 1', 'c.js', 'renderer/ 2', 'top.md'])
    await renderer().trigger('keydown', { key: 'ArrowRight' })
    expect(rowsOf('unstaged')).toContain('a.js')
    await renderer().find('[data-test="sc-dir-stage"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'stage')[1].paths).toEqual(['src/renderer/a.js', 'src/renderer/b.js'])
    const docs = w.findAll('[data-test="sc-dir"]').find((d) => d.find('.sc-dir-name').text() === 'docs/guide')
    await docs.find('[data-test="sc-dir-discard"]').trigger('click')
    await flushPromises()
    expect(asked.pop()).toMatchObject({ title: 'Delete 1 untracked file?' })
    expect(calls.find(([n]) => n === 'discard')[1].paths).toEqual(['docs/guide/new.md'])
  })

  it('View as list / View as tree from the more menu (kept in the settings)', async () => {
    api({ status: () => status(treeEntries) })
    try {
      make()
      await flushPromises()
      await w.find('[data-test="sc-more"]').trigger('click')
      const item = () => document.querySelector('[data-test="sc-view-mode"]')
      expect(item().textContent).toContain('View as list')
      item().click()
      await flushPromises()
      expect(settings.sourceControlViewMode).toBe('list')
      expect(w.findAll('[data-test="sc-dir"]')).toHaveLength(0)
      expect(rowOf('src/renderer/a.js', 'unstaged').find('.explorer-hit-dir').text()).toBe('src/renderer')
    } finally {
      resetSettings()
    }
  })

  it('arrows move between rows, Enter opens a file', async () => {
    api({ status: () => status(treeEntries.slice(3, 4)) })
    make()
    await flushPromises()
    const row = rowOf('top.md', 'unstaged')
    row.element.focus()
    await row.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('open-diff')[0][0]).toMatchObject({ rel: 'top.md', area: 'unstaged' })
  })

  it('"View all" opens the diff of every file of the section', async () => {
    api({ status: () => status(treeEntries) })
    make()
    await flushPromises()
    await w.find('[data-section="unstaged"]').find('[data-test="sc-view-all"]').trigger('click')
    const opened = w.emitted('open-diff').map((e) => [e[0].rel, e[0].preview])
    expect(opened).toEqual([
      ['src/main/c.js', false],
      ['src/renderer/a.js', false],
      ['src/renderer/b.js', false],
      ['top.md', false]
    ])
  })
})

describe('Source Control: branch line and Commits', () => {
  it('shows the branch, its line total, → its base with commits ahead, and opens the review page', async () => {
    api({
      status: () => status([{ path: 'a.js', area: 'unstaged', status: 'modified' }]),
      branchCompare: () => ({ ok: true, base: 'origin/main', ahead: 2, behind: 0, added: 14485, removed: 715, reviewUrl: 'https://github.com/me/r/compare/main...main' })
    })
    make()
    await flushPromises()
    await new Promise((r) => setTimeout(r, 350))
    await flushPromises()
    expect(w.find('[data-test="source-control-head-identity"]').text()).toBe('main')
    const total = w.find('[data-test="source-control-branch-line-total"]')
    expect([total.find('.sc-plus').text(), total.find('.sc-minus').text()]).toEqual(['+14,485', '-715'])
    expect(total.attributes('aria-label')).toBe('14485 lines added, 715 lines deleted')
    expect(w.find('[data-test="sc-base"]').text()).toBe('origin/main')
    expect(w.find('.sc-stat').text()).toBe('↑2')
    expect(w.find('.sc-stat').attributes('title')).toBe('2 commits ahead of origin/main')
    await w.find('[data-test="sc-review-page"]').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://github.com/me/r/compare/main...main')
  })

  it('Commits: closed at first; opened, lists the commits with ref pills; a commit shows its files; a file opens its diff', async () => {
    const hash = '1'.repeat(40)
    api({
      status: () => status([], { head: hash }),
      history: () => ({
        ok: true,
        items: [
          { id: hash, parentIds: ['2'.repeat(40)], subject: 'Second', message: 'Second', displayId: '1111111', author: 'Ann', timestamp: 1700000000000, references: [{ id: 'refs/heads/main', name: 'main', revision: hash, category: 'branches' }] },
          { id: '2'.repeat(40), parentIds: [], subject: 'First', message: 'First', displayId: '2222222', references: [] }
        ],
        currentRef: { id: 'refs/heads/main', name: 'main', revision: hash, category: 'branches' },
        hasMore: false,
        limit: 50
      }),
      commitFiles: () => ({ ok: true, entries: [{ path: 'src/a.js', status: 'modified', added: 1, removed: 0 }] })
    })
    make()
    await flushPromises()
    expect(w.find('[data-test="sc-history-list"]').exists()).toBe(false)
    expect(calls.some(([n]) => n === 'history')).toBe(false)
    await w.find('[data-test="sc-history-toggle"]').trigger('click')
    await flushPromises()
    const rows = w.findAll('[data-test="git-history-row"]')
    expect(rows.map((r) => r.find('.sch-subject').text())).toEqual(['Second', 'First'])
    expect(w.find('[data-test="sc-history-count"]').text()).toBe('2')
    expect(rows[0].find('.sch-ref').text()).toBe('main')
    expect(rows[0].findAll('circle').length).toBe(2) // HEAD: ring
    await rows[0].trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'commitFiles')[1]).toEqual({ root: ROOT, commit: hash })
    expect(w.find('[data-test="sc-history-files"]').text()).toContain('Ann')
    await w.find('[data-test="git-history-commit-file"]').trigger('click')
    expect(w.emitted('open-diff')[0][0]).toMatchObject({ root: ROOT, rel: 'src/a.js', area: 'commit', commit: hash, file: 'C:\\proj\\src\\a.js', preview: true })
    await w.find('[data-test="sc-history-toggle"]').trigger('click') // closed again for the next tests
  })
})

describe('Source Control: a project on an SSH host', () => {
  const RROOT = 'ssh://ssh-box1/srv/app'
  it('Create PR is offered and names the project folder (gh reads the host repository from it)', async () => {
    api({ status: () => status([], { top: 'ssh://ssh-box1/srv' }) })
    make({ root: RROOT })
    await flushPromises()
    expect(calls[0]).toEqual(['status', expect.objectContaining({ root: RROOT })])
    await w.get('[data-test="sc-create-pr"]').trigger('click')
    expect(w.emitted('create-pr')).toEqual([[{ cwd: RROOT, taskId: null }]])
  })

  it('no Create PR without a branch or a remote, as for a local project', async () => {
    api({ status: () => status([], { branch: '', remotes: [] }) })
    make({ root: RROOT })
    await flushPromises()
    expect(w.find('[data-test="sc-create-pr"]').exists()).toBe(false)
  })
})
