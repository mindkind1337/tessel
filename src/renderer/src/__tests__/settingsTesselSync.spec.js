import { describe, it, expect, afterEach, vi } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const page = ref('tessel-account')
vi.mock('../components/settings/settingsShell', () => ({
  useSettingsShell: () => ({ shown: (id) => page.value === id })
}))
const { default: SettingsTesselSync } = await import('../components/settings/SettingsTesselSync.vue')

const PHRASE = 'correct horse battery staple'
const OFF = { signedIn: true, canSeal: true, on: false, state: 'off', busy: false, device: 'DESKTOP-1', lastSyncAt: null, remote: null, staged: null, problem: null, notice: null }
const ON = { ...OFF, on: true, state: 'on', lastSyncAt: 1_800_000_000_000 }
const NEWER = { ...ON, state: 'newer', remote: { device: 'LAPTOP-2', at: 1_800_000_000_000, older: false, unreadable: false, first: false } }
const STAGED = { ...ON, state: 'staged', staged: { device: 'LAPTOP-2', at: 1_800_000_000_000, missing: [] } }
const NEEDS = { ...ON, state: 'needsPhrase' }

function api(over = {}) {
  return {
    status: vi.fn(async () => OFF),
    peek: vi.fn(async () => ({ ...OFF, copy: null })),
    turnOn: vi.fn(async () => ON),
    startOver: vi.fn(async () => ON),
    turnOff: vi.fn(async () => OFF),
    syncNow: vi.fn(async () => ON),
    apply: vi.fn(async () => STAGED),
    cancelApply: vi.fn(async () => NEWER),
    keepMine: vi.fn(async () => ON),
    restart: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => {}),
    ...over
  }
}

let w
async function mountPage(tesselSync, provide = {}) {
  window.shellApi = { tesselSync }
  w = mount(SettingsTesselSync, { global: { provide: { askConfirm: vi.fn(async () => true), saveBeforeBackup: vi.fn(async () => {}), restartApp: vi.fn((resolve) => resolve({ ok: true })), ...provide } } })
  await flushPromises()
  return w
}
const type = async (selector, value) => w.get(selector).setValue(value)
const submit = async () => {
  await w.get('[data-sync-form]').trigger('submit')
  await flushPromises()
}

afterEach(() => {
  if (w) w.unmount()
  w = null
  page.value = 'tessel-account'
  delete window.shellApi
})

