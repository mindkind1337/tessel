// @vitest-environment node
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { freeDevPort, portFree, DEV_HOST } from '../../../scripts/devPort.mjs'

const listen = (port, host) =>
  new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen({ port, host }, () => resolve(s))
  })

describe('dev server port (scripts/devPort.mjs)', () => {
  it('skips a port another server holds on 127.0.0.1', async () => {
    const busy = await listen(0, DEV_HOST)
    const port = busy.address().port
    try {
      expect(await portFree(port)).toBe(false)
      const got = await freeDevPort({ start: port })
      expect(got).toBeGreaterThan(port)
      expect(await portFree(got)).toBe(true)
    } finally {
      await new Promise((r) => busy.close(r))
    }
  })

  it('tries the next ports, and falls back to the first one', async () => {
    const seen = []
    expect(await freeDevPort({ start: 6000, isFree: async (p) => (seen.push(p), p === 6002) })).toBe(6002)
    expect(seen).toEqual([6000, 6001, 6002])
    expect(await freeDevPort({ start: 6000, tries: 3, isFree: async () => false })).toBe(6000)
  })

  it('the dev window uses 127.0.0.1 with a strict port, and main allows only that origin', () => {
    const root = join(__dirname, '../../..')
    const cfg = readFileSync(join(root, 'electron.vite.config.mjs'), 'utf8')
    expect(cfg).toMatch(/host: DEV_HOST/)
    expect(cfg).toMatch(/strictPort: true/)
    expect(cfg).toMatch(/freeDevPort\(\)/)
    const main = readFileSync(join(root, 'src/main/index.js'), 'utf8')
    expect(main).not.toMatch(/localhost:5173'\)\)/)
    expect(main).toMatch(/new URL\(devRendererUrl\)\.origin/)
    // Only the dev build reads the variable: an installed Tessel loads its own page.
    expect(main).toMatch(/const devRendererUrl = !app\.isPackaged && process\.env\.ELECTRON_RENDERER_URL/)
  })
})
