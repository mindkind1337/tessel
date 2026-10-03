// @vitest-environment node
// How the chat is wired in main (index.js) and the preload, read from the
// source (index.js cannot run outside Electron).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p) => readFileSync(join(__dirname, '..', '..', '..', p), 'utf8')

describe('chat wiring', () => {
  it('quitting waits for the chats, killed at once (no orphaned claude)', () => {
    const main = src('main/index.js')
    const quit = /app\.on\('before-quit', \(event\) => \{[\s\S]*?Promise\.allSettled\(\[([^\]]*)\]\)/.exec(main)
    expect(quit).toBeTruthy()
    expect(quit[1]).toContain('chatSessions.closeAll({ kill: true })')
    // An update install skips before-quit's shutdown: it closes them itself.
    expect(main).toMatch(/beforeInstall:[\s\S]*?chatSessions\.closeAll\(\{ kill: true \}\)[\s\S]*?shutdownDone = true/)
  })

  it('no chat:trust channel: a folder is trusted only through the dialog of chat:open', () => {
    expect(src('preload/index.js')).not.toMatch(/chat:trust/)
    expect(src('main/chat/sessions.js')).not.toMatch(/chat:trust/)
  })

  it('a chat pane closed for good forgets its journal', () => {
    const app = src('renderer/src/App.vue')
    // Each function that closes a chat forgets its journal (a chat going on
    // in a terminal is stopped first and forgotten once the terminal is there).
    const fns = app.split(/\n(?=(?:async )?function )/)
    const closing = fns.filter((f) => /shellApi\.chat\.close\(\{/.test(f))
    expect(closing.length).toBeGreaterThan(0)
    for (const f of closing) expect(f).toMatch(/shellApi\.chat\.close\(\{[^}]*forget: true[^}]*\}\)/)
  })
})
