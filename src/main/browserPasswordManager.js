import fs from 'node:fs'
import path from 'node:path'
import { createPasswordVault, parsePasswordCsv, passwordSources, importBrowserPasswords, fillSavedPassword, loginOrigin } from './browserPasswords'
import { isAllowedCookieFilePath } from './cookieImport/fileTokens'

export function registerPasswordManager({ ipcMain, safeStorage, dialog, dataDir, getWindow, guestFor, allowedPage, sharingActive }) {
  const vault = createPasswordVault({ file: path.join(dataDir, 'browser-passwords.sealed'), safeStorage })
  const local = (event) => {
    const win = getWindow()
    return !!win && !win.isDestroyed() && event.sender === win.webContents && !sharingActive()
  }
  const safe = (action) => async (event, ...args) => {
    if (!local(event)) return { ok: false, code: 'private-page-required' }
    try { return await action(event, ...args) } catch (error) {
      const codes = ['locked', 'access-denied', 'missing', 'format', 'too-big', 'encryption-unavailable', 'vault-unavailable', 'not-found']
      return { ok: false, code: codes.includes(error?.code) ? error.code : 'failed' }
    }
  }
  ipcMain.handle('browser:passwordSources', safe(async () => ({ ok: true, sources: await passwordSources() })))
  ipcMain.handle('browser:passwordList', safe(() => ({ ok: true, entries: vault.list() })))
  ipcMain.handle('browser:passwordChange', safe((_event, opts = {}) => vault.change(opts.id, opts.action, opts.allowAgents)))
  ipcMain.handle('browser:passwordImportProfile', safe(async (_event, opts = {}) => {
    const result = await importBrowserPasswords(vault, opts, path.join(dataDir, 'cookie-import-tmp'))
    return result
  }))
  ipcMain.handle('browser:passwordImportCsv', safe(async () => {
    const choice = await dialog.showOpenDialog(getWindow(), { title: 'Import passwords (CSV)', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (choice.canceled || !choice.filePaths.length) return { ok: false, code: 'cancelled' }
    if (sharingActive()) return { ok: false, code: 'private-page-required' }
    const file = choice.filePaths[0]
    if (!isAllowedCookieFilePath(file)) return { ok: false, code: 'refused' }
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { ok: false, code: 'too-big' }
    return vault.importRows(parsePasswordCsv(fs.readFileSync(file, 'utf8')))
  }))
  ipcMain.handle('browser:passwordFill', safe((event, page, id) => fillSavedPassword({ vault, guest: guestFor(event, page), id, allowed: allowedPage })))
  async function login(guest, id) {
    if (sharingActive() || !guest || !allowedPage(guest)) return { ok: false, code: 'private-page-required' }
    const origin = loginOrigin(guest.getURL())
    if (!origin) return { ok: false, code: 'https-required' }
    if (id) return fillSavedPassword({ vault, guest, id, agent: true, allowed: allowedPage })
    try { return { ok: true, accounts: vault.list(origin, true) } } catch { return { ok: false, code: 'vault-unavailable' } }
  }
  return { login }
}
