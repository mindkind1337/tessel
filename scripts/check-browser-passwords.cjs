// Electron smoke test with synthetic credentials only, never a real profile.
const { app, BrowserWindow, session, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-password-smoke-'))
app.setPath('userData', path.join(dir, 'profile'))
const { createPasswordVault, fillSavedPassword } = require(process.argv[2])
let win
const timer = setTimeout(() => app.exit(1), 20000)
app.whenReady().then(async () => {
  const file = path.join(dir, 'vault.sealed')
  const vault = createPasswordVault({ file, safeStorage })
  vault.importRows([{ origin: 'https://login.test', username: 'fixture-user', password: 'fixture-password' }])
  assert.equal(fs.readFileSync(file).includes(Buffer.from('fixture-password')), false)
  const id = vault.list()[0].id
  const ses = session.fromPartition('password-smoke')
  ses.protocol.handle('https', () => new Response('<!doctype html><form action="/session"><input type="email"><input type="password"><button>Sign in</button></form>', { headers: { 'content-type': 'text/html' } }))
  win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadURL('https://login.test/')
  const args = { vault, guest: win.webContents, id, agent: true, allowed: () => true }
  assert.equal((await fillSavedPassword(args)).ok, false)
  vault.change(id, 'allow', true)
  assert.equal((await fillSavedPassword(args)).ok, true)
  assert.equal(await win.webContents.executeJavaScript("document.querySelector('[type=email]').value === 'fixture-user' && document.querySelector('[type=password]').value === 'fixture-password'"), true)
  assert.equal(win.webContents.getURL(), 'https://login.test/')
  assert.equal((await fillSavedPassword({ ...args, allowed: () => false })).code, 'private-page-required')
  await win.loadURL('https://other.test/')
  assert.equal((await fillSavedPassword(args)).ok, false)
  console.log('PASS: OS encryption, opt-in, isolated autofill, no submission, foreign origin and sharing denied')
  finish(0)
}).catch(() => { console.error('Password smoke test failed (no secret diagnostics)'); finish(1) })
function finish(code) { clearTimeout(timer); win?.destroy(); app.exit(code) }
