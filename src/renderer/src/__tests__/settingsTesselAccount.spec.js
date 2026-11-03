import { describe, it, expect, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const page = ref('tessel-account')
vi.mock('../components/settings/settingsShell', () => ({
  useSettingsShell: () => ({ shown: (id) => page.value === id })
}))
const { default: SettingsTesselAccount } = await import('../components/settings/SettingsTesselAccount.vue')

const OUT = { signedIn: false, user: null, signingIn: false, offline: false, error: null }
const IN = { signedIn: true, user: { email: 'me@gmail.com', name: 'Me', hasPassword: true, hasGoogle: false, hasGitHub: false }, signingIn: false, offline: false, error: null }
const GOOGLE_ONLY = { ...IN, user: { ...IN.user, hasPassword: false, hasGoogle: true } }
const WAITING = { ...OUT, signingIn: true }

function api(over = {}) {
  return {
    status: vi.fn(async () => OUT),
    signIn: vi.fn(async () => WAITING),
    passwordLink: vi.fn(async () => ({ ...IN, done: 'linkSent' })),
    cancel: vi.fn(async () => OUT),
    signOut: vi.fn(async () => OUT),
    delete: vi.fn(async () => ({ ...OUT, deleted: true })),
    ...over
  }
}
let w
async function mountPage(tesselAccount, askConfirm = async () => true) {
  window.shellApi = { tesselAccount, openExternal: vi.fn() }
  w = mount(SettingsTesselAccount, { global: { provide: { askConfirm } } })
  await flushPromises()
  return w
}

afterEach(() => {
  if (w) w.unmount()
  w = null
  page.value = 'tessel-account'
  vi.useRealTimers()
  delete window.shellApi
})

describe('Settings > Tessel account', () => {
  it('asks the server only when the page shows', async () => {
    page.value = 'general'
    const a = api()
    await mountPage(a)
    expect(a.status).not.toHaveBeenCalled()
    page.value = 'tessel-account'
    await flushPromises()
    expect(a.status).toHaveBeenCalledWith({ check: true })
  })

  it('signed out: one button, what comes with an account marked as not there yet, and no password field', async () => {
    await mountPage(api())
    expect(w.get('.tessel-account-open').text()).toBe('Sign in to Tessel')
    expect(w.find('input').exists()).toBe(false)
    expect(w.get('[data-included]').text()).toContain('Included with your account')
    // Your settings everywhere and Gmail in one click both work now: nothing says Soon.
    expect(w.findAll('[data-included] .tag')).toHaveLength(0)
    expect(w.get('[data-included]').text()).toContain('Your settings everywhere')
    expect(w.text()).toContain('It is optional')
    expect(w.text()).toContain('Never your mail, calendar or files')
    expect(w.find('.tessel-account-delete').exists()).toBe(false)
    expect(w.find('.tessel-account-password').exists()).toBe(false)
  })

  it('the button opens the browser, then follows it and shows who is signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = api()
    await mountPage(a)
    await w.get('.tessel-account-open').trigger('click')
    await flushPromises()
    expect(a.signIn).toHaveBeenCalled()
    expect(w.text()).toContain('Finish signing in in your browser')
    a.status.mockResolvedValue(IN)
    vi.advanceTimersByTime(1600)
    await flushPromises()
    expect(w.get('.tessel-account-who').text()).toBe('me@gmail.com')
    const calls = a.status.mock.calls.length
    vi.advanceTimersByTime(10000)
    await flushPromises()
    expect(a.status.mock.calls.length).toBe(calls)
  })

  it('Cancel stops it', async () => {
    const a = api({ status: vi.fn(async () => WAITING) })
    await mountPage(a)
    await w.get('.tessel-account-cancel').trigger('click')
    await flushPromises()
    expect(a.cancel).toHaveBeenCalled()
    expect(w.find('.tessel-account-open').exists()).toBe(true)
  })

  it('comes back to a sign-in still waiting, and stops asking once closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const a = api({ status: vi.fn(async () => WAITING) })
    await mountPage(a)
    expect(w.text()).toContain('Finish signing in')
    w.unmount()
    w = null
    const calls = a.status.mock.calls.length
    vi.advanceTimersByTime(10000)
    await flushPromises()
    expect(a.status.mock.calls.length).toBe(calls)
  })

  it.each([
    ['denied', 'was refused'],
    ['accountExists', 'already uses this address'],
    ['expired', 'took too long'],
    ['offline', 'could not reach its server'],
    ['refused', 'server refused'],
    ['noSecureStorage', 'Secure storage is not available'],
    ['rateLimited', 'Too many tries'],
    ['signedOut', 'session ended'],
    ['failed', 'did not work']
  ])('says what happened: %s', async (error, text) => {
    await mountPage(api({ status: vi.fn(async () => ({ ...OUT, error })) }))
    expect(w.get('.tessel-account-error').text()).toContain(text)
  })

  it('signed in while offline: stays signed in and says so', async () => {
    await mountPage(api({ status: vi.fn(async () => ({ ...IN, offline: true })) }))
    expect(w.text()).toContain('You stay signed in')
    expect(w.find('.tessel-account-out').exists()).toBe(true)
  })

  it.each([
    ['with a password, to change it', IN, 'Change your password'],
    ['with only Google, to choose one', GOOGLE_ONLY, 'Choose a password']
  ])('an account %s gets a link by email, and no password field', async (_what, user, title) => {
    const a = api({ status: vi.fn(async () => user), passwordLink: vi.fn(async () => ({ ...user, done: 'linkSent' })) })
    await mountPage(a)
    expect(w.text()).toContain(title)
    expect(w.find('input').exists()).toBe(false)
    await w.get('.tessel-account-password').trigger('click')
    await flushPromises()
    expect(a.passwordLink).toHaveBeenCalled()
    expect(w.get('.tessel-account-notice').text()).toContain('on its way')
  })

  it('a link that could not be sent says so', async () => {
    const a = api({ status: vi.fn(async () => IN), passwordLink: vi.fn(async () => ({ ...IN, error: 'rateLimited' })) })
    await mountPage(a)
    await w.get('.tessel-account-password').trigger('click')
    await flushPromises()
    expect(w.find('.tessel-account-notice').exists()).toBe(false)
    expect(w.get('.tessel-account-error').text()).toContain('Too many tries')
  })

  it("the owner's account has an Administration button to the admin panel; others have none", async () => {
    await mountPage(api())
    expect(w.find('.tessel-account-admin').exists()).toBe(false)
    w.unmount()
    await mountPage(api({ status: vi.fn(async () => ({ ...IN, user: { ...IN.user, admin: true } })) }))
    await w.get('.tessel-account-admin').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://admin.tesselcode.com')
  })

  it('signs out', async () => {
    const a = api({ status: vi.fn(async () => IN) })
    await mountPage(a)
    await w.get('.tessel-account-out').trigger('click')
    await flushPromises()
    expect(a.signOut).toHaveBeenCalled()
    expect(w.find('.tessel-account-open').exists()).toBe(true)
  })

  it('deleting asks first, and does nothing if refused', async () => {
    const a = api({ status: vi.fn(async () => IN) })
    const askConfirm = vi.fn(async () => false)
    await mountPage(a, askConfirm)
    await w.get('.tessel-account-delete').trigger('click')
    await flushPromises()
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true, title: 'Delete your Tessel account?' }))
    expect(a.delete).not.toHaveBeenCalled()
  })

  it('deleting, once agreed, says it is done; a failure says so too', async () => {
    let a = api({ status: vi.fn(async () => IN) })
    await mountPage(a)
    await w.get('.tessel-account-delete').trigger('click')
    await flushPromises()
    expect(a.delete).toHaveBeenCalled()
    expect(w.get('.tessel-account-notice').text()).toBe('Your account was deleted.')
    w.unmount()

    a = api({ status: vi.fn(async () => IN), delete: vi.fn(async () => ({ ...IN, deleted: false, error: 'offline' })) })
    await mountPage(a)
    await w.get('.tessel-account-delete').trigger('click')
    await flushPromises()
    expect(w.find('.tessel-account-notice').exists()).toBe(false)
    expect(w.get('.tessel-account-error').text()).toContain('could not reach its server')
    expect(w.find('.tessel-account-out').exists()).toBe(true)
  })

  it('the page newer than its background code asks for a restart', async () => {
    window.shellApi = {}
    w = mount(SettingsTesselAccount, { global: { provide: { askConfirm: async () => true } } })
    await flushPromises()
    expect(w.text()).toContain('Restart Tessel')
    expect(w.find('.tessel-account-open').exists()).toBe(false)
  })

  it('opens the privacy policy in the outside browser', async () => {
    await mountPage(api())
    await w.get('.tessel-account-privacy').trigger('click')
    expect(window.shellApi.openExternal).toHaveBeenCalledWith('https://tesselcode.com/privacy')
  })
})
