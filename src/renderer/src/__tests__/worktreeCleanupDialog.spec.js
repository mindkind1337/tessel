// The Clean up worktrees dialog: scan, safe default selection, risky rows
// need a tick and say why, confirm step, progress, per-row errors and retry.
import { describe, it, expect, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import WorktreeCleanupDialog from '../components/sidebar/WorktreeCleanupDialog.vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { resetSettings } from '../settings'
import { setUiLanguage } from '../i18n'
import { _resetFeedsForTest } from '../agentChildrenFeed'
import { INACTIVE_MS } from '../worktreeCleanup'

const NOW = 10_000_000_000_000
const OLD = NOW - INACTIVE_MS - 1000
const ev = (name, extra = {}) => ({
  path: `C:\\w\\${name}`,
  branch: name,
  head: 'abc',
  detached: false,
  locked: false,
  missing: false,
  onDefault: false,
  dirty: false,
  changes: 0,
  merged: true,
  ahead: 0,
  behind: 1,
  lastCommitAt: OLD,
  lastCommitSubject: 'old work',
  activityAt: OLD,
  ...extra
})
const project = { id: 'ws1', name: 'Shop', cwd: 'C:\\repo', branch: 'main', panes: [], copies: [], worktrees: [] }

let mounted = []
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  document.body.innerHTML = ''
})

function setup({ items, remove, scan } = {}) {
  let current = items
  const scans = []
  const removes = []
  const w = mount(WorktreeCleanupDialog, {
    attachTo: document.body,
    props: {
      project,
      now: NOW,
      scan:
        scan ||
        (async (cwd) => {
          scans.push(cwd)
          return { ok: true, root: 'C:\\repo', defaultBranch: 'main', items: current }
        }),
      remove: async (row, ctx) => {
        removes.push({ key: row.key, force: row.force, ctx })
        const res = remove ? await remove(row) : { ok: true }
        if (res && res.ok) current = current.filter((i) => i.path !== row.key)
        return res
      }
    }
  })
  mounted.push(w)
  return { w, scans, removes, setItems: (x) => (current = x) }
}
const names = (w) => w.findAll('[data-test="cleanup-row"] .hwt-name').map((e) => e.text())
const checked = (w) =>
  w
    .findAll('[data-test="cleanup-row"]')
    .filter((r) => r.find('[data-test="cleanup-check"]').element.checked)
    .map((r) => r.find('.hwt-name').text())

