// Isolated real-renderer audit: mock PTYs, local browser profile, no live app.
const fs = require('fs')
const path = require('path')
const http = require('http')
const puppeteer = require('puppeteer-core')
const fixed = process.argv.includes('--fixes')
const audit = path.join(__dirname, fixed ? 'fixes-codex-ui' : 'audit-e1d524a')
fs.mkdirSync(audit, { recursive: true })
const repairCss = process.argv.includes('--repair-css')
const suffix = repairCss ? '-css-repair' : ''
const source = fixed ? path.join(__dirname, 'fixes-codex') : path.join(audit, 'source')
const root = path.join(source, 'out/renderer')
const fixture = fs.readFileSync(path.join(source, 'test-taskboard.cjs'), 'utf8')
const mock = fixture.match(/const MOCK = `([\s\S]*?)\r?\n`/)[1].replace('${JSON.stringify(RUN_ID)}', JSON.stringify('audit-e1d524a'))
async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end()
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    let body = fs.readFileSync(file)
    // Diagnosis only: close the missing block in the served copy, leaving
    // every source file unchanged.
    if (repairCss && file.endsWith('.css')) body = body.toString('utf8').replace(/(\.pane-stuck\.alert\s*\{[^{}]*?color:\s*var\(--danger\);)(\s*)(?=\/\*|\.pane-unsent)/, '$1\n}\n$2')
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  const result = { errors: [], screens: [], focus: {}, accessibility: {}, integrationIssues: [] }
  try {
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, userDataDir: path.join(audit, 'browser-profile') })
    const page = await browser.newPage()
    page.on('pageerror', (e) => result.errors.push(e.message))
    await page.evaluateOnNewDocument(mock)
    await page.evaluateOnNewDocument(() => {
      window.auditWrites = []
      window.shellApi.writePty = (id, data) => window.auditWrites.push({ id, data })
      window.shellApi.installTeamTools = undefined
      window.shellApi.update = undefined
      window.shellApi.activity = { load: async () => [], save: async () => ({ ok: true }) }
    })
    await page.setViewport({ width: 1366, height: 768 })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForSelector('.xterm-screen')
    for (const theme of ['classic', 'warp']) {
      await page.click('button[aria-label="Settings"]')
      await page.select('#appearance-theme', theme)
      await page.keyboard.press('Escape')
      for (const size of [{ width: 1366, height: 768 }, { width: 800, height: 600 }, { width: 640, height: 400 }]) {
        await page.setViewport(size)
        await new Promise((resolve) => setTimeout(resolve, 150))
        const layout = await page.evaluate(() => {
          const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
          return {
            actualTheme: document.documentElement.dataset.theme,
            rootTheme: getComputedStyle(document.documentElement).getPropertyValue('--chrome'),
            toolbarBackground: getComputedStyle(document.querySelector('.toolbar')).backgroundColor,
            statusbarDisplay: document.querySelector('.statusbar') ? getComputedStyle(document.querySelector('.statusbar')).display : null,
            body: { width: document.body.clientWidth, scrollWidth: document.body.scrollWidth },
            toolbar: rect(document.querySelector('.toolbar')),
            buttons: [...document.querySelectorAll('.toolbar button')].filter((el) => el.getBoundingClientRect().width).map((el) => ({ label: el.getAttribute('aria-label') || el.title || el.textContent.trim(), ...rect(el) })),
            pane: rect(document.querySelector('.pane')),
            sidebar: document.querySelector('.ws-sidebar') ? rect(document.querySelector('.ws-sidebar')) : null
          }
        })
        result.screens.push({ theme, size, layout })
        await page.screenshot({ path: path.join(audit, `${theme}-${size.width}${suffix}.png`) })
      }
      await page.setViewport({ width: 800, height: 600 })
      await page.click('button[aria-label="Settings"]')
      const cdp = await page.createCDPSession()
      const ax = await cdp.send('Accessibility.getFullAXTree')
      result.accessibility[theme] = ax.nodes.filter((n) => !n.ignored && ['combobox', 'spinbutton', 'checkbox'].includes(n.role?.value)).map((n) => ({ role: n.role.value, name: n.name?.value || '', value: n.value?.value }))
      const focus = []
      await page.$eval('.settings-card', (el) => el.focus())
      for (let i = 0; i < 100; i++) {
        await page.keyboard.press('Tab')
        focus.push(await page.evaluate(() => ({ tag: document.activeElement.tagName, class: document.activeElement.className, text: (document.activeElement.title || document.activeElement.textContent || '').slice(0, 65), inDialog: !!document.activeElement.closest('.settings-card') })))
        if (focus.at(-1).class === 'xterm-helper-textarea') {
          const before = await page.evaluate(() => window.auditWrites.length)
          await page.keyboard.type('AUDIT_ONLY')
          focus.at(-1).ptyWrites = await page.evaluate((n) => window.auditWrites.slice(n), before)
          break
        }
      }
      result.focus[theme] = focus
      if (fixed) {
        await page.keyboard.press('F1')
        const modalState = await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('[role="dialog"]')].map(el => ({ name: el.getAttribute('aria-label'), hasFocus: el.contains(document.activeElement) })) }))
        if (modalState.dialogs.length > 1) result.integrationIssues.push({ theme, issue: 'F1 stacks Help over Settings, but focus remains trapped in Settings', modalState })
        await page.keyboard.press('F1')
        for (let i = 0; i < 50; i++) {
          await page.keyboard.down('Shift')
          await page.keyboard.press('Tab')
          await page.keyboard.up('Shift')
          if (!await page.evaluate(() => !!document.activeElement.closest('.settings-card'))) throw new Error('Shift+Tab escaped Settings')
        }
        await page.$eval('.xterm-helper-textarea', el => el.focus())
        if (!await page.evaluate(() => !!document.activeElement.closest('.settings-card'))) throw new Error('Programmatic xterm focus escaped Settings')
        await page.$eval('.settings-card', el => el.focus())
        await page.keyboard.type('AUDIT_ONLY')
        const writes = await page.evaluate(() => window.auditWrites.length)
        if (writes) throw new Error(`Settings typed ${writes} times into the background PTY`)
        if (focus.some(f => !f.inDialog)) throw new Error('Tab escaped Settings')
        if (result.accessibility[theme].some(n => !n.name)) throw new Error('Unnamed settings control')
      }
      await page.screenshot({ path: path.join(audit, `${theme}-settings${suffix}.png`) })
      // Escape in the dialog closes it even if Tab moved focus behind it.
      await page.$eval('.settings-card', (el) => el.focus())
      await page.keyboard.press('Escape')
      if (fixed) {
        if (await page.$('.settings-card')) throw new Error('Escape did not close Settings')
        const restoredFocus = await page.evaluate(() => ({ tag: document.activeElement.tagName, class: document.activeElement.className, label: document.activeElement.getAttribute('aria-label'), inert: [...document.querySelectorAll('[inert]')].map(el => el.className) }))
        if (restoredFocus.label !== 'Settings') result.integrationIssues.push({ theme, issue: 'App closeSettings overrides restored opener focus', restoredFocus })
        if (await page.$('.toolbar[inert], .workspace[inert]')) throw new Error('Background left inert after closing Settings')
      }
      await cdp.detach()
    }
    await page.setViewport({ width: 640, height: 400 })
    await page.$eval('.ws-item.current', (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    await page.waitForSelector('.ws-input')
    await page.$eval('.ws-input', (el) => el.select())
    await page.keyboard.type('Trading research and development workspace')
    await page.keyboard.press('Enter')
    if (fixed) {
      result.longWorkspaces = []
      for (const theme of ['classic', 'warp']) {
        await page.click('button[aria-label="Settings"]')
        await page.select('#appearance-theme', theme)
        await page.keyboard.press('Escape')
        for (const width of [640, 800]) {
          await page.setViewport({ width, height: 600 })
          const buttons = await page.evaluate(() => [...document.querySelectorAll('.toolbar button')].map(el => ({ label: el.getAttribute('aria-label') || el.title, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right })).filter(el => el.width > 0))
          result.longWorkspaces.push({ theme, width, rightmost: Math.max(...buttons.map(b => b.right)), reservedStart: width - 150 })
        }
      }
      await page.setViewport({ width: 640, height: 400 })
      console.log(JSON.stringify({ longWorkspaces: result.longWorkspaces }, null, 2))
    }
    result.longWorkspace = await page.evaluate(() => {
      const toolbar = document.querySelector('.toolbar')
      const reservedStart = innerWidth - parseFloat(getComputedStyle(toolbar).paddingRight)
      return { reservedStart, buttonsInCaptionArea: [...toolbar.querySelectorAll('button')].map((el) => ({ label: el.getAttribute('aria-label') || el.title, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })).filter((b) => b.right > reservedStart) }
    })
    await page.screenshot({ path: path.join(audit, `long-workspace-640${suffix}.png`) })
    fs.writeFileSync(path.join(audit, `ui-results${suffix}.json`), JSON.stringify(result, null, 2))
    result.styles = await page.evaluate(() => ({
      matches: document.documentElement.matches(":root[data-theme='warp']"),
      sheets: [...document.styleSheets].map((sheet) => ({ href: sheet.href, count: sheet.cssRules.length, warpRules: [...sheet.cssRules].filter((r) => r.cssText.includes('data-theme')).map((r) => r.cssText.slice(0, 300)), last: [...sheet.cssRules].slice(-3).map((r) => r.cssText.slice(0, 300)) }))
    }))
    fs.writeFileSync(path.join(audit, `styles-results${suffix}.json`), JSON.stringify(result.styles, null, 2))
    if (result.integrationIssues.length) { console.log(JSON.stringify({ integrationIssues: result.integrationIssues }, null, 2)); process.exitCode = 1 }
    console.log(JSON.stringify({ matchesWarp: result.styles.matches, warpRules: result.styles.sheets.map((s) => s.warpRules.length), longWorkspace: result.longWorkspace }, null, 2))
    console.log(JSON.stringify({ repairCss, errors: result.errors, layouts: result.screens.map((s) => ({ theme: s.theme, actual: s.layout.actualTheme, chrome: s.layout.rootTheme, statusbarDisplay: s.layout.statusbarDisplay, size: s.size, outsideButtons: s.layout.buttons.filter((b) => b.right > s.size.width || b.x < 0) })), focus: Object.fromEntries(Object.entries(result.focus).map(([key, value]) => [key, { escaped: value.some((v) => !v.inDialog), terminalWrites: value.find((v) => v.ptyWrites)?.ptyWrites?.length || 0 }])), accessibility: Object.fromEntries(Object.entries(result.accessibility).map(([key, value]) => [key, value.filter((v) => !v.name)])) }, null, 2))
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
