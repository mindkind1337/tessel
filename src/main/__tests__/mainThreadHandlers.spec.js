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
  const source = block('let activitySaving = Promise.resolve()', "\n  return save\n})\n")

  function harness() {
    const handlers = {}
    const quit = []
    const written = {}
    const ops = []
    let release = null
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
        writeFileSync: (p, t) => (ops.push(['writeSync', p]), (written[p] = t)),
        renameSync: (a, b) => (ops.push(['renameSync', a, b]), (written[b] = written[a])),
        promises: {
          writeFile: async (p, t) => {
            ops.push(['write', p])
            if (release === null) await new Promise((r) => (release = r))
            written[p] = t
          },
          rename: async (a, b) => {
            ops.push(['rename', a, b])
            written[b] = written[a]
          }
        }
      }
    }
    vm.runInNewContext(source, ctx)
    return { save: (e) => handlers['activity:save']({}, e), quit: () => quit.forEach((f) => f()), written, ops, release: () => release && release() }
  }

  it('writes the file without a synchronous write, one save after the other, as before ({ ok: true })', async () => {
    const h = harness()
    const a = h.save('[1]')
    const b = h.save('[1,2]')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.ops).toEqual([['write', 'A.json.tmp']]) // the second waits for the first
    h.release()
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    expect(h.written['A.json']).toBe('[1,2]')
    expect(h.ops.some(([op]) => op.endsWith('Sync'))).toBe(false)
    expect(await h.save('not a list')).toEqual({ ok: false, error: 'not a list' })
  })

  it('quitting before the last save is written: written at will-quit, never replaced by an older one', async () => {
    const h = harness()
    const a = h.save('[1]')
    await new Promise((r) => setTimeout(r, 0))
    h.quit()
    expect(h.written['A.json']).toBe('[1]')
    h.release()
    await a
    expect(h.ops.filter(([op]) => op === 'rename')).toEqual([])
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
        promises: { lstat: async () => ({ isFile: () => true, size: 100 }), readFile: async () => Buffer.from(png) }
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
