// Renders the real renderer UI in headless Chrome with a MOCK shellApi (so panes
// actually mount without Electron), then drives the maximize button to reproduce
// and diagnose the full-screen / un-fullscreen issue.
const puppeteer = require('puppeteer-core')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = 'http://localhost:5173/'

const MOCK = `
window.shellApi = {
  listShells: () => Promise.resolve([
    { id: 'powershell', name: 'Windows PowerShell' },
    { id: 'cmd', name: 'Command Prompt' }
  ]),
  listAgents: () => Promise.resolve([
    { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', available: true }
  ]),
  createPty: (o) => Promise.resolve({
    ok: true,
    shell: { id: o.shellId || 'powershell', name: o.shellId === 'cmd' ? 'Command Prompt' : 'Windows PowerShell' },
    backend: 'winpty', windowsBuild: 0, pid: 1000
  }),
  writePty: () => {}, resizePty: () => {}, killPty: () => {},
  readClipboard: () => Promise.resolve(''), writeClipboard: () => {},
  loadLayout: () => Promise.resolve(null), saveLayout: () => {},
  onData: () => () => {}, onExit: () => () => {}
}
`

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--window-size=1280,800']
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.evaluateOnNewDocument(MOCK)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 })
  await page.waitForSelector('.pane', { timeout: 8000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 800))

  const before = await page.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    terminals: document.querySelectorAll('.xterm').length
  }))
  await page.screenshot({ path: 'max-1-grid.png' })

  // Click the FIRST pane's maximize button.
  const clickedMax = await page.evaluate(() => {
    const btn = document.querySelector('.pane button[title="Maximize pane"]')
    if (!btn) return false
    btn.click()
    return true
  })
  await new Promise((r) => setTimeout(r, 600))
  await page.screenshot({ path: 'max-2-maximized.png' })

  // Diagnose the maximized state.
  const diag = await page.evaluate(() => {
    const maxPane = document.querySelector('.pane.maximized')
    const restoreBtn = document.querySelector('.pane.maximized button[title="Restore pane"]')
      || document.querySelector('button[title="Restore pane"]')
    const out = {
      maximizedPaneExists: !!maxPane,
      restoreBtnExists: !!restoreBtn
    }
    if (maxPane) {
      const nav = maxPane.querySelector('.pane-nav')
      const r = maxPane.getBoundingClientRect()
      out.paneRect = { x: r.x, y: r.y, w: Math.round(r.width), h: Math.round(r.height) }
      if (nav) {
        const nr = nav.getBoundingClientRect()
        out.navRect = { x: nr.x, y: nr.y, w: Math.round(nr.width), h: Math.round(nr.height) }
      }
    }
    if (restoreBtn) {
      const br = restoreBtn.getBoundingClientRect()
      out.restoreRect = { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) }
      out.restoreVisibleInViewport =
        br.x >= 0 && br.y >= 0 && br.right <= window.innerWidth && br.bottom <= window.innerHeight
      // What element is actually at the restore button's center? (click-blocking check)
      const cx = br.x + br.width / 2, cy = br.y + br.height / 2
      const topEl = document.elementFromPoint(cx, cy)
      out.elementAtRestoreCenter = topEl ? topEl.outerHTML.slice(0, 90) : null
      out.restoreIsTopmost = !!(topEl && (topEl === restoreBtn || restoreBtn.contains(topEl) || topEl.closest('button[title="Restore pane"]')))
    }
    return out
  })

  // Try to actually click restore and see if it un-maximizes.
  let restoreWorked = null
  if (diag.restoreBtnExists) {
    await page.evaluate(() => {
      const b = document.querySelector('button[title="Restore pane"]')
      if (b) b.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    restoreWorked = await page.evaluate(() => !document.querySelector('.pane.maximized'))
    await page.screenshot({ path: 'max-3-after-restore.png' })
  }

  console.log('=== BEFORE ===', JSON.stringify(before))
  console.log('clicked maximize:', clickedMax)
  console.log('=== MAXIMIZED DIAGNOSIS ===')
  console.log(JSON.stringify(diag, null, 2))
  console.log('=== restore click un-maximized? ===', restoreWorked)
  console.log('=== page errors ===', errors.length ? errors : 'none')
  await browser.close()
})()
