// Live Share's People section (liveshare/LsPeople.vue and its Grid view,
// one list): everyone (waiting, in now, offline, trusted) with an access
// menu each (presets, Remove / Stop trusting), each row opening on live edits of what they see and may do
// (presets too), trust, removal (a trusted person: asked whether to stop
// trusting too), trusted people renamed or no longer trusted, edited while
// offline or not sharing; a project's "Who has access…" shows who sees it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import ThemedSelect from '../components/ui/ThemedSelect.vue'
import { RIGHT_IDS, NO_RIGHTS } from '../../../shared/liveShareRights'
import { fakeApi, OFF_HOST, OFF_GUEST, invite, guest, trustedOne, sharing } from './liveShareFakes'

const PROJECTS = [
  { id: 'ws-1', name: 'tessel' },
  { id: 'ws-2', name: 'site' },
  { id: 'ws-3', name: 'notes' }
]

let api
let push
beforeEach(() => {
  ;({ api, push } = fakeApi())
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function openAt(section, host, extra = {}) {
  api.state.mockResolvedValue({ host, guest: OFF_GUEST, defaultName: 'ada' })
  const wrapper = mount(LiveShareDialog, { props: { open: true, initialSection: section, projects: PROJECTS, projectIds: host.projectIds || [], paneTitle: (id) => (id === 'pane-1' ? 'Claude Code' : ''), ...extra }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const tick = async (w, sel) => {
  const box = w.find(sel)
  box.element.checked = !box.element.checked
  await box.trigger('change')
  await flushPromises()
}
// A person's row, opened.
// A person's page, opened from their row (back to the list first).
const expand = async (w, id) => {
  if (w.find('[data-test="ls-back"]').exists()) await w.find('[data-test="ls-back"]').trigger('click')
  await w.find(`[data-test="ls-person-toggle-${id}"]`).trigger('click')
  await flushPromises()
}
// Who waits (the band), then the list's rows.
const ids = (w) => [...w.findAll('[data-test^="ls-waiting-g"]'), ...w.findAll('.lpe-list > li')].map((x) => x.attributes('data-test'))
const page = (w) => w.find('[data-test="ls-person-page"]')
// A person's access menu.
const access = (w, id) => w.findAllComponents(ThemedSelect).find((c) => c.vm.$attrs['data-test'] === 'ls-person-access-' + id)
const pick = async (w, id, value) => {
  access(w, id).vm.$emit('change', { target: { value } })
  await flushPromises()
}

describe('Live Share: People', () => {
  it('an empty state until someone asks', async () => {
    const w = await openAt('people', sharing())
    expect(w.find('[data-test="ls-people-empty"]').text()).toContain('No one has joined yet')
    w.unmount()
  })

  it('one row each: their invitation, what they watch, project chips and an access menu; opened, their projects and rights as chips and tiles', async () => {
    const w = await openAt(
      'people',
      sharing({
        invites: [invite({ id: 'iv-root', label: '', root: true })],
        guests: [guest({ rights: { ...NO_RIGHTS, type: false, open: true, close: false } }), guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' }), guest({ id: 'g4', name: 'Ann', invite: { id: 'iv-root', label: '' } })],
        offline: [{ id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: true, open: false, close: false }, projects: ['ws-2'], invite: { id: null, label: 'Old' }, trusted: false, trustable: false }],
        presence: [{ id: 'pane-1', guests: [{ id: 'g1', watching: true, typing: false, reading: false }] }]
      })
    )
    // Waiting first, then in now, then offline.
    expect(ids(w)).toEqual(['ls-waiting-g2', 'ls-guest-g1', 'ls-guest-g4', 'ls-offline-k-abc'])
    const bob = w.find('[data-test="ls-guest-g1"]')
    // One line: what they watch (else the invitation they came with), then their projects.
    expect(bob.text()).toContain('Watching Claude Code · tessel')
    expect(bob.text()).toContain('In now')
    expect(access(w, 'g1').props('value')).toBe('custom')
    // The first invitation is named as the Invitations section names it.
    expect(w.find('[data-test="ls-guest-g4"]').text()).toContain('Came with First invitation')
    // The list has no boxes: they are on the person's page.
    expect(w.find('[data-test="ls-proj-ws-1-g1"]').exists()).toBe(false)
    await expand(w, 'g1')
    expect(page(w).text()).toContain('Bob')
    expect(w.find('[data-test="ls-proj-ws-1-g1"] input').element.checked).toBe(true)
    expect(w.find('[data-test="ls-proj-ws-1-g1"]').classes()).toContain('on')
    expect(w.find('[data-test="ls-proj-ws-2-g1"] input').element.checked).toBe(false)
    expect(w.find('[data-test="ls-right-open-g1"] input').element.checked).toBe(true)
    // Every right of the catalog is a tile (and nothing else), under presets.
    expect(page(w).findAll('[data-test^="ls-right-"]').map((x) => x.attributes('data-test'))).toEqual(RIGHT_IDS.map((id) => `ls-right-${id}-g1`))
    expect(w.find('[data-test="ls-g1-preset-view"]').exists()).toBe(true)
    await w.find('[data-test="ls-back"]').trigger('click')
    const eve = w.find('[data-test="ls-waiting-g2"]')
    expect(eve.text()).toContain('Code 123 456')
    expect(w.find('[data-test="ls-waiting-band"]').text()).toContain('One access request')
    const alex = w.find('[data-test="ls-offline-k-abc"]')
    expect(alex.text()).toContain('Offline: comes back by itself · site')
    // An older Tessel can't be trusted.
    await expand(w, 'k-abc')
    expect(w.find('[data-test="ls-person-remove-k-abc"]').exists()).toBe(true)
    expect(w.find('[data-test="ls-person-trust-k-abc"]').exists()).toBe(false)
    // One person's page at a time; who waits stays on top of it.
    expect(w.find('[data-test="ls-proj-ws-1-g1"]').exists()).toBe(false)
    expect(w.find('[data-test="ls-waiting-g2"]').exists()).toBe(true)
    w.unmount()
  })

  it('one list, no filters: waiting first, then in now, offline, trusted', async () => {
    const w = await openAt(
      'people',
      sharing({
        guests: [guest(), guest({ id: 'g2', name: 'Eve', state: 'waiting' }), guest({ id: 'g3', name: 'Tess', trusted: true, trustId: 't-' + 'c'.repeat(32) })],
        offline: [{ id: 'k-abc', name: 'Alex', rights: {}, projects: [], invite: null, trusted: false, trustable: true }],
        trusted: [trustedOne({ id: 't-' + 'b'.repeat(32), name: 'Ty' }), trustedOne({ id: 't-' + 'c'.repeat(32), name: 'Tess', online: true })]
      })
    )
    expect(w.find('[data-test^="ls-people-filter-"]').exists()).toBe(false)
    expect(w.find('[data-test^="ls-people-view-"]').exists()).toBe(false)
    expect(ids(w)).toEqual(['ls-waiting-g2', 'ls-guest-g1', 'ls-guest-g3', 'ls-offline-k-abc', 'ls-trusted-t-' + 'b'.repeat(32)])
    // Someone waiting has no access menu yet; the others one each.
    expect(access(w, 'g2')).toBeUndefined()
    expect(access(w, 'g1').props('value')).toBe('view')
    w.unmount()
  })

  it('each chip and tile is one live change (offline people too); a click while its change is on its way does nothing', async () => {
    let answer
    api.access.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const w = await openAt('people', sharing({ guests: [guest()], offline: [{ id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: true, open: false, close: false }, projects: ['ws-1'], invite: null, trusted: false, trustable: true }] }))
    await expand(w, 'g1')
    await tick(w, '[data-test="ls-proj-ws-2-g1"] input')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'g1', project: 'ws-2', on: true })
    // The chip waits while its change is on its way.
    expect(w.find('[data-test="ls-proj-ws-2-g1"] input').attributes('disabled')).toBeDefined()
    answer({ ok: false })
    await flushPromises()
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('That change could not be made (the person may have left or been removed).')
    api.access.mockResolvedValue({ ok: true })
    await expand(w, 'k-abc')
    await tick(w, '[data-test="ls-right-type-k-abc"] input')
    expect(api.access).toHaveBeenLastCalledWith({ subject: 'k-abc', right: 'type', on: false })
    expect(w.find('[data-test="ls-host-error"]').exists()).toBe(false)
    w.unmount()
  })

  it('a preset changes each right that differs, one at a time', async () => {
    const w = await openAt('people', sharing({ guests: [guest({ rights: { ...NO_RIGHTS, open: true } })] }))
    await expand(w, 'g1')
    await w.find('[data-test="ls-g1-preset-collaborate"] input').trigger('change')
    await flushPromises()
    expect(api.access.mock.calls.map((c) => c[0])).toEqual(['close', 'edit', 'git', 'tasks', 'pagesView'].map((right) => ({ subject: 'g1', right, on: true })))
    w.unmount()
  })

  it('a trusted person shows once: its newest connection, not its old one, not as offline', async () => {
    const tess = (id, since) => guest({ id, name: 'Tess', trusted: true, trustId: 't-1', since })
    const w = await openAt('people', sharing({ guests: [tess('g1', 1), tess('g2', 2)], offline: [{ id: 'k-old', name: 'Tess', rights: {}, projects: [], invite: null, trusted: true, trustId: 't-1', trustable: true }], trusted: [trustedOne({ id: 't-1', name: 'Tess', online: true })] }))
    expect(ids(w)).toEqual(['ls-guest-g2'])
    w.unmount()
  })

  it('Trust makes a guest trusted', async () => {
    const w = await openAt('people', sharing({ guests: [guest()] }))
    await expand(w, 'g1')
    await w.find('[data-test="ls-person-trust-g1"]').trigger('click')
    await flushPromises()
    expect(api.trust).toHaveBeenCalledWith({ guestId: 'g1' })
    expect(w.find('[data-test="ls-host-notice"]').text()).toContain('Bob is trusted')
    w.unmount()
  })

  it('a full trusted list says so plainly', async () => {
    api.trust.mockResolvedValue({ ok: false, reason: 'trust-full', max: 50 })
    const w = await openAt('people', sharing({ guests: [guest()] }))
    await expand(w, 'g1')
    await w.find('[data-test="ls-person-trust-g1"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('Trusted list is full (50): remove someone first.')
    w.unmount()
  })

  it('Remove asks first; a trusted person stops being trusted too unless you untick it', async () => {
    const w = await openAt('people', sharing({ guests: [guest(), guest({ id: 'g2', name: 'Tess', trusted: true })] }))
    // Not trusted: no trust question.
    await expand(w, 'g1')
    await w.find('[data-test="ls-person-remove-g1"]').trigger('click')
    expect(api.removeGuest).not.toHaveBeenCalled()
    expect(w.find('[data-test="ls-person-untrust-g1"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.find('[data-test="ls-person-remove-cancel-g1"]').element)
    await w.find('[data-test="ls-person-remove-yes-g1"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g1', untrust: false })
    // Trusted: "Also stop trusting" comes ticked.
    await w.find('[data-test="ls-back"]').trigger('click')
    expect(w.find('[data-test="ls-guest-g2"] [data-test="ls-person-trusted"]').exists()).toBe(true)
    await expand(w, 'g2')
    await w.find('[data-test="ls-person-remove-g2"]').trigger('click')
    const untrust = w.find('[data-test="ls-person-untrust-g2"] input')
    expect(untrust.element.checked).toBe(true)
    await w.find('[data-test="ls-person-remove-yes-g2"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g2', untrust: true })
    // Unticked: removed, still trusted (and it says so).
    await expand(w, 'g2')
    await w.find('[data-test="ls-person-remove-g2"]').trigger('click')
    expect(w.find('[data-test="ls-person-keep-trust-g2"]').exists()).toBe(false)
    await w.find('[data-test="ls-person-untrust-g2"] input').setValue(false)
    expect(w.find('[data-test="ls-person-keep-trust-g2"]').text()).toBe('They stay trusted: they can come back without asking.')
    await w.find('[data-test="ls-person-remove-yes-g2"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenLastCalledWith({ guestId: 'g2', untrust: false })
    w.unmount()
  })
})

describe('Live Share: someone waiting for your answer', () => {
  it('Let in… brings up their prompt (review-guest); Refuse turns them away', async () => {
    const w = await openAt('people', sharing({ guests: [guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    const row = w.find('[data-test="ls-waiting-g2"]')
    expect(row.text()).toContain('Code 123 456')
    // Nothing to open: the answer is in the band.
    expect(w.find('[data-test="ls-person-toggle-g2"]').exists()).toBe(false)
    await row.find('[data-test="ls-waiting-letin-g2"]').trigger('click')
    expect(w.emitted('review-guest')).toEqual([['g2']])
    expect(api.approve).not.toHaveBeenCalled()
    await row.find('[data-test="ls-waiting-refuse-g2"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenCalledWith({ guestId: 'g2', yes: false, projects: [], rights: NO_RIGHTS, trust: false })
    expect(w.find('[data-test="ls-host-notice"]').text()).toBe('Eve was turned away.')
    w.unmount()
  })
})

describe('Live Share: trusted people', () => {
  it('an empty state; trusted people edited while not sharing (offline), every project of this window offered', async () => {
    const empty = await openAt('trusted', { ...OFF_HOST })
    expect(empty.find('[data-test="ls-people-empty"]').text()).toContain('People you trust stay here between shares')
    empty.unmount()
    const tess = trustedOne({ projects: ['ws-1', 'ws-gone'], lastSeen: Date.now() - 60000 })
    const w = await openAt('trusted', { ...OFF_HOST, trusted: [tess] })
    // Before sharing: the trusted people are there.
    const row = w.find(`[data-test="ls-trusted-${tess.id}"]`)
    expect(row.text()).toContain('Tess')
    // Before sharing: whether they will get in, and their projects.
    expect(row.text()).toContain('None of their projects is ticked · tessel')
    await expand(w, tess.id)
    // A project kept that this window does not have: counted, not lost.
    expect(page(w).text()).toContain('And 1 project not in this window (kept).')
    // Their own projects as chips; any other project of this window through the picker.
    expect(w.find(`[data-test="ls-proj-ws-1-${tess.id}"]`).exists()).toBe(true)
    expect(w.find(`[data-test="ls-proj-ws-3-${tess.id}"]`).exists()).toBe(false)
    await w.find('[data-test="ls-pp-add-project"]').trigger('click')
    await tick(w, `[data-test="ls-project-ws-3-pick-${tess.id}"] input`)
    expect(api.access).toHaveBeenLastCalledWith({ subject: tess.id, project: 'ws-3', on: true })
    await tick(w, `[data-test="ls-right-close-${tess.id}"] input`)
    expect(api.access).toHaveBeenLastCalledWith({ subject: tess.id, right: 'close', on: true })
    // Not connected through this share: nothing to remove.
    expect(w.find(`[data-test="ls-person-remove-${tess.id}"]`).exists()).toBe(false)
    w.unmount()
  })

  it('a project that could not be given says why (the cap)', async () => {
    api.access.mockResolvedValue({ ok: false })
    const tess = trustedOne()
    const w = await openAt('trusted', { ...OFF_HOST, trusted: [tess] })
    await expand(w, tess.id)
    await w.find('[data-test="ls-pp-add-project"]').trigger('click')
    await tick(w, `[data-test="ls-project-ws-2-pick-${tess.id}"] input`)
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('site could not be given to Tess (a trusted person can have up to 64 projects).')
    api.access.mockResolvedValue({ ok: false, reason: 'trust-projects', max: 64 })
    await tick(w, `[data-test="ls-project-ws-3-pick-${tess.id}"] input`)
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('A trusted person can have up to 64 projects: take one away first.')
    w.unmount()
  })

  it('rename and stop trusting (asked first)', async () => {
    const tess = trustedOne({ online: true })
    const w = await openAt('trusted', sharing({ trusted: [tess] }))
    expect(w.find(`[data-test="ls-trusted-${tess.id}"]`).text()).toContain('Connected now')
    await expand(w, tess.id)
    await w.find(`[data-test="ls-trusted-rename-${tess.id}"]`).trigger('click')
    const input = w.find(`[data-test="ls-trusted-name-input-${tess.id}"]`)
    expect(document.activeElement).toBe(input.element)
    await input.setValue('Tess B')
    await page(w).find('form').trigger('submit')
    await flushPromises()
    expect(api.renameTrusted).toHaveBeenCalledWith({ id: tess.id, name: 'Tess B' })
    await w.find(`[data-test="ls-trusted-untrust-${tess.id}"]`).trigger('click')
    expect(api.untrust).not.toHaveBeenCalled()
    expect(w.text()).toContain('If they are connected, they are disconnected')
    await w.find(`[data-test="ls-trusted-untrust-yes-${tess.id}"]`).trigger('click')
    await flushPromises()
    expect(api.untrust).toHaveBeenCalledWith({ id: tess.id })
    w.unmount()
  })

  it('a trusted guest in now: rename and stop trusting go to their trusted entry', async () => {
    const tid = 't-' + 'c'.repeat(32)
    const w = await openAt('people', sharing({ guests: [guest({ id: 'g3', name: 'Tess', trusted: true, trustId: tid })], trusted: [trustedOne({ id: tid, online: true })] }))
    await expand(w, 'g3')
    await w.find('[data-test="ls-trusted-rename-g3"]').trigger('click')
    await w.find('[data-test="ls-trusted-name-input-g3"]').setValue('Tess R')
    await page(w).find('form').trigger('submit')
    await flushPromises()
    expect(api.renameTrusted).toHaveBeenCalledWith({ id: tid, name: 'Tess R' })
    await w.find('[data-test="ls-trusted-untrust-g3"]').trigger('click')
    await w.find('[data-test="ls-trusted-untrust-yes-g3"]').trigger('click')
    await flushPromises()
    expect(api.untrust).toHaveBeenCalledWith({ id: tid })
    w.unmount()
  })
})

describe('Live Share: the access menu', () => {
  const host = () =>
    sharing({
      projectIds: ['ws-1', 'ws-2'],
      guests: [guest({ projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } }), guest({ id: 'g3', name: 'Tess', trusted: true, trustId: 't-' + 'c'.repeat(32), projects: ['ws-2'] })],
      offline: [{ id: 'k-abc', name: 'Alex', rights: { ...NO_RIGHTS, type: false, open: false, close: false }, projects: ['ws-2'], invite: null, trusted: false, trustable: true }],
      trusted: [trustedOne({ id: 't-' + 'b'.repeat(32), name: 'Ty', projects: ['ws-1'], online: false }), trustedOne({ id: 't-' + 'c'.repeat(32), name: 'Tess', online: true })],
      invites: [invite({ projects: ['ws-1'], joined: 2 })]
    })

  it('a preset picked changes each right that differs', async () => {
    const w = await openAt('people', host())
    expect(access(w, 'k-abc').props('value')).toBe('view')
    await pick(w, 'k-abc', 'collaborate')
    expect(api.access.mock.calls.map((c) => c[0])).toEqual(['open', 'close', 'edit', 'git', 'tasks', 'pagesView'].map((right) => ({ subject: 'k-abc', right, on: true })))
    w.unmount()
  })

  it('Full control is asked first, under their row: nothing changes until Give full control', async () => {
    const w = await openAt('people', host())
    await pick(w, 'k-abc', 'full')
    expect(api.access).not.toHaveBeenCalled()
    expect(w.find('[data-test="ls-raise-confirm-k-abc"]').text()).toContain('Alex will be able to run any command on this PC as you.')
    expect(document.activeElement).toBe(w.find('[data-test="ls-raise-cancel-k-abc"]').element)
    await w.find('[data-test="ls-raise-cancel-k-abc"]').trigger('click')
    expect(w.find('[data-test="ls-raise-confirm-k-abc"]').exists()).toBe(false)
    expect(api.access).not.toHaveBeenCalled()
    await pick(w, 'k-abc', 'full')
    await w.find('[data-test="ls-raise-yes-k-abc"]').trigger('click')
    await flushPromises()
    expect(api.access.mock.calls.map((c) => c[0])).toContainEqual({ subject: 'k-abc', right: 'type', on: true })
    // Lowering applies at once.
    api.access.mockClear()
    await pick(w, 'g1', 'view')
    expect(api.access).toHaveBeenCalledWith({ subject: 'g1', right: 'type', on: false })
    w.unmount()
  })

  it('on a person’s page, the Type tile and the Full control preset are asked first too', async () => {
    const w = await openAt('people', host())
    await expand(w, 'k-abc')
    await tick(w, '[data-test="ls-right-type-k-abc"] input')
    expect(api.access).not.toHaveBeenCalled()
    expect(w.find('[data-test="ls-pp-raise-confirm"]').exists()).toBe(true)
    await w.find('[data-test="ls-pp-raise-yes"]').trigger('click')
    await flushPromises()
    expect(api.access).toHaveBeenCalledWith({ subject: 'k-abc', right: 'type', on: true })
    api.access.mockClear()
    await w.find('[data-test="ls-k-abc-preset-full"] input').trigger('change')
    await flushPromises()
    expect(api.access).not.toHaveBeenCalled()
    await w.find('[data-test="ls-pp-raise-cancel"]').trigger('click')
    expect(w.find('[data-test="ls-pp-raise-confirm"]').exists()).toBe(false)
    w.unmount()
  })

  it('the list says once how many people can run commands on this PC', async () => {
    const w = await openAt('people', host())
    expect(w.find('[data-test="ls-danger-summary"]').text()).toBe('1 person can run commands on this PC')
    w.unmount()
    const none = await openAt('people', sharing({ guests: [guest()] }))
    expect(none.find('[data-test="ls-danger-summary"]').exists()).toBe(false)
    none.unmount()
  })

  it('Remove access asks first, on their page; for a trusted person not here: Stop trusting', async () => {
    const w = await openAt('people', host())
    await pick(w, 'k-abc', 'remove')
    expect(w.find('[data-test="ls-person-remove-confirm-k-abc"]').exists()).toBe(true)
    expect(api.removeGuest).not.toHaveBeenCalled()
    await w.find('[data-test="ls-person-remove-yes-k-abc"]').trigger('click')
    await flushPromises()
    expect(api.removeGuest).toHaveBeenCalledWith({ guestId: 'k-abc', untrust: false })
    await w.find('[data-test="ls-back"]').trigger('click')
    const ty = 't-' + 'b'.repeat(32)
    await pick(w, ty, 'remove')
    expect(w.find(`[data-test="ls-trusted-untrust-confirm-${ty}"]`).exists()).toBe(true)
    expect(api.untrust).not.toHaveBeenCalled()
    w.unmount()
  })

  it('a project’s “Who has access…” shows who sees it, until Show everyone; nobody: said so', async () => {
    const w = await openAt('access', host(), { focusProject: 'ws-2' })
    expect(w.find('[data-test="ls-people-only"]').text()).toContain('Who sees site')
    expect(ids(w)).toEqual(['ls-guest-g3', 'ls-offline-k-abc'])
    await w.find('[data-test="ls-people-all"]').trigger('click')
    expect(ids(w)).toEqual(['ls-guest-g1', 'ls-guest-g3', 'ls-offline-k-abc', 'ls-trusted-t-' + 'b'.repeat(32)])
    w.unmount()
    const v = await openAt('access', sharing({ projectIds: ['ws-1', 'ws-2'], guests: [guest({ projects: ['ws-1'] })] }), { focusProject: 'ws-2' })
    expect(v.find('[data-test="ls-people-empty"]').text()).toBe('No one sees this project yet.')
    v.unmount()
  })
})