describe('Your settings everywhere', () => {
  it('asks the server only when the page shows, and shows nothing without the background code', async () => {
    page.value = 'general'
    const a = api()
    await mountPage(a)
    expect(a.status).not.toHaveBeenCalled()
    page.value = 'tessel-account'
    await flushPromises()
    expect(a.status).toHaveBeenCalledWith({ check: true })
    w.unmount()
    window.shellApi = {}
    w = mount(SettingsTesselSync)
    await flushPromises()
    expect(w.find('[data-sync]').exists()).toBe(false)
  })

  it('off: says what it does and that the server cannot read it; asks nothing else until asked', async () => {
    const a = api()
    await mountPage(a)
    expect(w.text()).toContain('Tessel\'s server cannot read them')
    expect(w.text()).toContain('never leave this computer')
    expect(a.peek).not.toHaveBeenCalled()
    expect(w.find('input').exists()).toBe(false)
  })

  it('without secure storage it says so and does not offer it', async () => {
    await mountPage(api({ status: vi.fn(async () => ({ ...OFF, canSeal: false })) }))
    expect(w.get('.tessel-sync-on').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('Secure storage is not available')
  })

  describe('the first computer', () => {
    async function open(a = api()) {
      await mountPage(a)
      await w.get('.tessel-sync-on').trigger('click')
      await flushPromises()
      return a
    }

    it('choosing a phrase says plainly that it cannot be recovered, and asks it twice', async () => {
      await open()
      expect(w.text()).toContain('At least 12 characters')
      expect(w.text()).toContain('nobody can recover it')
      expect(w.text()).toContain('starting over erases the copy on the server')
      expect(w.get('.tessel-sync-phrase').attributes('type')).toBe('password')
      expect(w.get('.tessel-sync-again').attributes('type')).toBe('password')
      expect(w.get('.tessel-sync-phrase').attributes('autocomplete')).toBe('off')
    })

    it('a short phrase or two different ones stop here', async () => {
      const a = await open()
      await type('.tessel-sync-phrase', 'too short')
      await type('.tessel-sync-again', 'too short')
      await submit()
      expect(w.get('[data-sync-error]').text()).toContain('at least 12')
      await type('.tessel-sync-phrase', PHRASE)
      await type('.tessel-sync-again', `${PHRASE}x`)
      await submit()
      expect(w.get('[data-sync-error]').text()).toContain('not the same')
      expect(a.turnOn).not.toHaveBeenCalled()
    })

    it('the phrase goes to the background once and is forgotten here at once', async () => {
      const a = await open()
      await type('.tessel-sync-phrase', PHRASE)
      await type('.tessel-sync-again', PHRASE)
      await submit()
      expect(a.turnOn).toHaveBeenCalledTimes(1)
      expect(a.turnOn).toHaveBeenCalledWith(PHRASE)
      expect(w.find('[data-sync-form]').exists()).toBe(false)
      expect(w.html()).not.toContain(PHRASE)
      expect(JSON.stringify(w.vm.$data || {})).not.toContain(PHRASE)
      expect(w.get('[data-sync-state]').text()).toBe('On')
    })

    it('offline, the form says so and stays', async () => {
      const a = await open(api({ turnOn: vi.fn(async () => ({ ...OFF, error: 'offline' })) }))
      await type('.tessel-sync-phrase', PHRASE)
      await type('.tessel-sync-again', PHRASE)
      await submit()
      expect(a.turnOn).toHaveBeenCalled()
      expect(w.get('[data-sync-error]').text()).toContain('could not reach its server')
      expect(w.find('[data-sync-form]').exists()).toBe(true)
    })

    it('a form that could not ask the server does not open', async () => {
      await mountPage(api({ peek: vi.fn(async () => ({ ...OFF, error: 'offline' })) }))
      await w.get('.tessel-sync-on').trigger('click')
      await flushPromises()
      expect(w.find('[data-sync-form]').exists()).toBe(false)
      expect(w.get('[data-sync-error]').text()).toContain('could not reach its server')
    })
  })

  describe('a computer with a copy on the server', () => {
    const withCopy = (over = {}) => api({ peek: vi.fn(async () => ({ ...OFF, copy: { device: 'LAPTOP-2', at: 1_800_000_000_000 } })), ...over })
    async function open(a = withCopy(), provide) {
      await mountPage(a, provide)
      await w.get('.tessel-sync-on').trigger('click')
      await flushPromises()
      return a
    }

    it('says whose it is, and asks the phrase once', async () => {
      await open()
      expect(w.text()).toContain('A copy from LAPTOP-2')
      expect(w.find('.tessel-sync-again').exists()).toBe(false)
    })

    it('the wrong phrase is refused clearly, and the field is empty again', async () => {
      await open(withCopy({ turnOn: vi.fn(async () => ({ ...OFF, error: 'wrongPhrase' })) }))
      await type('.tessel-sync-phrase', 'a wrong phrase of some kind')
      await submit()
      expect(w.get('[data-sync-error]').text()).toContain('does not open your copy')
      expect(w.get('.tessel-sync-phrase').element.value).toBe('')
      expect(w.find('[data-sync-form]').exists()).toBe(true)
    })

    it('a lost phrase: starting over says what it erases, and asks first', async () => {
      const askConfirm = vi.fn(async () => false)
      const a = await open(withCopy(), { askConfirm })
      await w.get('.tessel-sync-lost').trigger('click')
      expect(w.text()).toContain('erases the copy on the server')
      expect(w.text()).toContain('cannot be recovered')
      await type('.tessel-sync-phrase', PHRASE)
      await type('.tessel-sync-again', PHRASE)
      await submit()
      expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
      expect(a.startOver).not.toHaveBeenCalled()
      askConfirm.mockResolvedValue(true)
      await submit()
      expect(a.startOver).toHaveBeenCalledWith(PHRASE)
      expect(a.turnOn).not.toHaveBeenCalled()
    })
  })

  describe('on', () => {
    it('shows its state, the last sync and this computer\'s name', async () => {
      await mountPage(api({ status: vi.fn(async () => ON) }))
      expect(w.get('[data-sync-state]').text()).toBe('On')
      expect(w.get('[data-sync-last]').text()).toContain('Last synced')
      expect(w.get('[data-sync-device]').text()).toContain('DESKTOP-1')
      expect(w.text()).toContain('nobody can recover it')
      expect(w.text()).toContain('Starting over erases the copy on the server')
    })

    it('Sync now writes the latest state first', async () => {
      const a = api({ status: vi.fn(async () => ON) })
      const saveBeforeBackup = vi.fn(async () => {})
      await mountPage(a, { saveBeforeBackup })
      await w.get('.tessel-sync-now').trigger('click')
      await flushPromises()
      expect(saveBeforeBackup).toHaveBeenCalled()
      expect(a.syncNow).toHaveBeenCalled()
    })

    it.each([
      ['offline', 'It tries again by itself'],
      ['failed', 'It tries again by itself'],
      ['tooBig', 'too big to sync'],
      ['rateLimited', 'Too many saves'],
      ['tampered', 'changed or damaged'],
      ['newerApp', 'Update Tessel first']
    ])('a problem in the background is said quietly: %s', async (problem, text) => {
      await mountPage(api({ status: vi.fn(async () => ({ ...ON, problem })) }))
      expect(w.get('[data-sync-problem]').text()).toContain(text)
      expect(w.find('[role="alert"]').exists()).toBe(false)
    })

    it('what the background says while the page is open shows at once', async () => {
      let tell
      await mountPage(api({ status: vi.fn(async () => ON), onChanged: vi.fn((cb) => { tell = cb; return () => {} }) }))
      tell(NEWER)
      await flushPromises()
      expect(w.find('[data-sync-newer]').exists()).toBe(true)
    })

    it('stops listening when it goes', async () => {
      const stop = vi.fn()
      await mountPage(api({ onChanged: vi.fn(() => stop) }))
      w.unmount()
      w = null
      expect(stop).toHaveBeenCalled()
    })
  })

  it('too many tries on a click says to wait, and that it is not a background problem', async () => {
    const a = api({ status: vi.fn(async () => NEWER), keepMine: vi.fn(async () => ({ ...NEWER, error: 'rateLimited', problem: 'rateLimited' })) })
    await mountPage(a)
    await w.get('.tessel-sync-keep').trigger('click')
    await flushPromises()
    expect(w.get('[data-sync-error]').text()).toContain('Wait a minute')
    expect(w.find('[data-sync-problem]').exists()).toBe(false)
  })

  describe('turning off', () => {
    const open = async (a) => {
      await mountPage(a)
      await w.get('.tessel-sync-off').trigger('click')
      await flushPromises()
    }

    it('keeps the copy unless asked, without a question', async () => {
      const a = api({ status: vi.fn(async () => ON) })
      const askConfirm = vi.fn(async () => true)
      window.shellApi = { tesselSync: a }
      w = mount(SettingsTesselSync, { global: { provide: { askConfirm } } })
      await flushPromises()
      await w.get('.tessel-sync-off').trigger('click')
      expect(w.text()).toContain('Also erase the copy on the server')
      expect(w.text()).toContain('Your settings on this computer are not touched')
      await w.get('[data-sync-off-confirm]').trigger('click')
      await flushPromises()
      expect(askConfirm).not.toHaveBeenCalled()
      expect(a.turnOff).toHaveBeenCalledWith({ erase: false })
    })

    it('erasing asks first', async () => {
      const a = api({ status: vi.fn(async () => ON) })
      await open(a)
      await w.get('.tessel-sync-erase').setValue(true)
      await w.get('[data-sync-off-confirm]').trigger('click')
      await flushPromises()
      expect(a.turnOff).toHaveBeenCalledWith({ erase: true })
    })

    it('if the server cannot erase, it stays on and says so', async () => {
      const a = api({ status: vi.fn(async () => ON), turnOff: vi.fn(async () => ({ ...ON, error: 'offline' })) })
      await open(a)
      await w.get('.tessel-sync-erase').setValue(true)
      await w.get('[data-sync-off-confirm]').trigger('click')
      await flushPromises()
      expect(w.get('[data-sync-error]').text()).toContain('could not reach its server')
      expect(w.find('[data-sync-off-panel]').exists()).toBe(true)
      expect(w.find('[data-sync-state]').exists()).toBe(true)
    })

    it('Cancel closes it', async () => {
      const a = api({ status: vi.fn(async () => ON) })
      await open(a)
      await w.get('[data-sync-off-cancel]').trigger('click')
      expect(w.find('[data-sync-off-panel]').exists()).toBe(false)
      expect(a.turnOff).not.toHaveBeenCalled()
    })

    it('erased elsewhere: says that this computer stopped and its settings did not change', async () => {
      await mountPage(api({ status: vi.fn(async () => ({ ...OFF, notice: 'erased' })) }))
      expect(w.get('[data-sync-erased]').text()).toContain('Your settings here did not change')
    })
  })

  describe('a newer copy', () => {
    it('shows which computer and when; nothing happens without a choice', async () => {
      const a = api({ status: vi.fn(async () => NEWER) })
      await mountPage(a)
      const text = w.get('[data-sync-newer]').text()
      expect(text).toContain('LAPTOP-2')
      expect(text).toContain(new Date(1_800_000_000_000).toLocaleString())
      expect(text).toContain('Nothing changes and nothing is sent until you choose')
      expect(a.apply).not.toHaveBeenCalled()
      expect(a.keepMine).not.toHaveBeenCalled()
    })

    it('using it asks first, says what it replaces and that nothing restarts, then stages', async () => {
      const askConfirm = vi.fn(async () => true)
      const a = api({ status: vi.fn(async () => NEWER) })
      await mountPage(a, { askConfirm })
      await w.get('.tessel-sync-apply').trigger('click')
      await flushPromises()
      const asked = askConfirm.mock.calls[0][0]
      expect(asked.title).toContain('LAPTOP-2')
      expect(asked.text).toContain('Tessel does not restart by itself')
      expect(asked.text).toContain('that are not in that layout are closed')
      expect(asked.text).toContain('What decides what agents may do stays as it is here')
      expect(asked.text).toContain('import-backups')
      expect(a.apply).toHaveBeenCalled()
      expect(w.find('[data-sync-staged]').exists()).toBe(true)
      expect(a.restart).not.toHaveBeenCalled()
    })

    it('saying no does nothing', async () => {
      const a = api({ status: vi.fn(async () => NEWER) })
      await mountPage(a, { askConfirm: vi.fn(async () => false) })
      await w.get('.tessel-sync-apply').trigger('click')
      await flushPromises()
      await w.get('.tessel-sync-keep').trigger('click')
      await flushPromises()
      expect(a.apply).not.toHaveBeenCalled()
      expect(a.keepMine).not.toHaveBeenCalled()
    })

    it('keeping this computer\'s writes the latest state, then sends it', async () => {
      const saveBeforeBackup = vi.fn(async () => {})
      const a = api({ status: vi.fn(async () => NEWER) })
      await mountPage(a, { saveBeforeBackup })
      await w.get('.tessel-sync-keep').trigger('click')
      await flushPromises()
      expect(saveBeforeBackup).toHaveBeenCalled()
      expect(a.keepMine).toHaveBeenCalled()
      expect(w.find('[data-sync-newer]').exists()).toBe(false)
    })

    it('a damaged copy is said and cannot be used, only replaced', async () => {
      await mountPage(api({ status: vi.fn(async () => ({ ...NEWER, problem: 'tampered', remote: { ...NEWER.remote, unreadable: true } })) }))
      expect(w.get('[data-sync-newer]').text()).toContain('changed or damaged')
      expect(w.find('[data-sync-problem]').exists()).toBe(false)
      expect(w.find('.tessel-sync-apply').exists()).toBe(false)
      expect(w.find('.tessel-sync-keep').exists()).toBe(true)
    })

    it('an older copy is called that', async () => {
      await mountPage(api({ status: vi.fn(async () => ({ ...NEWER, remote: { ...NEWER.remote, older: true } })) }))
      expect(w.get('[data-sync-newer]').text()).toContain('older than the one this computer last saw')
    })

    it('the first look at a copy names both choices', async () => {
      await mountPage(api({ status: vi.fn(async () => ({ ...NEWER, remote: { ...NEWER.remote, first: true } })) }))
      expect(w.get('[data-sync-newer]').text()).toContain('keep this computer\'s setup, which replaces it')
    })
  })

  describe('staged', () => {
    it('never restarts by itself; says it applies at the next start', async () => {
      const restartApp = vi.fn((resolve) => resolve({ ok: true }))
      await mountPage(api({ status: vi.fn(async () => STAGED) }), { restartApp })
      expect(w.get('[data-sync-staged]').text()).toContain('Tessel does not restart by itself')
      expect(restartApp).not.toHaveBeenCalled()
    })

    it('Restart now asks first, saying which terminals close; no means no', async () => {
      const askConfirm = vi.fn(async () => false)
      const restartApp = vi.fn((resolve) => resolve({ ok: true }))
      await mountPage(api({ status: vi.fn(async () => STAGED) }), { askConfirm, restartApp })
      await w.get('.tessel-sync-restart').trigger('click')
      await flushPromises()
      expect(askConfirm.mock.calls[0][0].text).toContain('that are not in that layout are closed')
      expect(restartApp).not.toHaveBeenCalled()
      askConfirm.mockResolvedValue(true)
      await w.get('.tessel-sync-restart').trigger('click')
      await flushPromises()
      expect(restartApp).toHaveBeenCalled()
    })

    it('a restart that could not happen says what to do', async () => {
      await mountPage(api({ status: vi.fn(async () => STAGED) }), { restartApp: vi.fn((resolve) => resolve({ ok: false, reason: 'spawn' })) })
      await w.get('.tessel-sync-restart').trigger('click')
      await flushPromises()
      expect(w.get('[data-sync-error]').text()).toContain('Close it and open it again')
      expect(w.get('.tessel-sync-restart').attributes('disabled')).toBeUndefined()
    })

    it('an editor left unsaved that stops the restart says nothing more', async () => {
      await mountPage(api({ status: vi.fn(async () => STAGED) }), { restartApp: vi.fn((resolve) => resolve({ ok: false, reason: 'cancelled' })) })
      await w.get('.tessel-sync-restart').trigger('click')
      await flushPromises()
      expect(w.find('[data-sync-error]').exists()).toBe(false)
    })

    it('Cancel takes it back', async () => {
      const a = api({ status: vi.fn(async () => STAGED) })
      await mountPage(a)
      await w.get('.tessel-sync-cancel-apply').trigger('click')
      await flushPromises()
      expect(a.cancelApply).toHaveBeenCalled()
      expect(w.find('[data-sync-newer]').exists()).toBe(true)
    })

    it('names the folders that are not on this computer', async () => {
      await mountPage(api({ status: vi.fn(async () => ({ ...STAGED, staged: { ...STAGED.staged, missing: ['C:/gone', 'C:/also'] } })) }))
      const text = w.get('[data-sync-missing]').text()
      expect(text).toContain('C:/gone, C:/also')
      expect(text).toContain('home folder')
    })
  })

  it('needs its phrase: says why, and asks for it', async () => {
    const a = api({ status: vi.fn(async () => NEEDS), peek: vi.fn(async () => ({ ...NEEDS, copy: { device: 'LAPTOP-2', at: 5 } })), turnOn: vi.fn(async () => NEWER) })
    await mountPage(a)
    expect(w.get('[data-sync-needs-phrase]').text()).toContain('Nothing is sent until then')
    await w.get('.tessel-sync-enter').trigger('click')
    await flushPromises()
    await type('.tessel-sync-phrase', PHRASE)
    await submit()
    expect(a.turnOn).toHaveBeenCalledWith(PHRASE)
    expect(w.find('[data-sync-newer]').exists()).toBe(true)
  })
})
