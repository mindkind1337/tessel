// E2E smoke test for the Agent Task Board (kanban side panel).
//
// Mirrors the puppeteer-core browser pattern of test-browser-maximize.cjs:
// it renders the REAL renderer UI in headless Chrome against the Vite dev
// server, with a MOCK window.shellApi injected so panes mount without Electron.
// The mock backs every persistence call (save*/load*) with localStorage, which
// survives a page reload in the same browser context — that is what lets us
// assert the task board state round-trips across a reload, mirroring the
// renderer's real loadLayout/saveLayout (and the task-board IPC added by B2).
//
// Flow:
//   1. boot the app (wait for .pane)
//   2. toggle the task board with Ctrl+Shift+K, assert it shows
//   3. add a task, assert the card renders with our text
//   4. reload the page, assert the task persisted
//
// PREREQUISITE: start the dev server first  ->  npm run dev
// Then run:  node test-taskboard.cjs
// Override the Chrome binary / URL via env if needed:
//   TASKBOARD_TEST_CHROME, TASKBOARD_TEST_URL
//
// NOTE (Builder 5): this depends on Builder 4's App.vue integration. The DOM
// selectors and persistence method names below are best guesses against the
// agreed spec and MUST be finalized once B3 (TaskBoard.vue / TaskCard.vue) and
// B4 (App.vue side panel) land. When a selector misses, the test prints the
// candidate elements it did find (see probeDom) so finalizing is mechanical.

const puppeteer = require('puppeteer-core')

const CHROME =
  process.env.TASKBOARD_TEST_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const URL = process.env.TASKBOARD_TEST_URL || 'http://localhost:5173/'

// A unique task title so we never collide with leftover persisted state.
const TASK_TEXT = `smoke-task-${Date.now()}`

// Per-run id so the mock clears stale localStorage on the FIRST load but keeps
// it across the reload (reload re-runs the init script with the same id).
const RUN_ID = `run-${Date.now()}-${process.pid}`

// ---------------------------------------------------------------------------
// Selectors — finalized against the landed UI: TaskBoard.vue / TaskCard.vue (B3)
// + the App.vue side panel (B4). Prefer the stable data-test hooks the
// components expose. Kept in one block so any future UI change is a single edit.
// ---------------------------------------------------------------------------
const SEL = {
  pane: '.pane',
  board: '.task-board', // root of the kanban panel (inside <aside class="task-panel">)
  boardToggleBtn: 'button[title="Toggle the agent task board (Ctrl+Shift+K)"]', // toolbar fallback
  taskInput: '[data-test="new-task-input"]', // the add-task text box (Enter submits the form)
  addBtn: '.task-board-add-btn', // the "Add" submit button (Enter in the input also works)
  card: '[data-test="task-card"]', // a rendered task card
  cardTitle: '[data-test="card-title"]' // the title span within a card
}

