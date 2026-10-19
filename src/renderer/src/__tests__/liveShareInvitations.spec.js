// Live Share invitations in the dialog (liveshare/LsInvitations.vue and
// LsInviteEditor.vue): one compact row each (state, expiry, uses, people,
// rights chip, Copy; Copy refused while the code lets no one in), opened on
// the code, Copy message, what it offers and the actions; make one (label,
// projects, later, rights, lifetime, max uses), change one in its row (only
// what changed; what happens to the people who joined with it), duplicate,
// new code, revoke (offering to remove its people); no expiry says what it
// means; no "let them in without asking".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import { fakeApi, OFF_GUEST, invite, sharing } from './liveShareFakes'
import { NO_RIGHTS } from '../../../shared/liveShareRights'

const PROJECTS = [
  { id: 'ws-1', name: 'tessel' },
  { id: 'ws-2', name: 'site' }
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

async function openWith(status) {
  api.state.mockResolvedValue({ host: sharing(status), guest: OFF_GUEST, defaultName: 'ada' })
  const wrapper = mount(LiveShareDialog, { props: { open: true, initialSection: 'invites', projects: PROJECTS, projectIds: ['ws-1', 'ws-2'] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const tick = async (w, sel) => {
  const box = w.find(sel)
  box.element.checked = !box.element.checked
  await box.trigger('change')
}
// An invitation's row, opened.
const expand = async (w, id) => {
  await w.find(`[data-test="ls-invite-toggle-${id}"]`).trigger('click')
  await flushPromises()
}

describe('Live Share invitations: the list', () => {
  it('an empty state, then each invitation with its expiry, uses, people and offer', async () => {
    const empty = await openWith({ invites: [] })
    expect(empty.find('[data-test="ls-invites-empty"]').text()).toContain('No invitation yet')
    empty.unmount()
    const now = Date.now()
    const w = await openWith({
      invites: [
        invite({ expiresAt: now + 42 * 60000, uses: 2, maxUses: 5, joined: 2, projects: ['ws-1', 'ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false } }),
        invite({ id: 'iv-bbbbbbbbbb', label: '', root: true, lifetime: 'never', expiresAt: null, uses: 1, later: true, projects: [] }),
        invite({ id: 'iv-cccccccccc', label: '', state: 'blocked' }),
        invite({ id: 'iv-dddddddddd', state: 'used', maxUses: 1, uses: 1 })
      ]
    })
    const row = (id) => w.find(`[data-test="ls-invite-${id}"]`)
    // The rows: name, state, "Expires 14:37 · 2/5 used · 2 in", the rights chip.
    const a = row('iv-aaaaaaaaaa')
    expect(a.find('.sl-row-name').text()).toBe('Simpa')
    expect(a.find('[data-test="ls-invite-state"]').text()).toBe('Live')
    expect(a.find('[data-test="ls-invite-summary"]').text()).toMatch(/^Expires .+ · 2\/5 used · 2 in$/)
    expect(a.find('[data-test="ls-rights-chip"]').text()).toBe('Custom · 1')
    expect(a.find('[data-test="ls-invite-code-iv-aaaaaaaaaa"]').exists()).toBe(false)
    // The one made when the share started, with no label; no expiry said.
    const b = row('iv-bbbbbbbbbb')
    expect(b.find('.sl-row-name').text()).toBe('First invitation')
    expect(b.find('[data-test="ls-invite-never"]').text()).toBe('No expiry')
    expect(b.find('[data-test="ls-invite-summary"]').text()).toBe('1 used · 0 in')
    expect(row('iv-cccccccccc').find('.sl-row-name').text()).toBe('Invitation')
    expect(row('iv-cccccccccc').find('[data-test="ls-invite-state"]').text()).toBe('Blocked')
    expect(row('iv-dddddddddd').find('[data-test="ls-invite-state"]').text()).toBe('Used up')
    // Copy only while the code lets people in.
    expect(w.find('[data-test="ls-invite-copy-iv-aaaaaaaaaa"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-test="ls-invite-copy-iv-cccccccccc"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="ls-invite-copy-iv-dddddddddd"]').attributes('disabled')).toBeDefined()
    // Opened: the code, what it offers, the expiry, uses and people in words.
    await expand(w, 'iv-aaaaaaaaaa')
    expect(row('iv-aaaaaaaaaa').find('[data-test="ls-invite-toggle-iv-aaaaaaaaaa"]').attributes('aria-expanded')).toBe('true')
    expect(row('iv-aaaaaaaaaa').find('[data-test="ls-invite-code-iv-aaaaaaaaaa"]').attributes('title')).toBe('TS1.code-a')
    expect(row('iv-aaaaaaaaaa').find('[data-test="ls-invite-expiry"]').text()).toMatch(/Expires in 42 min/)
    expect(row('iv-aaaaaaaaaa').find('[data-test="ls-invite-uses"]').text()).toBe('2 of 5 uses')
    expect(row('iv-aaaaaaaaaa').text()).toContain('2 people in with it')
    expect(row('iv-aaaaaaaaaa').text()).toContain('Offers: tessel, site. Can: Open.')
    await expand(w, 'iv-bbbbbbbbbb')
    expect(row('iv-aaaaaaaaaa').find('[data-test="ls-invite-expiry"]').exists()).toBe(false)
    expect(row('iv-bbbbbbbbbb').text()).toContain('1 use, no limit')
    expect(row('iv-bbbbbbbbbb').text()).toContain('Offers: no project, and projects shared later. Can: Watch only.')
    await expand(w, 'iv-cccccccccc')
    expect(row('iv-cccccccccc').find('[data-test="ls-invite-blocked"]').text()).toContain('Make a new code')
    expect(w.find('[data-test="ls-invite-copy-message-iv-cccccccccc"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('copies the code, or a message with it', async () => {
    const w = await openWith({ invites: [invite()] })
    await w.find('[data-test="ls-invite-copy-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenLastCalledWith('TS1.code-a')
    expect(w.find('[data-test="ls-invite-copy-iv-aaaaaaaaaa"]').text()).toBe('Copied')
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-copy-message-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard.mock.calls.at(-1)[0]).toMatch(/^Join my Tessel Live Share: .*TS1\.code-a$/)
    w.unmount()
  })
})

describe('Live Share invitations: making one', () => {
  it('a label, projects, later, rights, lifetime and max uses go to createInvite', async () => {
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    const form = w.find('[data-test="ls-invite-editor"]')
    expect(form.exists()).toBe(true)
    // The label has the keyboard; every shared project is ticked at first.
    expect(document.activeElement).toBe(w.find('[data-test="ls-invite-label"]').element)
    expect(w.find('[data-test="ls-proj-ws-1-invite"] input').element.checked).toBe(true)
    expect(w.find('[data-test="ls-proj-ws-2-invite"] input').element.checked).toBe(true)
    // Rights as presets, View only at first, over a tile per right of the
    // catalog, all off; the open right says what it means.
    expect(w.find('[data-test="ls-invite-preset-view"]').classes()).toContain('on')
    expect(w.find('[data-test="ls-right-open-invite"]').text()).toContain('Open terminals and agents on your computer (they can run commands)')
    expect(['type', 'open', 'close'].map((id) => w.find(`[data-test="ls-right-${id}-invite"] input`).element.checked)).toEqual([false, false, false])
    // 1 hour by default; nothing lets anyone in without asking.
    expect(w.find('[data-test="ls-invite-lifetime-hour"] input').element.checked).toBe(true)
    expect(form.text()).not.toMatch(/without asking/i)
    expect(form.text()).toContain('Every new person still waits for your yes.')
    await w.find('[data-test="ls-invite-label"]').setValue('Design team')
    await tick(w, '[data-test="ls-proj-ws-2-invite"] input')
    await w.find('[data-test="ls-invite-later"] input').setValue(true)
    await tick(w, '[data-test="ls-right-type-invite"] input')
    await w.find('[data-test="ls-invite-lifetime-week"] input').setValue(true)
    await w.find('[data-test="ls-invite-uses"]').setValue('4')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    await flushPromises()
    expect(api.createInvite).toHaveBeenCalledWith({ label: 'Design team', lifetime: 'week', maxUses: 4, rights: { ...NO_RIGHTS, type: true, open: false, close: false }, projects: ['ws-1'], later: true })
    expect(w.find('[data-test="ls-invite-editor"]').exists()).toBe(false)
    expect(w.find('[data-test="ls-host-notice"]').text()).toContain('Invitation ready')
    w.unmount()
  })

  it('rights presets: View only, Collaborate, Full control (said plainly), Customize for the rest', async () => {
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    await w.find('[data-test="ls-invite-preset-collaborate"] input').trigger('change')
    expect(w.find('[data-test="ls-invite-preset-collaborate"]').classes()).toContain('on')
    expect(w.find('[data-test="ls-invite-preset-hint"]').text()).toContain('never type in your terminals')
    await w.find('[data-test="ls-invite-preset-full"] input').trigger('change')
    expect(w.find('[data-test="ls-invite-preset-hint"]').classes()).toContain('warn')
    expect(w.find('[data-test="ls-invite-preset-hint"]').text()).toContain('run any command on this PC as you')
    // A box changed from a preset: Custom (no preset lit), the boxes stay.
    await w.find('[data-test="ls-invite-customize"]').trigger('click')
    await tick(w, '[data-test="ls-right-type-invite"] input')
    expect(w.findAll('.lsi-seg-item.on').map((x) => x.attributes('data-test'))).toEqual(['ls-invite-lifetime-hour'])
    expect(w.find('[data-test="ls-right-type-invite"]').exists()).toBe(true)
    await w.find('[data-test="ls-invite-preset-collaborate"] input').trigger('change')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    await flushPromises()
    expect(api.createInvite).toHaveBeenCalledWith(expect.objectContaining({ rights: { ...NO_RIGHTS, open: true, close: true, edit: true, git: true, tasks: true, pagesView: true } }))
    w.unmount()
  })

  it('No expiry says anyone with the code can ask until revoked', async () => {
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    expect(w.find('[data-test="ls-invite-never-note"]').exists()).toBe(false)
    await w.find('[data-test="ls-invite-lifetime-never"] input').setValue(true)
    expect(w.find('[data-test="ls-invite-never-note"]').text()).toBe('Anyone with this code can ask to join until you revoke it.')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    expect(api.createInvite.mock.calls[0][0]).toMatchObject({ lifetime: 'never' })
    expect(api.createInvite.mock.calls[0][0]).not.toHaveProperty('autoAllow')
    w.unmount()
  })

  it('max uses must be a whole number from 0 to 1000', async () => {
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    for (const bad of ['1001', '2.5', '-1']) {
      await w.find('[data-test="ls-invite-uses"]').setValue(bad)
      expect(w.find('[data-test="ls-invite-uses-error"]').exists()).toBe(true)
      expect(w.find('[data-test="ls-invite-save"]').attributes('disabled')).toBeDefined()
    }
    await w.find('[data-test="ls-invite-uses"]').setValue('1000')
    expect(w.find('[data-test="ls-invite-uses-error"]').exists()).toBe(false)
    w.unmount()
  })

  it('a refusal says why, in words (full: up to 20)', async () => {
    api.createInvite.mockResolvedValue({ ok: false, reason: 'full', max: 20 })
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="ls-host-error"]').text()).toBe('You can have up to 20 invitations at once. Revoke one first.')
    // The form stays, with what was typed.
    expect(w.find('[data-test="ls-invite-editor"]').exists()).toBe(true)
    w.unmount()
  })

  it('at 20 invitations, New invitation and Duplicate wait', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => invite({ id: `iv-${String(i).padStart(10, '0')}` }))
    const w = await openWith({ invites: twenty })
    expect(w.find('[data-test="ls-invite-new"]').attributes('disabled')).toBeDefined()
    await expand(w, 'iv-0000000000')
    expect(w.find('[data-test="ls-invite-duplicate-iv-0000000000"]').attributes('disabled')).toBeDefined()
    w.unmount()
  })

  it('Escape cancels the form, and the dialog stays open', async () => {
    const w = await openWith({ invites: [] })
    await w.find('[data-test="ls-invite-new"]').trigger('click')
    await w.find('[data-test="ls-invite-editor"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="ls-invite-editor"]').exists()).toBe(false)
    expect(w.emitted('close')).toBeUndefined()
    w.unmount()
  })
})

describe('Live Share invitations: changing one', () => {
  it('sends only what changed; nobody joined with it: no question', async () => {
    const w = await openWith({ invites: [invite()] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-edit-iv-aaaaaaaaaa"]').trigger('click')
    // In the row itself, without a card of its own.
    expect(w.find('[data-test="ls-invite-iv-aaaaaaaaaa"] .sl-details [data-test="ls-invite-editor"]').classes()).toContain('flat')
    // Its lifetime is kept unless another one is picked.
    expect(w.find('[data-test="ls-invite-current-expiry"]').text()).toContain('Picking another length starts it again from now.')
    expect(w.find('[data-test="ls-invite-save"]').attributes('disabled')).toBeDefined()
    await w.find('[data-test="ls-invite-label"]').setValue('Simpa B')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    await flushPromises()
    expect(api.updateInvite).toHaveBeenCalledWith({ id: 'iv-aaaaaaaaaa', patch: { label: 'Simpa B' }, applyRemovals: true, applyAdditions: false })
    w.unmount()
  })

  it('people joined with it: a removal applies to them by default, an addition only when ticked', async () => {
    api.updateInvite.mockResolvedValue({ ok: true, applied: 2 })
    const w = await openWith({ invites: [invite({ joined: 2, projects: ['ws-1'], rights: { ...NO_RIGHTS, type: true, open: false, close: false } })] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-edit-iv-aaaaaaaaaa"]').trigger('click')
    await tick(w, '[data-test="ls-right-type-invite"] input') // taken away
    await tick(w, '[data-test="ls-proj-ws-2-invite"] input') // given
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    // The question first.
    expect(api.updateInvite).not.toHaveBeenCalled()
    expect(w.find('[data-test="ls-invite-apply"]').text()).toBe('2 people joined with “Simpa”. What happens to them?')
    const removals = w.find('[data-test="ls-invite-apply-removals"]')
    const additions = w.find('[data-test="ls-invite-apply-additions"]')
    expect(removals.text()).toContain('Type')
    expect(removals.find('input').element.checked).toBe(true)
    expect(additions.text()).toContain('site')
    expect(additions.find('input').element.checked).toBe(false)
    await additions.find('input').setValue(true)
    await w.find('[data-test="ls-invite-confirm"]').trigger('click')
    await flushPromises()
    expect(api.updateInvite).toHaveBeenCalledWith({
      id: 'iv-aaaaaaaaaa',
      patch: { projects: ['ws-1', 'ws-2'], rights: { ...NO_RIGHTS, type: false, open: false, close: false } },
      applyRemovals: true,
      applyAdditions: true
    })
    expect(w.find('[data-test="ls-host-notice"]').text()).toBe('Saved, and changed for 2 people.')
    w.unmount()
  })

  it('Back from the question keeps the form; Escape goes back too', async () => {
    const w = await openWith({ invites: [invite({ joined: 1 })] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-edit-iv-aaaaaaaaaa"]').trigger('click')
    await tick(w, '[data-test="ls-proj-ws-1-invite"] input')
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    expect(w.find('[data-test="ls-invite-apply"]').text()).toContain('1 person joined')
    await w.find('[data-test="ls-invite-editor"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="ls-invite-apply"]').exists()).toBe(false)
    expect(w.find('[data-test="ls-invite-label"]').exists()).toBe(true)
    w.unmount()
  })

  it('a new lifetime restarts it; an invitation gone meanwhile closes its form', async () => {
    const w = await openWith({ invites: [invite()] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-edit-iv-aaaaaaaaaa"]').trigger('click')
    await w.find('[data-test="ls-invite-lifetime-day"] input').setValue(true)
    await w.find('[data-test="ls-invite-save"]').trigger('click')
    expect(api.updateInvite.mock.calls[0][0].patch).toEqual({ lifetime: 'day' })
    await flushPromises()
    await w.find('[data-test="ls-invite-edit-iv-aaaaaaaaaa"]').trigger('click')
    push.host(sharing({ invites: [] }))
    await flushPromises()
    expect(w.find('[data-test="ls-invite-editor"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('Live Share invitations: duplicate, new code, revoke', () => {
  it('duplicates and opens the copy’s form', async () => {
    const dup = invite({ id: 'iv-00000000dup', label: 'Simpa' })
    api.duplicateInvite.mockImplementation(async () => {
      push.host(sharing({ invites: [invite(), dup] }))
      return { ok: true, invite: dup }
    })
    const w = await openWith({ invites: [invite()] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-duplicate-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(api.duplicateInvite).toHaveBeenCalledWith({ id: 'iv-aaaaaaaaaa' })
    expect(w.find('[data-test="ls-invite-iv-00000000dup"] [data-test="ls-invite-editor"]').exists()).toBe(true)
    w.unmount()
  })

  it('a new code keeps the invitation (label, projects, rights) and says so', async () => {
    const w = await openWith({ invites: [invite({ state: 'blocked' })] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-rotate-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(api.rotateInvite).toHaveBeenCalledWith({ id: 'iv-aaaaaaaaaa' })
    expect(w.find('[data-test="ls-host-notice"]').text()).toContain('has a new code')
    w.unmount()
  })

  it('revoking asks first, and offers to remove the people who joined with it', async () => {
    api.revokeInvite.mockResolvedValue({ ok: true, removed: 2 })
    const w = await openWith({ invites: [invite({ joined: 2 })] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-revoke-iv-aaaaaaaaaa"]').trigger('click')
    expect(api.revokeInvite).not.toHaveBeenCalled()
    const confirm = w.find('[data-test="ls-invite-revoke-confirm-iv-aaaaaaaaaa"]')
    expect(confirm.text()).toContain('Revoke “Simpa”? Its code stops letting anyone in.')
    expect(document.activeElement).toBe(w.find('[data-test="ls-invite-revoke-cancel-iv-aaaaaaaaaa"]').element)
    const remove = w.find('[data-test="ls-invite-revoke-remove-iv-aaaaaaaaaa"] input')
    expect(remove.element.checked).toBe(false)
    expect(confirm.text()).toContain('They stay in')
    // Cancel (Escape) first: nothing revoked.
    await confirm.trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="ls-invite-revoke-confirm-iv-aaaaaaaaaa"]').exists()).toBe(false)
    await w.find('[data-test="ls-invite-revoke-iv-aaaaaaaaaa"]').trigger('click')
    await w.find('[data-test="ls-invite-revoke-remove-iv-aaaaaaaaaa"] input').setValue(true)
    await w.find('[data-test="ls-invite-revoke-yes-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(api.revokeInvite).toHaveBeenCalledWith({ id: 'iv-aaaaaaaaaa', removePeople: true })
    expect(w.find('[data-test="ls-host-notice"]').text()).toBe('“Simpa” is revoked, and 2 people who joined with it were removed.')
    w.unmount()
  })

  it('nobody joined with it: no removal offered, its people kept', async () => {
    const w = await openWith({ invites: [invite({ joined: 0 })] })
    await expand(w, 'iv-aaaaaaaaaa')
    await w.find('[data-test="ls-invite-revoke-iv-aaaaaaaaaa"]').trigger('click')
    expect(w.find('[data-test="ls-invite-revoke-remove-iv-aaaaaaaaaa"]').exists()).toBe(false)
    await w.find('[data-test="ls-invite-revoke-yes-iv-aaaaaaaaaa"]').trigger('click')
    expect(api.revokeInvite).toHaveBeenCalledWith({ id: 'iv-aaaaaaaaaa', removePeople: false })
    w.unmount()
  })
})
