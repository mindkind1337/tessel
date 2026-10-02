const fs = require('fs')
const path = require('path')
const http = require('http')
const puppeteer = require('puppeteer-core')
const source = process.argv[2] || path.join(__dirname, 'review-ed1554d')
const root = path.join(source, 'out/renderer')
const artifact = path.join(__dirname, 'team-view-ui')
fs.mkdirSync(artifact, { recursive: true })
const mock = fs.readFileSync(path.join(source, 'test-taskboard.cjs'), 'utf8').match(/const MOCK = `([\s\S]*?)\r?\n`/)[1].replace('${JSON.stringify(RUN_ID)}', JSON.stringify('team-view-' + Date.now()))
async function main() {
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url))
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end()
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html')
    res.end(fs.readFileSync(file))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  let browser
  const results = { source, errors: [], cases: [] }
  try {
    browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, userDataDir: path.join(artifact, 'browser-profile') })
    const page = await browser.newPage()
    page.on('pageerror', e => results.errors.push(e.message))
    await page.evaluateOnNewDocument(mock)
    await page.evaluateOnNewDocument(() => {
      window.shellApi.installTeamTools = undefined
      window.shellApi.update = undefined
      window.shellApi.team = { current: async () => ({ ok: true, lost: [] }), retire: async () => ({ ok: true }) }
      window.shellApi.activity = {
        load: async () => ['read', 'unread'].map((status, i) => ({
          type: 'message', t: Date.now() - 30000 + i * 5000, paneId: 'fixture-recipient',
          agent: { title: 'Claude Code', agentId: 'claude' }, source: 'agent',
          from: '#1 Codex CLI', status, scope: 'team-chat', msgId: `msg-${i}`,
          preview: i ? 'Can you review the new task tools?' : 'The scroll correction passed the independent tests.',
          text: i ? 'Can you review the new task tools?\nPlease check persistence and assignment.' : 'The scroll correction passed the independent tests.\nClassic and Warp: all 16 browser checks passed.'
        })), save: async () => ({ ok: true })
      }
    })
    await page.setViewport({ width: 1366, height: 768 })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForSelector('.xterm-screen')
    for (const theme of ['classic', 'warp']) {
      await page.click('[aria-label="Settings"]')
      await page.select('#appearance-theme', theme)
      await page.keyboard.press('Escape')
      await page.click('.tb-command')
      await page.waitForSelector('.pal-input')
      await page.type('.pal-input', 'Activity of the agents')
      await page.keyboard.press('Enter')
      await page.waitForSelector('.act-card')
      await page.select('.act-select', 'all')
      await page.waitForFunction(() => document.querySelectorAll('.act-event.message').length === 2)
      const full = await page.$eval('.act-card', el => el.innerText)
      for (const size of [{ width: 1366, height: 768 }, { width: 800, height: 600 }, { width: 640, height: 400 }]) {
        await page.setViewport(size)
        await new Promise(r => setTimeout(r, 80))
        const layout = await page.$eval('.act-card', el => {
          const r = el.getBoundingClientRect()
          const chip = [...el.querySelectorAll('.mcp-cat')].find(x => x.textContent.trim() === 'Between agents')
          const c = chip.getBoundingClientRect()
          return { card: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }, chip: { x: c.x, right: c.right, text: chip.textContent.trim(), pressed: chip.getAttribute('aria-pressed'), color: getComputedStyle(chip).color }, messages: [...el.querySelectorAll('.act-event.message')].map(x => x.innerText) }
        })
        results.cases.push({ theme, size, layout })
        await page.screenshot({ path: path.join(artifact, `${theme}-${size.width}.png`) })
      }
      await page.$$eval('.mcp-cat', els => els.find(el => el.textContent.trim() === 'Between agents').click())
      await page.waitForFunction(() => document.querySelectorAll('.act-event.message').length === 0)
      await page.$$eval('.mcp-cat', els => els.find(el => el.textContent.trim() === 'Between agents').click())
      await page.waitForFunction(() => document.querySelectorAll('.act-event.message').length === 2)
      await page.$eval('.act-event.message', el => el.click())
      await page.waitForSelector('.act-full')
      results.cases.push({ theme, filterToggle: true, expandedText: await page.$eval('.act-full', el => el.textContent), bothStates: full.includes('not read yet') && full.includes(' · read') })
      await page.keyboard.press('Escape')
      await page.setViewport({ width: 1366, height: 768 })
    }
    fs.writeFileSync(path.join(artifact, 'results.json'), JSON.stringify(results, null, 2))
    console.log(JSON.stringify(results, null, 2))
    if (results.errors.length) process.exitCode = 1
  } finally {
    if (browser) await browser.close()
    await new Promise(r => server.close(r))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