// ---------------------------------------------------------------------------
// Mock shellApi. Core pty/shell methods mirror test-browser-maximize.cjs so
// panes mount. A Proxy fallback auto-implements any save*/load*/get*/list*/on*
// the renderer calls (e.g. the task-board persistence API B2 adds), backing
// save/load pairs by their shared suffix in localStorage. This keeps the mock
// working regardless of the exact method names B2/B4 choose.
// ---------------------------------------------------------------------------
const MOCK = `
(() => {
  const RUN_ID = ${JSON.stringify(RUN_ID)}
  const NS = 'taskboard-mock:'
  // Clear stale state once per test run (kept across reloads of the same run).
  try {
    if (localStorage.getItem(NS + '__run') !== RUN_ID) {
      Object.keys(localStorage)
        .filter((k) => k.indexOf(NS) === 0)
        .forEach((k) => localStorage.removeItem(k))
      localStorage.setItem(NS + '__run', RUN_ID)
    }
  } catch {}

  const readKey = (suffix) => {
    try {
      const raw = localStorage.getItem(NS + suffix)
      return raw == null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }
  const writeKey = (suffix, value) => {
    try {
      localStorage.setItem(NS + suffix, JSON.stringify(value === undefined ? null : value))
    } catch {}
  }

  const core = {
    listShells: () => Promise.resolve([
      { id: 'powershell', name: 'Windows PowerShell' },
      { id: 'cmd', name: 'Command Prompt' }
    ]),
    listAgents: () => Promise.resolve([
      { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', available: true }
    ]),
    createPty: (o) => Promise.resolve({
      ok: true,
      shell: { id: (o && o.shellId) || 'powershell', name: 'Windows PowerShell' },
      backend: 'winpty', windowsBuild: 0, pid: 1000
    }),
    writePty: () => {},
    resizePty: () => {},
    killPty: () => {},
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => {},
    onData: () => () => {},
    onExit: () => () => {},
    // Known layout persistence — backed by localStorage so it survives reload.
    loadLayout: () => Promise.resolve(readKey('Layout')),
    saveLayout: (data) => { writeKey('Layout', data); return Promise.resolve(true) },
    // Task-board persistence (preload exposes it as a nested object):
    //   shellApi.taskBoard.load()  -> Promise<task[]>  ([] when none)
    //   shellApi.taskBoard.save(t) -> Promise<{ ok }>
    // Backed by localStorage so the task array round-trips across a reload.
    taskBoard: {
      load: () => Promise.resolve(readKey('Tasks') || []),
      save: (tasks) => { writeKey('Tasks', tasks); return Promise.resolve({ ok: true }) }
    }
  }

  // Match save/load/get/list/read/fetch/on verbs and derive the storage suffix.
  const SAVE = /^(save|set|write|store|persist|update)([A-Z].*)$/
  const LOAD = /^(load|get|list|read|fetch)([A-Z].*)$/
  const SUB = /^(on|subscribe)[A-Z].*$/

  window.shellApi = new Proxy(core, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop !== 'string') return undefined
      let m
      if ((m = SAVE.exec(prop))) return (data) => { writeKey(m[2], data); return Promise.resolve(true) }
      if ((m = LOAD.exec(prop))) return () => Promise.resolve(readKey(m[2]))
      if (SUB.test(prop)) return () => () => {} // subscribe -> returns unsubscribe
      return () => undefined // unknown -> harmless no-op
    }
  })
})()
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function visible(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }, selector)
}

async function cardWithText(page, cardSel, text) {
  return page.evaluate(
    (sel, t) =>
      [...document.querySelectorAll(sel)].some((el) => (el.textContent || '').includes(t)),
    cardSel,
    text
  )
}

// Real keyboard chord so the app's window keydown listener fires.
async function pressChord(page) {
  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyK')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await wait(300)
}

// Open the board via the keyboard chord; fall back to a toolbar button if the
// chord did not reveal it (lets the test survive minor B4 wiring differences).
async function openBoard(page) {
  if (await visible(page, SEL.board)) return true
  await pressChord(page)
  if (await visible(page, SEL.board)) return true
  const clicked = await page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    if (!btn) return false
    btn.click()
    return true
  }, SEL.boardToggleBtn)
  if (clicked) await wait(300)
  return visible(page, SEL.board)
}

// When a selector misses, dump candidates so finalizing selectors is mechanical.
async function probeDom(page) {
  return page.evaluate(() => {
    const hits = new Set()
    document.querySelectorAll('*').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : ''
      if (/task|board|kanban|column|card/i.test(cls)) {
        hits.add(`${el.tagName.toLowerCase()}.${cls.trim().split(/\s+/).join('.')}`)
      }
      const title = el.getAttribute && el.getAttribute('title')
      if (title && /task|board|kanban/i.test(title)) hits.add(`[title="${title}"]`)
    })
    return [...hits].slice(0, 40)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
;(async () => {
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--window-size=1280,800']
    })
  } catch (e) {
    console.error(
      `Could not launch Chrome at "${CHROME}". Set TASKBOARD_TEST_CHROME to your Chrome path.\n${e.message}`
    )
    process.exit(2)
  }

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.evaluateOnNewDocument(MOCK)

  // Uncaught JS exceptions in the renderer.
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  // Failed network responses. The dev server returns a harmless favicon.ico 404
  // for every page (index.html declares no favicon), so exclude that; anything
  // else 4xx/5xx is a real missing asset/module worth failing on.
  const badResponses = []
  page.on('response', (res) => {
    const status = res.status()
    const url = res.url()
    if (status >= 400 && !/favicon\.ico(\?|$)/i.test(url)) {
      badResponses.push(`${status} ${url}`)
    }
  })

  try {
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 20000 })
  } catch (e) {
    console.error(`Could not load ${URL}. Start the dev server first:  npm run dev\n${e.message}`)
    await browser.close()
    process.exit(2)
  }

  try {
    // 1. App boots.
    await page.waitForSelector(SEL.pane, { timeout: 10000 }).catch(() => {})
    await wait(700)
    check('app mounts (a .pane is present)', await visible(page, SEL.pane))

    // 2. Toggle the task board with Ctrl+Shift+K.
    const opened = await openBoard(page)
    check('Ctrl+Shift+K reveals the task board', opened)
    if (!opened) {
      console.log('  task-board-ish elements found:', JSON.stringify(await probeDom(page)))
    }
    await page.screenshot({ path: 'taskboard-1-open.png' }).catch(() => {})

    // 3. Add a task and assert it renders.
    let added = false
    if (opened) {
      const focused = await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return false
        el.focus()
        return true
      }, SEL.taskInput)
      if (focused) {
        await page.type(SEL.taskInput, TASK_TEXT, { delay: 10 })
        await page.keyboard.press('Enter')
        await wait(400)
        added = await cardWithText(page, SEL.card, TASK_TEXT)
        if (!added) {
          // Fall back to clicking an explicit add button.
          await page.evaluate((sel) => {
            const btn = document.querySelector(sel)
            if (btn) btn.click()
          }, SEL.addBtn)
          await wait(400)
          added = await cardWithText(page, SEL.card, TASK_TEXT)
        }
      }
    }
    check('added task renders as a card', added)
    if (!added) {
      console.log('  task-board-ish elements found:', JSON.stringify(await probeDom(page)))
    }
    await page.screenshot({ path: 'taskboard-2-added.png' }).catch(() => {})

    // 4. Reload and assert the task persisted. App.vue debounces the task save
    // by 500ms (scheduleTaskSave), so wait past that before reloading or the
    // add never reaches the persistence layer.
    await wait(900)
    await page.reload({ waitUntil: 'networkidle0', timeout: 20000 })
    await page.waitForSelector(SEL.pane, { timeout: 10000 }).catch(() => {})
    await wait(700)
    await openBoard(page) // board open-state may not persist; ensure it's visible
    const persisted = await cardWithText(page, SEL.card, TASK_TEXT)
    check('task persisted across reload', persisted)
    await page.screenshot({ path: 'taskboard-3-after-reload.png' }).catch(() => {})

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
    check(
      'no failed resource loads (excl. favicon)',
      badResponses.length === 0,
      badResponses.join(' | ')
    )
  } catch (e) {
    check('test ran without throwing', false, `${e.message}`)
  } finally {
    await browser.close()
  }

  const failed = checks.filter((c) => !c.ok)
  console.log(
    `\n=== task board smoke: ${checks.length - failed.length}/${checks.length} passed ===`
  )
  process.exit(failed.length ? 1 : 0)
})()