describe('WorktreeCleanupDialog', () => {
  it('scans the project, lists inactive or merged worktrees, ticks only the safe ones', async () => {
    const { w, scans } = setup({
      items: [
        ev('safe'),
        ev('dirty', { dirty: true, changes: 2 }),
        ev('ahead', { merged: false, ahead: 3 }),
        ev('det', { detached: true, branch: '' }),
        ev('fresh', { merged: false, ahead: 1, activityAt: NOW - 1000, lastCommitAt: NOW - 1000 })
      ]
    })
    expect(w.find('[data-test="cleanup-scanning"]').exists()).toBe(true)
    await flushPromises()
    expect(scans).toEqual(['C:\\repo'])
    expect(names(w)).toEqual(['safe', 'ahead', 'dirty', 'det'])
    expect(checked(w)).toEqual(['safe'])
    const risks = w.findAll('[data-test="cleanup-risk"]').map((e) => e.text())
    expect(risks).toContain('3 commits not merged')
    expect(risks).toContain('2 uncommitted changes')
    expect(w.find('[data-test="cleanup-blocker"]').text()).toContain('detached')
    // The blocked one cannot be ticked.
    const det = w.findAll('[data-test="cleanup-row"]').find((r) => r.text().includes('det'))
    expect(det.find('[data-test="cleanup-check"]').element.disabled).toBe(true)
    // Show active lists the fresh one too.
    await w.find('[data-test="cleanup-show-all"]').setValue(true)
    expect(names(w)).toContain('fresh')
    expect(w.text()).toContain('compared with main')
  })

  it('a risky row is removed only once ticked, with force, after a confirm that names the risk', async () => {
    const { w, removes } = setup({ items: [ev('safe'), ev('dirty', { dirty: true, changes: 1 })] })
    await flushPromises()
    const dirtyRow = w.findAll('[data-test="cleanup-row"]').find((r) => r.text().includes('dirty'))
    await dirtyRow.find('[data-test="cleanup-check"]').setValue(true)
    expect(checked(w)).toEqual(['safe', 'dirty'])
    expect(w.find('[data-test="cleanup-remove"]').text()).toBe('Remove 2 worktrees…')
    await w.find('[data-test="cleanup-remove"]').trigger('click')
    expect(w.find('[data-test="cleanup-confirm"]').text()).toContain('Remove 2 worktrees?')
    expect(w.find('[data-test="cleanup-confirm-risky"]').text()).toContain('dirty')
    expect(w.find('[data-test="cleanup-confirm-risky"]').text()).toContain('1 uncommitted change')
    expect(removes).toEqual([])
    // Back keeps the selection; nothing removed.
    await w.find('[data-test="cleanup-back"]').trigger('click')
    expect(checked(w)).toEqual(['safe', 'dirty'])
    await w.find('[data-test="cleanup-remove"]').trigger('click')
    await w.find('[data-test="cleanup-confirm-remove"]').trigger('click')
    await flushPromises()
    expect(removes.map((r) => [r.key, r.force])).toEqual([
      ['C:\\w\\safe', false],
      ['C:\\w\\dirty', true]
    ])
    expect(removes[0].ctx).toEqual({ root: 'C:\\repo', defaultBranch: 'main' })
    expect(w.emitted('removed')[0][0]).toEqual(['C:\\w\\safe', 'C:\\w\\dirty'])
    expect(w.find('[data-test="cleanup-summary"]').text()).toBe('Removed 2 worktrees.')
    expect(w.find('[data-test="cleanup-empty"]').exists()).toBe(true)
  })

  it('shows progress, keeps a failed row with its error, ticked for a retry', async () => {
    let release
    let failB = true
    const { w, removes } = setup({
      items: [ev('a'), ev('b')],
      remove: async (row) => {
        if (row.label === 'a') await new Promise((r) => (release = r))
        if (row.label === 'b' && failB) return { ok: false, error: 'a file is in use' }
        return { ok: true }
      }
    })
    await flushPromises()
    await w.find('[data-test="cleanup-remove"]').trigger('click')
    await w.find('[data-test="cleanup-confirm-remove"]').trigger('click')
    await nextTick()
    expect(w.find('[data-test="cleanup-row-removing"]').exists()).toBe(true)
    expect(w.find('[data-test="cleanup-remove"]').text()).toBe('Removing…')
    expect(w.find('[data-test="cleanup-remove"]').element.disabled).toBe(true)
    // Escape does not close while removing.
    await w.find('.wcl-card').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toBeUndefined()
    release()
    await flushPromises()
    expect(names(w)).toEqual(['b'])
    expect(w.find('[data-test="cleanup-row-error"]').text()).toBe('Not removed: a file is in use')
    expect(w.find('[data-test="cleanup-summary"]').text()).toContain('Removed 1. 1 could not be removed')
    expect(checked(w)).toEqual(['b'])
    failB = false
    await w.find('[data-test="cleanup-remove"]').trigger('click')
    await w.find('[data-test="cleanup-confirm-remove"]').trigger('click')
    await flushPromises()
    expect(removes.map((r) => r.key)).toEqual(['C:\\w\\a', 'C:\\w\\b', 'C:\\w\\b'])
    expect(w.find('[data-test="cleanup-empty"]').exists()).toBe(true)
  })

  it('a scan that fails says why', async () => {
    const { w } = setup({ scan: async () => ({ ok: false, error: 'not-repo' }) })
    await flushPromises()
    expect(w.find('[data-test="cleanup-error"]').text()).toBe('The project folder is not a git repository.')
  })

  it('Select none / Select safe ones, and Escape closes', async () => {
    const { w } = setup({ items: [ev('a'), ev('b', { dirty: true, changes: 1 })] })
    await flushPromises()
    await w.find('[data-test="cleanup-select-none"]').trigger('click')
    expect(checked(w)).toEqual([])
    expect(w.find('[data-test="cleanup-remove"]').element.disabled).toBe(true)
    await w.find('[data-test="cleanup-select-safe"]').trigger('click')
    expect(checked(w)).toEqual(['a'])
    await w.find('.wcl-card').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(1)
  })
})

describe('the project menu', () => {
  const menuLabels = () => [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].map((b) => b.textContent.trim())
  const wt = (path, extra = {}) => ({ path, branch: 'x', head: 'h', isMain: false, locked: false, prunable: false, ...extra })
  afterEach(async () => {
    _resetFeedsForTest()
    delete window.shellApi
    await setUiLanguage('en')
  })
  function open(projects) {
    resetSettings()
    window.shellApi = {}
    const w = mount(WorkspaceSidebar, { props: { projects, currentId: 'ws1', ports: {}, now: NOW, teams: [] }, attachTo: document.body })
    mounted.push(w)
    return w
  }

  it('Clean Up Worktrees… emits the project, for a local project with other worktrees', async () => {
    const w = open([{ ...project, worktrees: [wt('C:\repo', { isMain: true }), wt('C:\w\a')] }])
    await w.findAll('.osb-header-action')[0].trigger('click')
    const item = [...document.querySelectorAll('.orca-menu [data-orca-menu-item]')].find((b) => b.textContent.trim() === 'Clean Up Worktrees…')
    expect(item).toBeTruthy()
    item.click()
    await flushPromises()
    expect(w.emitted('cleanup-worktrees')[0]).toEqual(['ws1'])
  })

  it('not for a project without other worktrees, nor a remote one', async () => {
    const w = open([{ ...project, worktrees: [wt('C:\repo', { isMain: true })] }])
    await w.findAll('.osb-header-action')[0].trigger('click')
    expect(menuLabels()).not.toContain('Clean Up Worktrees…')
    w.unmount()
    mounted = []
    document.body.innerHTML = ''
    const r = open([{ ...project, remote: { host: 'srv', path: '/x' }, worktrees: [wt('/x/a')] }])
    await r.findAll('.osb-header-action')[0].trigger('click')
    expect(menuLabels()).not.toContain('Clean Up Worktrees…')
  })
})
