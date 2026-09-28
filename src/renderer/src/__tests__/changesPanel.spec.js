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
      cancelGenerate: rec('cancelGenerate', () => ({ ok: true }))
    },
    writeClipboard: vi.fn()
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
    expect(rowOf('src/b.js', 'staged').find('.explorer-hit-dir').text()).toBe('src')
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
    await w.find('[data-test="changes-target"]').setValue('t1')
    await flushPromises()
    expect(names()).toEqual(['copy.js'])
    await rowOf('copy.js', 'unstaged').find('[data-test="sc-stage"]').trigger('click')
    await flushPromises()
    expect(calls.find(([n]) => n === 'stage')[1]).toEqual({ root: 'C:\\proj.worktrees\\fix', paths: ['copy.js'] })
    await w.find('[data-test="review-changes"]').trigger('click')
    expect(w.emitted('review')).toEqual([['t1']])
  })
})
