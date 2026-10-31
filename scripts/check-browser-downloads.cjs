// Real Chromium transport smoke test, isolated local fixture (no personal data).
// Run with Electron, without ELECTRON_RUN_AS_NODE.
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-download-check-'))
app.setPath('userData', path.join(dir, 'profile'))
let server
let win
const timeout = setTimeout(() => { console.error('Download check timed out'); app.exit(1) }, 30000)
async function main() {
  await app.whenReady()
  const { createBrowserDownloads } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../src/main/browserDownloads.js')).toString('base64'))
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream']
  let text = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = Buffer.byteLength(text)
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const pdf = Buffer.from(text)
  let authenticated = false
  server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Set-Cookie', 'fixture=ok; HttpOnly; SameSite=Strict'); res.end('<html><body>Download fixture</body></html>'); return }
    if (req.url === '/auth') {
      authenticated = req.headers.cookie === 'fixture=ok'
      if (!authenticated) { res.writeHead(401); res.end(); return }
    }
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="original.pdf"', 'Content-Length': pdf.length })
    res.end(pdf)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const ses = session.fromPartition('download-smoke-' + Date.now())
  win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } })
  let completed
  const downloads = createBrowserDownloads({ directory: () => dir, send: (_ch, row) => {
    if (['completed', 'cancelled', 'interrupted'].includes(row.state)) completed?.(row)
  } })
  ses.on('will-download', (_event, item) => {
    downloads.accept(item, win.webContents.id, { unattended: true })
  })
  await win.loadURL(base)
  for (const kind of ['direct', 'auth', 'blob', 'blob-popup']) {
    if (kind !== 'blob-popup') assert.equal(downloads.prepare(win.webContents.id, path.join(dir, 'agent', 'chosen.pdf'), 'fixture').ok, true)
    const done = new Promise((resolve) => { completed = resolve })
    if (kind === 'blob-popup') {
      const url = await win.webContents.executeJavaScript(`URL.createObjectURL(new Blob([Uint8Array.from(atob('${pdf.toString('base64')}'), c => c.charCodeAt(0))], {type:'application/pdf'}))`)
      win.webContents.downloadURL(url)
    } else if (kind === 'blob') {
      await win.webContents.executeJavaScript(`(() => { const bytes = Uint8Array.from(atob('${pdf.toString('base64')}'), c => c.charCodeAt(0)); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], {type:'application/pdf'})); a.download = 'original.pdf'; document.body.append(a); a.click(); })()`)
    } else {
      await win.webContents.executeJavaScript(`(() => { const b = document.createElement('button'); b.onclick = () => { location.href = '${base}/${kind}' }; document.body.append(b); b.click(); })()`)
    }
    const row = await done
    assert.equal(row.state, 'completed')
    assert.equal(path.dirname(row.path), path.join(dir, kind === 'blob-popup' ? 'Tessel' : 'agent'))
    if (kind !== 'blob-popup') assert.ok(path.basename(row.path).startsWith('chosen'))
    assert.ok(fs.readFileSync(row.path).equals(pdf), kind + ' bytes changed')
    console.log(kind + ': original PDF bytes preserved')
  }
  assert.ok(authenticated, 'Session cookie did not reach authenticated endpoint')
  assert.equal(new Set(downloads.list(win.webContents.id).map((r) => r.path)).size, 4)
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loading = getDocument({ data: new Uint8Array(pdf), useSystemFonts: false })
  const document = await loading.promise
  assert.equal(document.numPages, 1)
  await document.getPage(1)
  await loading.destroy()
  console.log('PASS: direct, authenticated, blob, duplicate names, PDF parser')
}
main().then(() => finish(0), (err) => { console.error(err); finish(1) })
function finish(code) {
  clearTimeout(timeout)
  win?.destroy()
  server?.close()
  // Isolated temporary fixture; no user files are removed.
  app.exit(code)
}
