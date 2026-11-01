import { it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { isProxy } from 'vue'
import BrowserPasswords from '../components/BrowserPasswords.vue'

// Fixture logins only: no real site, user or password appears here.
const entry = (i, extra = {}) => ({ id: `id-${i}`, origin: `https://site-${String(i).padStart(4, '0')}.test`, username: `user-${i}`, allowAgents: false, ...extra })

let wrapper
afterEach(() => { wrapper?.unmount(); wrapper = null; delete window.shellApi })

async function openDialog(browser, opts = {}) {
  window.shellApi = { browser: { passwordSources: async () => ({ ok: true, sources: [] }), passwordList: async () => ({ ok: true, entries: [] }), ...browser } }
  wrapper = mount(BrowserPasswords, { props: opts.props || {}, global: { stubs: { teleport: true }, provide: opts.provide || {} } })
  await wrapper.find('[data-test=browser-passwords]').trigger('click'); await flushPromises()
  return wrapper
}

it('sends a cloneable plain profile across Electron IPC instead of a Vue proxy', async () => {
  const passwordImportProfile = vi.fn(async (opts) => {
    expect(isProxy(opts)).toBe(false)
    expect(JSON.parse(JSON.stringify(opts))).toEqual({ browserId: 'chrome', profileDir: 'C:/fixture/Default' })
    return { ok: true, imported: 1, added: 1, updated: 0, unchanged: 0, skipped: 0, protectedCount: 1, appBoundCount: 0 }
  })
  const w = await openDialog({
    passwordSources: async () => ({ ok: true, sources: [{ id: 'chrome', name: 'Chrome', family: 'chromium', profiles: [{ dir: 'C:/fixture/Default', name: 'Default' }] }] }),
    passwordImportProfile
  })
  await w.find('[data-test=pw-import-one]').trigger('click'); await flushPromises()
  expect(passwordImportProfile).toHaveBeenCalledOnce()
  expect(w.find('[role=status]').text()).toContain('1 new')
  expect(w.find('[role=status]').text()).toContain('1 protected')
  expect(w.find('details').element.open).toBe(true)
  expect(w.find('details').text()).toContain('Google Password Manager')
})

it('imports every profile of every browser in turn; one failing profile does not stop the others', async () => {
  const sources = [
    { id: 'chrome', name: 'Chrome', family: 'chromium', profiles: [{ dir: 'C:/fixture/chrome/Default', name: 'Default' }, { dir: 'C:/fixture/chrome/Profile 1', name: 'Work' }] },
    { id: 'firefox', name: 'Firefox', family: 'firefox', profiles: [{ dir: 'C:/fixture/ff/abc.default', name: 'default' }] },
    { id: 'edge', name: 'Edge', family: 'chromium', profiles: [{ dir: 'C:/fixture/edge/Default', name: 'Default' }] }
  ]
  const answers = {
    'C:/fixture/chrome/Default': async () => ({ ok: true, imported: 3, added: 2, updated: 1, unchanged: 4, skipped: 1, protectedCount: 0, appBoundCount: 5 }),
    'C:/fixture/chrome/Profile 1': async () => { throw new Error('ipc broke') },
    'C:/fixture/ff/abc.default': async () => ({ ok: false, code: 'primary-password' }),
    'C:/fixture/edge/Default': async () => ({ ok: true, imported: 7, added: 7, updated: 0, unchanged: 0, skipped: 0, protectedCount: 0, appBoundCount: 0 })
  }
  const passwordImportProfile = vi.fn((opts) => answers[opts.profileDir]())
  const passwordList = vi.fn(async () => ({ ok: true, entries: [] }))
  const w = await openDialog({ passwordSources: async () => ({ ok: true, sources }), passwordList, passwordImportProfile })
  passwordList.mockClear()
  await w.find('[data-test=pw-import-all]').trigger('click'); await flushPromises()

  expect(passwordImportProfile.mock.calls.map((c) => c[0])).toEqual([
    { browserId: 'chrome', profileDir: 'C:/fixture/chrome/Default' },
    { browserId: 'chrome', profileDir: 'C:/fixture/chrome/Profile 1' },
    { browserId: 'firefox', profileDir: 'C:/fixture/ff/abc.default' },
    { browserId: 'edge', profileDir: 'C:/fixture/edge/Default' }
  ])
  const rows = w.findAll('[data-test=pw-result]')
  expect(rows).toHaveLength(4)
  expect(rows[0].text()).toContain('Chrome — Default')
  expect(rows[0].text()).toContain('2 new')
  expect(rows[0].text()).toContain('1 updated')
  expect(rows[0].text()).toContain('4 already saved')
  expect(rows[0].text()).toContain('1 skipped')
  expect(rows[0].text()).toContain('5 locked by App-Bound Encryption')
  expect(rows[1].text()).toContain('Chrome — Work')
  expect(rows[1].text()).toContain('could not be completed')
  expect(rows[2].text()).toContain('Primary Password')
  expect(rows[3].text()).toContain('Edge — Default')
  expect(rows[3].text()).toContain('7 new')
  expect(w.find('[data-test=pw-results]').text()).toContain('4 profiles read: 9 new accounts. 3 need attention.')
  expect(passwordList).toHaveBeenCalled() // the list is read again afterwards

  // "How to export" on the Firefox result shows that profile's steps.
  await rows[2].find('button').trigger('click')
  expect(w.find('details').element.open).toBe(true)
  expect(w.find('details').text()).toContain('Firefox — default')
  expect(w.find('details').text()).toContain('In Firefox')
})

it('searches site and username, case-insensitive, with the count and an empty-result message', async () => {
  const entries = [
    entry(1, { origin: 'https://mail.example.test', username: 'alice' }),
    entry(2, { origin: 'https://shop.test', username: 'Bob@Example.test' }),
    entry(3, { origin: 'https://bank.test', username: 'carol', allowAgents: true }),
    entry(4, { origin: 'https://news.test', username: 'dave' }),
    entry(5, { origin: 'https://forum.test', username: 'erin' })
  ]
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries }) })
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(5)
  expect(w.find('[data-test=pw-count]').text()).toBe('5 accounts')
  expect(w.find('[data-test=pw-agents]').text()).toBe('1 allowed for agents')
  // Sorted by site.
  expect(w.findAll('[data-test=pw-row] .pw-site').map((s) => s.text())).toEqual(['bank.test', 'forum.test', 'mail.example.test', 'news.test', 'shop.test'])

  await w.find('[data-test=pw-search]').setValue('EXAMPLE')
  expect(w.findAll('[data-test=pw-row]').map((r) => r.find('.pw-user').text())).toEqual(['alice', 'Bob@Example.test'])
  expect(w.find('[data-test=pw-count]').text()).toBe('2 of 5')

  await w.find('[data-test=pw-search]').setValue('shop bob')
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(1)

  await w.find('[data-test=pw-search]').setValue('nothing-like-this')
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(0)
  expect(w.find('[data-test=pw-no-match]').text()).toContain('nothing-like-this')
  expect(w.find('[data-test=pw-count]').text()).toBe('0 of 5')
})

