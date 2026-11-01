// Settings > General > Backup: export and import of the settings. The main process
// does the files; the window flushes what it has before an export, asks before a
// restore, and says plainly what happens next.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import BackupSettings from '../components/BackupSettings.vue'

describe('Settings > Backup', { timeout: 30_000 }, () => {
  let previousApi, backup
  beforeEach(() => {
    previousApi = window.shellApi
    backup = {
      export: vi.fn().mockResolvedValue({ ok: true, path: 'C:/x/tessel-settings.json', included: [], missing: [] }),
      inspect: vi.fn().mockResolvedValue({
        ok: true,
        token: 'tok',
        summary: { createdAt: 1_700_000_000_000, appVersion: '1.17.2', build: 'b9 (abc1234)', categories: [{ id: 'settings', files: [] }, { id: 'board', files: [] }] }
      }),
      apply: vi.fn().mockResolvedValue({ ok: true, count: 2 })
    }
    window.shellApi = { backup, isDev: false }
  })
  afterEach(() => {
    window.shellApi = previousApi
  })
  const mountIt = (provide = {}) => mount(BackupSettings, { global: { provide } })

  it('flushes what the window has, then exports the parts that are ticked', async () => {
    const saveBeforeBackup = vi.fn().mockResolvedValue()
    const w = mountIt({ saveBeforeBackup })
    await w.get('[data-test="backup-export-activity"]').setValue(false)
    await w.get('[data-test="backup-export"]').trigger('click')
    await flushPromises()
    expect(saveBeforeBackup).toHaveBeenCalledTimes(1)
    expect(backup.export).toHaveBeenCalledWith(['settings', 'hosts', 'board', 'liveshare', 'security'])
    expect(w.get('[data-test="backup-export-note"]').text()).toContain('tessel-settings.json')
    expect(w.text()).toMatch(/Sign-ins and saved passwords are not in it/i)
  })

  it('a cancelled save dialog says nothing; a failure says it did not work', async () => {
    backup.export.mockResolvedValueOnce({ ok: false, code: 'cancelled' })
    const w = mountIt()
    await w.get('[data-test="backup-export"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="backup-export-note"]').exists()).toBe(false)
    expect(w.find('[data-test="backup-export-error"]').exists()).toBe(false)
    backup.export.mockResolvedValueOnce({ ok: false, code: 'failed' })
    await w.get('[data-test="backup-export"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="backup-export-error"]').text()).toMatch(/Nothing was changed/)
  })

  it('import: shows what the file holds, asks before restoring, and says it applies at the next start', async () => {
    const askConfirm = vi.fn().mockResolvedValue(true)
    const w = mountIt({ askConfirm })
    await w.get('[data-test="backup-import"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="backup-summary"]').text()).toContain('1.17.2')
    await w.get('[data-test="backup-import-board"]').setValue(false)
    await w.get('[data-test="backup-apply"]').trigger('click')
    await flushPromises()
    expect(askConfirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
    expect(backup.apply).toHaveBeenCalledWith('tok', ['settings'])
    expect(w.get('[data-test="backup-staged"]').text()).toContain('2')
    expect(w.text()).toMatch(/Close Tessel and open it again/) // installed app: no restart button
    expect(w.find('[data-test="backup-restart"]').exists()).toBe(false)
  })

  it('declining the confirmation restores nothing', async () => {
    const w = mountIt({ askConfirm: vi.fn().mockResolvedValue(false) })
    await w.get('[data-test="backup-import"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="backup-apply"]').trigger('click')
    await flushPromises()
    expect(backup.apply).not.toHaveBeenCalled()
  })

  it('a file that is not a backup, or from a newer Tessel, is explained', async () => {
    backup.inspect.mockResolvedValueOnce({ ok: false, code: 'newer' })
    const w = mountIt()
    await w.get('[data-test="backup-import"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="backup-import-error"]').text()).toMatch(/newer Tessel/)
    expect(w.find('[data-test="backup-apply"]').exists()).toBe(false)
  })

  it('a development Tessel offers Restart now after staging', async () => {
    window.shellApi.isDev = true
    const restartApp = vi.fn((resolve) => resolve({ ok: true }))
    const w = mountIt({ askConfirm: vi.fn().mockResolvedValue(true), restartApp })
    await w.get('[data-test="backup-import"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="backup-apply"]').trigger('click')
    await flushPromises()
    await w.get('[data-test="backup-restart"]').trigger('click')
    expect(restartApp).toHaveBeenCalledTimes(1)
  })

  it('commands and permissions are not restored unless ticked: a file from someone else must not decide what agents may do', async () => {
    backup.inspect.mockResolvedValueOnce({
      ok: true,
      token: 'tok2',
      summary: { createdAt: 1_700_000_000_000, appVersion: '1', build: '', categories: [{ id: 'settings', files: [] }, { id: 'security', files: [] }] }
    })
    const w = mountIt({ askConfirm: vi.fn().mockResolvedValue(true) })
    await w.get('[data-test="backup-import"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="backup-import-security"]').element.checked).toBe(false)
    expect(w.get('[data-test="backup-import-settings"]').element.checked).toBe(true)
    await w.get('[data-test="backup-apply"]').trigger('click')
    await flushPromises()
    expect(backup.apply).toHaveBeenCalledWith('tok2', ['settings'])
  })
})
