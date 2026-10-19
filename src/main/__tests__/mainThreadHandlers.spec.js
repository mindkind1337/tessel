// @vitest-environment node
// IPC handlers that held the main process for seconds (the log's "IPC ...
// held the main process for N ms"), taken from index.js: they no longer read,
// write or start programs synchronously, and answer as before.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
// A top-level statement of index.js, from `start` to its closing line.
function block(start, end = '\n})\n') {
  const at = main.indexOf(start)
  if (at < 0) throw new Error(`not found: ${start}`)
  return main.slice(at, main.indexOf(end, at) + end.length)
}

describe('sessions:reported', () => {
  const source = block("ipcMain.handle('sessions:reported',")

  it('reads the folder without a synchronous call', () => {
    expect(source).not.toMatch(/Sync\(/)
  })

  it('answers as before: one entry per readable session file, in file order, keys kept in this process', async () => {
    const files = {
      'pane-1.json': JSON.stringify({ sessionId: 's1', agent: 'claude', inbox: true, inboxToken: 'secret', transcriptPath: 'C:\\t.jsonl' }),
      'pane-2.json': '{ broken',
      'pane-3.json': JSON.stringify({ sessionId: 's3', agent: 'codex' }),
      'notes.txt': 'x',
      'pane-4.json': JSON.stringify({ agent: 'no session' })
    }
    const handlers = {}
    vm.runInNewContext(source, {
      ipcMain: { handle: (k, v) => (handlers[k] = v) },
      sessionsDir: () => 'D',
      join: (a, b) => `${a}/${b}`,
      fs: {
        promises: {
          readdir: async () => Object.keys(files),
          readFile: async (p) => {
            const name = p.slice(2)
            if (name === 'pane-3.json') await new Promise((r) => setTimeout(r, 10)) // answered last
            return files[name]
          }
        }
      }
    })
    const out = await handlers['sessions:reported']()
    expect(Object.keys(out)).toEqual(['pane-1', 'pane-3'])
    expect(out['pane-1']).toEqual({ sessionId: 's1', agent: 'claude', inbox: true })
    expect(out['pane-3']).toEqual({ sessionId: 's3', agent: 'codex', inbox: false })
  })

  it('a missing folder: an empty answer', async () => {
    const handlers = {}
    vm.runInNewContext(source, {
      ipcMain: { handle: (k, v) => (handlers[k] = v) },
      sessionsDir: () => 'D',
      join: (a, b) => `${a}/${b}`,
      fs: { promises: { readdir: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) } } }
    })
    expect(await handlers['sessions:reported']()).toEqual({})
  })
})

describe('activity:save', () => {
  const source = block('// Written without blocking (several MB: written synchronously it held the', "\n    if (!activityPumping) void pumpActivity()\n  })\n})\n")

  // Each async write or rename waits until the test lets it through
  // (h.step()), and only then changes the files.
  function harness() {
    const handlers = {}
    const quit = []
    const files = {}
    const ops = []
    const gates = []
    const gated = (fn) => new Promise((resolve, reject) => gates.push(() => {
      try {
        resolve(fn())
      } catch (err) {
        reject(err)
      }
    }))
    const ctx = {
      ipcMain: { handle: (k, v) => (handlers[k] = v) },
      app: { on: (ev, fn) => ev === 'will-quit' && quit.push(fn) },
      activityFile: () => 'A.json',
      isActivityText: (t) => t.startsWith('['),
      trimEvents: (e) => e,
      isEvent: () => true,
      log: { warn: vi.fn() },
      JSON,
      fs: {
        writeFileSync: (p, t) => (ops.push(['writeSync', t]), (files[p] = t)),
        renameSync: (a, b) => (files[b] = files[a]),
        promises: {
          writeFile: (p, t) => (ops.push(['write', t]), gated(() => (files[p] = t))),
          rename: (a, b) => (ops.push(['rename', files[a]]), gated(() => (files[b] = files[a])))
        }
      }
    }
    vm.runInNewContext(source, ctx)
    const tick = () => new Promise((r) => setTimeout(r, 0))
    return {
      save: (e) => handlers['activity:save']({}, e),
      quit: () => quit.forEach((f) => f()),
      // Lets the oldest waiting operation through.
      step: async () => {
        await tick()
        const g = gates.shift()
        if (g) g()
        await tick()
      },
      files,
      ops
    }
  }

  it('writes without a synchronous write, as before ({ ok: true }); only the newest waiting save is written next', async () => {
    const h = harness()
    const a = h.save('[1]')
    const b = h.save('[1,2]')
    const c = h.save('[1,2,3]')
    await h.step() // [1] written to the temp file
    await h.step() // and renamed
    await h.step() // then [1,2,3]: [1,2] was replaced while waiting
    await h.step()
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    expect(await c).toEqual({ ok: true })
    expect(h.files['A.json']).toBe('[1,2,3]')
    expect(h.ops).toEqual([['write', '[1]'], ['rename', '[1]'], ['write', '[1,2,3]'], ['rename', '[1,2,3]']])
    expect(await h.save('not a list')).toEqual({ ok: false, error: 'not a list' })
  })

  it('quitting with a save waiting: the newest written at will-quit, the older one in flight never renamed over it', async () => {
    const h = harness()
    const a = h.save('[1]')
    const b = h.save('[1,2]')
    await new Promise((r) => setTimeout(r, 0)) // [1] being written to its temp file
    h.quit()
    expect(h.files['A.json']).toBe('[1,2]')
    await h.step() // its write ends after will-quit: no rename
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    expect(h.files['A.json']).toBe('[1,2]')
    expect(h.ops.filter(([op]) => op === 'rename')).toEqual([])
  })

  it("an older rename landing after will-quit's write: the newest text written again", async () => {
    const h = harness()
    const a = h.save('[1]')
    await h.step() // [1] in its temp file, its rename waiting
    const b = h.save('[1,2]')
    h.quit() // writes [1,2]
    expect(h.files['A.json']).toBe('[1,2]')
    await h.step() // the [1] rename lands now
    await a
    expect(await b).toEqual({ ok: true })
    expect(h.files['A.json']).toBe('[1,2]')
  })

  it('a save arriving after will-quit is written synchronously', async () => {
    const h = harness()
    h.quit()
    expect(await h.save('[9]')).toEqual({ ok: true })
    expect(h.files['A.json']).toBe('[9]')
    expect(h.ops).toEqual([['writeSync', '[9]']])
  })
})