it('draws a page of rows at a time with 5000 logins', async () => {
  const entries = Array.from({ length: 5000 }, (_, i) => entry(i))
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries }) })
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(200)
  expect(w.find('[data-test=pw-more]').text()).toContain('4800 left')
  await w.find('[data-test=pw-more]').trigger('click')
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(400)
  await w.find('[data-test=pw-search]').setValue('site-4999')
  expect(w.findAll('[data-test=pw-row]')).toHaveLength(1)
  expect(w.find('[data-test=pw-more]').exists()).toBe(false)
})

it('shows only site and username, and agent access is an explicit per-account switch', async () => {
  // Even if a field the window must never get slipped through, it is not drawn.
  const stray = entry(1, { origin: 'https://example.test', username: 'fixture-user', password: 'fixture-not-a-secret', note: 'fixture-note' })
  const passwordChange = vi.fn(async () => ({ ok: true }))
  const w = await openDialog({ passwordList: vi.fn(async () => ({ ok: true, entries: [stray] })), passwordChange, passwordFill: vi.fn(async () => ({ ok: true })) }, { props: { guestId: 7 } })
  expect(w.text()).toContain('fixture-user')
  expect(w.text()).toContain('example.test')
  expect(w.html()).not.toContain('fixture-not-a-secret')
  expect(w.html()).not.toContain('fixture-note')
  expect(w.html()).not.toContain('id-1')
  expect(w.find('input[type=password]').exists()).toBe(false)
  const toggle = w.find('[data-test=pw-row] input.set-switch')
  expect(toggle.element.checked).toBe(false)
  await toggle.setValue(true); await flushPromises()
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-1', action: 'allow', allowAgents: true })
  expect(w.text()).not.toMatch(/allow all/i)
})

