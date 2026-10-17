// Live Share's dialog (LiveShareDialog.vue): Share (the setup with the first
// invitation, the overview while sharing, its sections) and Join, against a
// fake window.shellApi.liveShare (src/preload: liveShare). The sections'
// own flows: liveShareInvitations.spec.js and liveSharePeople.spec.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import { fakeApi, OFF_HOST, OFF_GUEST, invite, guest, sharing } from './liveShareFakes'
import { NO_RIGHTS } from '../../../shared/liveShareRights'
import { setMessages } from '../i18n'
import frLiveShare from '../i18n/locales/fr/liveShare.json'
import { inviteUses } from '../liveShareAccess'

const PROJECTS = { projects: [{ id: 'ws-1', name: 'tessel' }, { id: 'ws-2', name: 'site' }], projectIds: ['ws-1'] }

let api
let push
let offs
beforeEach(() => {
  ;({ api, push, offs } = fakeApi())
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function open(props = {}) {
  const wrapper = mount(LiveShareDialog, { props: { open: true, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
async function host(status) {
  push.host({ ...OFF_HOST, ...status })
  await flushPromises()
}
async function guestSays(status) {
  push.guest({ ...OFF_GUEST, ...status })
  await flushPromises()
}

describe('LiveShareDialog: before sharing', () => {
  it('warns, then starts with the name, the projects and the first invitation', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.find('[data-test="ls-overview"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('run any command on this PC as you')
    expect(wrapper.find('[data-test="ls-share-name"]').element.value).toBe('ada')
    // The first invitation: 1 hour, watch only, unless you change it.
    expect(wrapper.find('[data-test="ls-first-toggle"]').text()).toContain('1 hour, watch only')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'], invite: { label: '', lifetime: 'hour', maxUses: 0, rights: { ...NO_RIGHTS, type: false, open: false, close: false } } })
    wrapper.unmount()
  })

  it('the first invitation can be set before starting (label, lifetime, uses, rights)', async () => {
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-first-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="ls-first-toggle"]').attributes('aria-expanded')).toBe('true')
    // No projects there: the first invitation offers every shared project.
    expect(wrapper.find('[data-test="ls-invite-later"]').exists()).toBe(false)
    await wrapper.find('[data-test="ls-invite-label"]').setValue('Team')
    await wrapper.find('[data-test="ls-invite-lifetime-day"] input').setValue(true)
    await wrapper.find('[data-test="ls-invite-uses"]').setValue('3')
    // The rights as presets; each box behind Customize.
    expect(wrapper.find('[data-test="ls-right-open-invite"]').exists()).toBe(false)
    await wrapper.find('[data-test="ls-invite-customize"]').trigger('click')
    const openBox = wrapper.find('[data-test="ls-right-open-invite"] input')
    openBox.element.checked = true
    await openBox.trigger('change')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-first-toggle"]').text()).toContain('1 day, open')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'], invite: { label: 'Team', lifetime: 'day', maxUses: 3, rights: { ...NO_RIGHTS, type: false, open: true, close: false } } })
    wrapper.unmount()
  })

  it('start, copy, send: once shared, the first invitation’s Copy has the keyboard', async () => {
    api.start.mockResolvedValue({ ok: true, ...sharing({ projectIds: ['ws-1'], invites: [invite({ id: 'iv-0000000001', label: '', code: 'TS1.first' })] }) })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    const copy = wrapper.find('[data-test="ls-first-copy-iv-0000000001"]')
    expect(copy.exists()).toBe(true)
    expect(document.activeElement).toBe(copy.element)
    expect(wrapper.find('[data-test="ls-first-iv-0000000001"]').text()).toContain('Invitation')
    await copy.trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('TS1.first')
    expect(copy.text()).toBe('Copied')
    wrapper.unmount()
  })

  it('shares the projects you tick, and needs one', async () => {
    const wrapper = await open(PROJECTS)
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').element.checked).toBe(true)
    expect(box('ws-2').element.checked).toBe(false)
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    wrapper.unmount()
    const none = await open({ projects: PROJECTS.projects, projectIds: [] })
    expect(none.find('[data-test="ls-start"]').attributes('disabled')).toBeDefined()
    expect(none.find('[data-test="ls-need-project"]').text()).toBe('Tick at least one project.')
    none.unmount()
  })

  it('says how far it got, and Cancel stops', async () => {
    const wrapper = await open()
    await host({ state: 'preparing', progress: 0.424 })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Downloading the Cloudflare tunnel… 42%')
    await host({ state: 'checking' })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Checking the address…')
    await wrapper.find('[data-test="ls-cancel-share"]').trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows why sharing failed', async () => {
    api.start.mockResolvedValue({ ok: false, error: 'No internet.' })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('No internet.')
    await host({ state: 'error', error: 'The tunnel stopped.' })
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('The tunnel stopped.')
    wrapper.unmount()
  })

  it('sends plain data, as Electron copies it (the first invitation is reactive: Start sharing threw "could not be cloned")', async () => {
    // Electron's IPC copies arguments with the structured clone, which refuses Vue's proxies.
    api.start.mockImplementation(async (arg) => {
      structuredClone(arg)
      return { ok: false, error: 'No internet.' }
    })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-first-toggle"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('No internet.')
    wrapper.unmount()
  })

  it('a start that throws says why, not only that it failed', async () => {
    api.start.mockRejectedValue(new Error('An object could not be cloned.'))
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('Sharing could not start: An object could not be cloned.')
    wrapper.unmount()
  })

  it('invitations and people need a share (an empty state says so); trusted people do not', async () => {
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-section-invites"]').trigger('click')
    expect(wrapper.find('[data-test="ls-section-off"]').text()).toContain('Start sharing first')
    await wrapper.find('[data-test="ls-section-people"]').trigger('click')
    expect(wrapper.find('[data-test="ls-section-off"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-section-access"]').trigger('click')
    expect(wrapper.find('[data-test="ls-access-off"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-section-trusted"]').trigger('click')
    expect(wrapper.find('[data-test="ls-trusted"]').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('LiveShareDialog: while sharing', () => {
  it('projects ticked or not on the spot; the last one stays', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1'] })
    await host(sharing({ projectIds: ['ws-1'] }))
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-last-project"]').text()).toBe('To stop sharing your last project, use Stop sharing.')
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    wrapper.unmount()
  })

  it('the overview lists the codes to copy and who is there, with a way to each section', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host(sharing({ invites: [invite(), invite({ id: 'iv-bbbbbbbbbb', label: 'Team', state: 'blocked' })], guests: [guest(), guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    expect(wrapper.findAll('[data-test="ls-invite"]').map((x) => x.element.value)).toEqual(['TS1.code-a', 'TS1.code-a'])
    // A blocked code can't be copied from here.
    expect(wrapper.find('[data-test="ls-first-copy-iv-bbbbbbbbbb"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-people-summary"]').text()).toContain('1 connected · 1 waiting for your answer')
    expect(wrapper.find('[data-test="ls-section-invites"]').text()).toContain('2')
    expect(wrapper.find('[data-test="ls-section-people"]').text()).toContain('2')
    expect(wrapper.text()).toContain('Codes stop working when you stop sharing')
    await wrapper.find('[data-test="ls-goto-invites"]').trigger('click')
    expect(wrapper.find('[data-test="ls-invitations"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('with no invitation left: an empty state and a way to make one', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ invites: [] }))
    expect(wrapper.find('[data-test="ls-no-invites"]').text()).toContain('No invitation left')
    wrapper.unmount()
  })

  it('the overview: real group labels, every Copy button the same width, one Stop sharing at a time', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest()], invites: [invite(), invite({ id: 'iv-bbbbbbbbbb', label: 'Design review', expiresAt: null })] }))
    const labels = wrapper.findAll('[data-test="ls-overview"] .ls-label').map((x) => x.text())
    expect(labels).toEqual(['Projects you share', 'Invitation codes', 'Guests', 'Recent guest actions'])
    // Name and expiry in a head line; the code and its button under it.
    for (const item of wrapper.findAll('.ls-first-item')) {
      expect(item.find('.ls-first-head .ls-first-meta').exists()).toBe(true)
      expect(item.element.lastElementChild.tagName).toBe('BUTTON')
    }
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(wrapper.find('[data-test="ls-stop-confirm"]').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((b) => b.text() === 'Stop sharing')).toHaveLength(1)
    // The footer keeps only Close meanwhile (never Start sharing).
    expect(wrapper.find('[data-test="ls-start"]').exists()).toBe(false)
    expect(wrapper.findAll('.confirm-actions > button').map((b) => b.text())).toEqual(['Close'])
    wrapper.unmount()
  })

  it('French: plural uses, the people let in, and times as French writes them', async () => {
    setMessages('fr', frLiveShare)
    try {
      expect(inviteUses({ uses: 1, maxUses: 3 })).toBe('1 utilisation sur 3')
      expect(inviteUses({ uses: 2, maxUses: 3 })).toBe('2 utilisations sur 3')
      const at = new Date(2026, 9, 16, 6, 13).getTime()
      const wrapper = await open(PROJECTS)
      await host(sharing({ invites: [invite({ joined: 2 })], actions: [{ id: 'a1', at, kind: 'save', name: 'Chen', path: 'a.txt', project: 'ws-1' }] }))
      expect(wrapper.find('[data-test="ls-recent-a1"] .ls-recent-time').text()).toBe('06 h 13')
      await wrapper.find('[data-test="ls-section-invites"]').trigger('click')
      expect(wrapper.text()).toContain('2 personnes entrées avec elle')
      wrapper.unmount()
    } finally {
      setMessages('en', {})
    }
  })

  it('Stop sharing asks first while someone is in, and not otherwise', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest()] }))
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="ls-stop-confirm"]').text()).toContain('1 person is disconnected')
    expect(document.activeElement).toBe(wrapper.find('[data-test="ls-stop-cancel"]').element)
    await wrapper.find('[data-test="ls-stop-confirm"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-test="ls-stop-confirm"]').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    await wrapper.find('[data-test="ls-stop-yes"]').trigger('click')
    expect(api.stop).toHaveBeenCalledTimes(1)
    await host(sharing({ guests: [] }))
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('opens on the section asked for (a project’s Who has access…)', async () => {
    api.state.mockResolvedValue({ host: sharing({ guests: [guest()] }), guest: OFF_GUEST, defaultName: 'ada' })
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'], initialSection: 'access', focusProject: 'ws-2' })
    expect(wrapper.find('[data-test="ls-section-access"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-test="ls-access-project"]').text()).toContain('Who has access to site')
    wrapper.unmount()
  })

  it('arrow keys move between the sections', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing())
    const tabs = wrapper.find('.ls-sections')
    await tabs.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('[data-test="ls-section-invites"]').attributes('aria-selected')).toBe('true')
    await tabs.trigger('keydown', { key: 'End' })
    expect(wrapper.find('[data-test="ls-section-trusted"]').attributes('aria-selected')).toBe('true')
    await tabs.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('[data-test="ls-section-overview"]').attributes('aria-selected')).toBe('true')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: Join', () => {
  it('joins with the code and the name, and follows the session', async () => {
    const wrapper = await open({ initialTab: 'join' })
    expect(wrapper.find('[data-test="ls-join"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="ls-join-invite"]').setValue('  tessel-ls:xyz  ')
    await wrapper.find('[data-test="ls-join-name"]').setValue('Bob')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    expect(api.join).toHaveBeenCalledWith({ invite: 'tessel-ls:xyz', name: 'Bob' })
    await guestSays({ state: 'waiting', code: '123 456' })
    expect(wrapper.find('[data-test="ls-code"]').text()).toBe('Your code is 123 456. Tell your host, so they know it is you.')
    await guestSays({ state: 'joined', host: 'Ada', rights: { ...NO_RIGHTS, type: false, open: false, close: false } })
    expect(wrapper.find('[data-test="ls-no-projects"]').text()).toBe('Ada has not given you a project to see yet.')
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch. The host has not let you type yet.')
    await guestSays({ state: 'joined', host: 'Ada', projects: [{ id: 'ws-a', layout: null }], rights: { ...NO_RIGHTS, type: true, open: true, close: false } })
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch and type in its terminals and agents, open terminals and agents.')
    await wrapper.find('[data-test="ls-leave"]').trigger('click')
    expect(api.leave).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('says why the session ended (a reason the host made up shows as ended)', async () => {
    const wrapper = await open({ initialTab: 'join' })
    await guestSays({ state: 'ended', host: 'Ada', reason: 'denied' })
    expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The host said no.')
    // Too many waiting, or a pause after several noes: said plainly.
    await guestSays({ state: 'ended', host: 'Ada', reason: 'busy' })
    expect(wrapper.find('[data-test="ls-ended"]').text()).toContain('The host is not taking new guests right now')
    for (const reason of ['__proto__', 'constructor', 'made-up']) {
      await guestSays({ state: 'ended', host: 'Ada', reason })
      expect(wrapper.find('[data-test="ls-ended"]').text()).toBe('The session ended.')
    }
    wrapper.unmount()
  })

  it('shows a code that is not an invite', async () => {
    api.join.mockResolvedValue({ ok: false, error: 'This is not a Tessel Live Share invite code.' })
    const wrapper = await open({ initialTab: 'join' })
    await wrapper.find('[data-test="ls-join-invite"]').setValue('hello')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-join-error"]').text()).toBe('This is not a Tessel Live Share invite code.')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: keyboard and lifetime', () => {
  it('Escape and the backdrop close it; closing does not stop sharing', async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="live-share-dialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.find('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(api.stop).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('opens on its card and stops listening once gone', async () => {
    const wrapper = await open()
    expect(document.activeElement).toBe(wrapper.find('[data-test="live-share-dialog"]').element)
    wrapper.unmount()
    expect(offs).toHaveLength(2)
    for (const off of offs) expect(off).toHaveBeenCalled()
  })

  it('says so when this version has no Live Share', async () => {
    window.shellApi = {}
    const wrapper = await open()
    expect(wrapper.text()).toContain('Live Share is not available in this version.')
    wrapper.unmount()
  })
})
