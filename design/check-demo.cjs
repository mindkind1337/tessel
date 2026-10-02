const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require('puppeteer-core')

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--disable-extensions', '--no-first-run']
  })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewport({ width: 1366, height: 768 })
    await page.goto(pathToFileURL(path.join(__dirname, 'demo.html')).href)
    const count = selector => page.$$eval(selector, nodes => nodes.length)
    const text = selector => page.$eval(selector, node => node.textContent)
    assert.equal(await count('.pane'), 3)
    assert.equal(await count('.session'), 3)
    await page.click('#sessions button:nth-child(2)')
    assert.equal(await page.$eval('.pane:nth-child(2)', n => n.classList.contains('active')), true)
    assert.equal(await page.$eval('.pane:nth-child(2) .command-input', n => n === document.activeElement), true)
    await page.click('#sessions button:first-child')
    await page.type('.command-input', 'git status')
    await page.click('.command-form button')
    assert.match(await text('.terminal'), /working tree clean/)
    await page.click('#broadcast')
    await page.click('.pane:nth-child(2) .pane-foot input')
    await page.type('.command-input', 'npm test')
    await page.click('.command-form button')
    const outputs = await page.$$eval('.terminal', nodes => nodes.map(n => n.textContent))
    assert.match(outputs[0], /12 tests/)
    assert.doesNotMatch(outputs[1], /12 tests/)
    assert.match(outputs[2], /12 tests/)
    await page.click('#broadcast')
    await page.type('#task-title', 'Tester la démo')
    await page.click('#task-form button')
    assert.equal(await count('.task-card'), 4)
    const added = await page.$$('.task-card')
    for (const card of added) {
      if ((await card.evaluate(n => n.textContent)).includes('Tester la démo')) {
        await (await card.$('select')).select('done')
        break
      }
    }
    assert.match(await text('#task-list section:last-child'), /Tester la démo/)
    await page.click('#new-pane')
    await page.select('#pane-type', 'Gemini')
    await page.click('#modal-actions button')
    assert.equal(await count('.pane'), 4)
    await page.select('#layout', 'rows')
    assert.equal(await page.$eval('#panes', n => n.classList.contains('rows')), true)
    await page.select('#layout', 'grid')
    await page.click('#add-workspace')
    await page.type('#modal-body input', 'Projet test')
    await page.click('#modal-actions button')
    assert.equal(await text('#project-name'), 'Projet test')
    assert.equal(await count('.pane'), 0)
    await page.click('.empty button')
    await page.click('#modal-actions button')
    assert.equal(await count('.pane'), 1)
    await page.reload()
    assert.equal(await text('#project-name'), 'Projet test')
    assert.equal(await count('.pane'), 1)
    await page.click('#workspaces button:first-child')
    assert.equal(await count('.pane'), 4)
    await page.click('.pane:last-child .pane-head .icon-button')
    assert.equal(await count('.pane'), 3)
    await page.click('#toggle-tasks')
    assert.equal(await page.$eval('#tasks', n => n.hidden), true)
    await page.click('#toggle-tasks')
    await page.click('#theme')
    assert.equal(await page.$eval('html', n => n.dataset.theme), 'light')
    await page.screenshot({ path: path.join(__dirname, 'demo-light.png'), fullPage: true })
    await page.click('#theme')
    await page.click('#reset')
    await page.click('#modal-actions button')
    assert.equal(await count('.pane'), 3)
    assert.equal(await count('.task-card'), 3)
    await page.screenshot({ path: path.join(__dirname, 'demo-desktop.png'), fullPage: true })
    for (const [width, height] of [[1440,900],[1366,768],[1280,720],[1024,600],[736,700],[390,700],[320,640]]) {
      await page.setViewport({ width, height })
      const fit = await page.evaluate(() => {
        const root = document.documentElement
        const inside = node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1 }
        return {
          documentFits: root.scrollWidth <= innerWidth && root.scrollHeight <= innerHeight,
          controlsFit: Array.from(document.querySelectorAll('.command-form, .pane-head, footer')).every(inside),
          terminalSpace: Array.from(document.querySelectorAll('.terminal')).every(n => n.clientHeight >= 30),
          panesFit: document.getElementById('panes').scrollHeight <= document.getElementById('panes').clientHeight
        }
      })
      assert.deepEqual(fit, { documentFits:true, controlsFit:true, terminalSpace:true, panesFit:true }, `Viewport ${width}x${height}`)
    }
    await page.screenshot({ path: path.join(__dirname, 'demo-mobile.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log('PASS: interactions et interface compacte sans débordement global, panneaux et saisie visibles de 320x640 à 1440x900.')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