it('removes a login only after confirming', async () => {
  const passwordChange = vi.fn(async () => ({ ok: true }))
  const askConfirm = vi.fn(async () => false)
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries: [entry(1)] }), passwordChange }, { provide: { askConfirm } })
  await w.find('[data-test=pw-row] .pw-icon.danger').trigger('click'); await flushPromises()
  expect(askConfirm).toHaveBeenCalledOnce()
  expect(passwordChange).not.toHaveBeenCalled()
  askConfirm.mockResolvedValueOnce(true)
  await w.find('[data-test=pw-row] .pw-icon.danger').trigger('click'); await flushPromises()
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-1', action: 'delete' })
})

it('the header switch allows every account shown, after a question that says how many; declining changes nothing', async () => {
  const passwordChange = vi.fn(async () => ({ ok: true }))
  const askConfirm = vi.fn(async () => false)
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries: [entry(1), entry(2), entry(3, { allowAgents: true })] }), passwordChange }, { provide: { askConfirm } })
  await w.find('[data-test=pw-allow-all]').setValue(true); await flushPromises()
  expect(askConfirm).toHaveBeenCalledOnce()
  expect(askConfirm.mock.calls[0][0]).toMatchObject({ danger: true })
  expect(askConfirm.mock.calls[0][0].title).toContain('2') // only the two not allowed yet
  expect(passwordChange).not.toHaveBeenCalled()
  askConfirm.mockResolvedValueOnce(true)
  await w.find('[data-test=pw-allow-all]').setValue(true); await flushPromises()
  expect(passwordChange).toHaveBeenCalledTimes(2)
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-1', action: 'allow', allowAgents: true })
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-2', action: 'allow', allowAgents: true })
})

it('without a way to ask, nothing is allowed in bulk; forbidding all is not asked', async () => {
  const passwordChange = vi.fn(async () => ({ ok: true }))
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries: [entry(1, { allowAgents: true }), entry(2, { allowAgents: true })] }), passwordChange })
  await w.find('[data-test=pw-allow-all]').setValue(false); await flushPromises()
  expect(passwordChange).toHaveBeenCalledTimes(2)
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-1', action: 'allow', allowAgents: false })
  passwordChange.mockClear()
  const w2 = await openDialog({ passwordList: async () => ({ ok: true, entries: [entry(1), entry(2)] }), passwordChange })
  await w2.find('[data-test=pw-allow-all]').setValue(true); await flushPromises()
  expect(passwordChange).not.toHaveBeenCalled()
})

it('the header switch follows the search: only the matching accounts, all of them (not only the 200 drawn)', async () => {
  const passwordChange = vi.fn(async () => ({ ok: true }))
  const many = Array.from({ length: 300 }, (_, i) => entry(i + 1))
  const askConfirm = vi.fn(async () => true)
  const w = await openDialog({ passwordList: async () => ({ ok: true, entries: many }), passwordChange }, { provide: { askConfirm } })
  await w.find('[data-test=pw-allow-all]').setValue(true); await flushPromises()
  expect(passwordChange).toHaveBeenCalledTimes(300)
  passwordChange.mockClear()
  await w.find('input[type=search], [data-test=pw-search]').setValue('site-0007'); await flushPromises()
  await w.find('[data-test=pw-allow-all]').setValue(true); await flushPromises()
  expect(passwordChange).toHaveBeenCalledTimes(1)
  expect(passwordChange).toHaveBeenCalledWith({ id: 'id-7', action: 'allow', allowAgents: true })
})