describe('the handlers that started programs on the main thread', () => {
  it("index.js's execFile (app:inputLanguages' PowerShell...) is the worker thread's (spawnOffThread.js)", () => {
    expect(main).toMatch(/^import \{ execFileOff as execFile, spawnOff \} from '\.\/spawnOffThread'$/m)
    expect(main).not.toMatch(/^import \{[^}]*execFile[^}]*\} from '(node:)?child_process'$/m)
    expect(block("ipcMain.handle('app:inputLanguages',")).toMatch(/execFile\(\s*'powershell\.exe'/)
  })

  it("agents:probeModels' CLIs and Muse's server start from the worker thread", () => {
    expect(main).toMatch(/createModelLister\(app\.getPath\('userData'\), \{ resolve: resolveProgram, spawn: spawnOff \}\)/)
  })
})

describe('clipboard:sendImageFileToHost', () => {
  const source = block("ipcMain.handle('clipboard:sendImageFileToHost',")

  function harness({ saved, png }) {
    const handlers = {}
    const sent = []
    const nativeImage = { createFromPath: vi.fn(() => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toPNG: () => Buffer.from('re-encoded') })) }
    const mainWindow = { isDestroyed: () => false, webContents: {} }
    vm.runInNewContext(source, {
      ipcMain: { handle: (k, v) => (handlers[k] = v) },
      mainWindow,
      t: (_k, s) => s,
      isSavedPaste: () => saved,
      isImageFile: () => true,
      HOST_IMAGE_BYTES: 20 * 1024 * 1024,
      PASTE_LIMITS: { pixels: 25e6 },
      pngSize: (buf) => (buf.toString().startsWith('PNG') ? { width: 3, height: 3 } : null),
      nativeImage,
      remoteFs: { pasteImage: async (host, bytes) => (sent.push([host, String(bytes)]), { ok: true, path: '/tmp/x.png' }) },
      fs: {
        lstatSync: () => {
          throw new Error('sync')
        },
        constants: { O_RDONLY: 0 },
        promises: {
          lstat: async () => ({ isFile: () => true, size: 100 }),
          // One handle: checked and read through it, then closed.
          open: async () => ({ stat: async () => ({ isFile: () => true, size: 100 }), readFile: async () => Buffer.from(png), close: async () => {} })
        }
      }
    })
    return { call: () => handlers['clipboard:sendImageFileToHost']({ sender: mainWindow.webContents }, 'h1', 'C:\\p\\image-1.png'), sent, nativeImage }
  }

  it("a PNG Tessel saved itself is sent as it is: never decoded and encoded again on the main thread", async () => {
    const h = harness({ saved: true, png: 'PNG-bytes' })
    expect(await h.call()).toEqual({ ok: true, path: '/tmp/x.png' })
    expect(h.sent).toEqual([['h1', 'PNG-bytes']])
    expect(h.nativeImage.createFromPath).not.toHaveBeenCalled()
    expect(await harness({ saved: true, png: 'not a png' }).call()).toEqual({ ok: false, error: 'That file is not an image.' })
  })

  it('any other image file is still decoded and made a PNG again', async () => {
    const h = harness({ saved: false, png: '' })
    await h.call()
    expect(h.nativeImage.createFromPath).toHaveBeenCalled()
    expect(h.sent).toEqual([['h1', 're-encoded']])
  })
})
