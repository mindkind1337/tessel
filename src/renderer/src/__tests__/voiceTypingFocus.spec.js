// The mic (voice typing) types where the user means: a chat's composer keeps
// the keyboard, and a terminal agent shown as a chat gives it to its composer,
// never to the terminal behind (App.vue's own voiceTyping / focusActiveInput).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8').replace(/\r\n/g, '\n')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

function load() {
  const ctx = {
    document,
    floating: { hasKeyboard: () => false },
    activeId: { value: 'p1' },
    getEditorPane: () => null,
    focusPane: vi.fn(),
    nextTick: async () => {},
    showToast: vi.fn(),
    t: (k, en) => en,
    settings: { voiceTip: null },
    window: { shellApi: { voiceTyping: vi.fn(async () => true) } }
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function focusActiveInput()', '\n}\n') + '\n}\n' + slice('// A text field the caller focused in that pane', 'function openTools()') + '\nthis.api = { voiceTyping }',
    ctx
  )
  return ctx
}

beforeEach(() => {
  document.body.innerHTML = `
    <div class="ws-layer">
      <div class="pane active" data-pane-id="p1">
        <textarea class="xterm-helper-textarea"></textarea>
        <div data-test="terminal-chat-view"><div class="composer" contenteditable="true"></div></div>
      </div>
    </div>`
})

describe('voice typing focus', () => {
  it("a terminal agent shown as a chat: its composer gets the keyboard, not the terminal", async () => {
    const ctx = load()
    document.querySelector('.xterm-helper-textarea').focus()
    await ctx.api.voiceTyping('p1')
    expect(document.activeElement).toBe(document.querySelector('.composer'))
    expect(ctx.window.shellApi.voiceTyping).toHaveBeenCalled()
  })

  it('the composer the caller focused keeps the keyboard', async () => {
    const ctx = load()
    const composer = document.querySelector('.composer')
    composer.focus()
    await ctx.api.voiceTyping('p1')
    expect(document.activeElement).toBe(composer)
  })

  it('a plain terminal: the terminal gets the keyboard', async () => {
    document.querySelector('[data-test="terminal-chat-view"]').remove()
    const ctx = load()
    await ctx.api.voiceTyping('p1')
    expect(document.activeElement).toBe(document.querySelector('.xterm-helper-textarea'))
  })
})
