// Build first. Exercises the real renderer with an isolated mock PTY backend.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const puppeteer = require('puppeteer-core')

async function main() {
  const root = path.resolve(__dirname, '../out/renderer')
  const fixture = fs.readFileSync(path.resolve(__dirname, '../test-taskboard.cjs'), 'utf8')
  const mock = fixture
    .match(/const MOCK = `([\s\S]*?)\r?\n`/)[1]
    .replace('${JSON.stringify(RUN_ID)}', JSON.stringify('theme-smoke'))
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    res.setHeader(
      'Content-Type',
      file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    )
    res.end(fs.readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: true
    })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.setViewport({ width: 1366, height: 768 })
    await page.evaluateOnNewDocument(mock)
    await page.evaluateOnNewDocument(() => {
      window.shellApi.update = undefined
      window.themeTest = { starts: 0, kills: 0 }
      const create = window.shellApi.createPty
      window.shellApi.createPty = (...args) => {
        window.themeTest.starts++
        return create(...args)
      }
      window.shellApi.killPty = () => {
        window.themeTest.kills++
      }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForSelector('.xterm-screen')
    const original = await page.evaluate(() => ({ ...window.themeTest }))
    await page.evaluate(() => {
      window.originalTerminal = document.querySelector('.xterm-screen')
    })
    await page.click('button[aria-label="Settings"]')
    await page.select('#appearance-theme', 'warp')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'warp')
    await page.waitForSelector('.ws-session')
    await page.waitForSelector('.statusbar')
    assert.equal(
      await page.$eval('.pane', (n) => getComputedStyle(n).backgroundColor),
      'rgb(25, 27, 26)'
    )
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('taskboard-mock:Layout'))?.settings?.theme === 'warp'
    )
    assert.deepEqual(await page.evaluate(() => window.themeTest), original)
    assert.equal(
      await page.evaluate(
        () => window.originalTerminal === document.querySelector('.xterm-screen')
      ),
      true
    )
    await page.keyboard.press('Escape')
    await page.screenshot({ path: path.resolve(__dirname, '../design/app-warp.png') })
    await page.reload()
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.theme === 'warp' && document.querySelector('.xterm-screen')
    )
    await page.click('button[aria-label="Settings"]')
    await page.select('#appearance-theme', 'classic')
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'classic')
    await page.waitForSelector('.ws-sessions')
    assert.equal(await page.$('.statusbar'), null)
    assert.equal(
      await page.$eval('.pane', (n) => getComputedStyle(n).backgroundColor),
      'rgb(21, 23, 28)'
    )
    assert.deepEqual(errors, [])
    console.log(
      'PASS: real renderer switches both themes, persists across reload, keeps xterm mounted, and never restarts a mock PTY.'
    )
  } finally {
    if (browser) await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
