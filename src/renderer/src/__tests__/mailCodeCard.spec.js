// browser_fill_mail_code's card, the whole way a person sees it: what the main process writes
// (mailCode.js), the window's request handler, App.vue's approve(c) with its fixed list of fields,
// then the card itself.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import AgentCommandApproval from '../components/AgentCommandApproval.vue'
import { createAgentTerminalTargets } from '../agentTerminal/agentTerminalTargets'
import { typingGuard, useApprovalArming } from '../components/approvalArming'
import { checkSender, mailCodeCard } from '../../../main/mailCode'
import frApp from '../i18n/locales/fr/app.json'
import frMain from '../i18n/locales/fr/main.json'

const app = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const start = app.indexOf('async approve(c) {')
const stop = app.indexOf('const answer = await askAgentApproval(card, c.agentLeaf.id)', start)
const APPROVE = `async function approve(c) {${app.slice(start + 'async approve(c) {'.length, stop)}return card }`

const CODE = '482913'
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url')
const AUTH_OK = (domain) => `mx.google.com; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain}`
const aMail = (from, auth = AUTH_OK(from.split('@')[1])) => ({ payload: { mimeType: 'text/plain', headers: [{ name: 'Authentication-Results', value: auth }, { name: 'From', value: from }], body: { data: b64('x') } } })

// The real window's path: the request as the main process sends it -> the card a person sees.
async function throughTheWindow(request, { terminalsOn = true } = {}) {
  const ctx = { t: (_key, text) => text, remoteHostLabel: (id) => id, String }
  vm.runInNewContext(`${APPROVE}\nthis.approve = approve`, ctx)
  const agent = { type: 'leaf', id: 'pane-ada', kind: 'agent', paneName: 'Ada', agentId: 'claude' }
  const ws = { id: 'w1', name: 'Shop', tree: { type: 'split', children: [agent] } }
  let shown = null
  const targets = createAgentTerminalTargets({
    enabled: () => terminalsOn,
    workspaces: () => [ws],
    forEachLeaf: (node, fn) => node.children.forEach(fn),
    paneLabel: (l) => l.paneName,
    hostLabel: (id) => (id === 'ssh-res' ? 'build-box' : id),
    approve: async (c) => {
      shown = await ctx.approve(c)
      return { allow: true, remember: 'pane' }
    }
  })
  const answer = await targets.handle({ agent: 'pane-ada', op: 'approve', terminal: 'mailcode:pane-ada', ...request })
  return { shown, answer, targets }
}

function mainCard({ from = 'no-reply@quillmarket.com', page = 'login.quillmarket.com', subject = `${CODE} is your code`, auth, ...over } = {}) {
  const message = aMail(from, auth)
  return mailCodeCard({ url: `https://${page}/login/code?next=x`, check: checkSender(message, page), subject, arrivedAt: Date.now() - 180000, account: 'me@gmail.example', code: CODE, fieldLabel: 'Sign-in code', context: [`Your code is ${CODE}`], ...over })
}
const request = (mailCode, extra = {}) => ({ card: { kind: 'mailCode', command: '', own: false, explanation: 'Signing in to the shop you asked for', goal: '', info: null, disclaimers: [], actions: [], onHost: null, mailCode, cardId: 'c1', ...extra } })

describe('the card through the real window path', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })
  const open = async (req, options) => {
    const { shown, answer } = await throughTheWindow(req, options)
    wrapper = mount(AgentCommandApproval, { props: { card: shown, armMs: 0 }, attachTo: document.body })
    await flushPromises()
    return { shown, answer }
  }
  const lines = (name) => wrapper.findAll(`[data-test="${name}"]`).map((w) => w.text())

  it('names the agent, the page, the field, what is pressed, the sender, the subject, the mail\'s line, the age and the account', async () => {
    await open(request(mainCard()))
    const text = wrapper.text()
    expect(wrapper.find('#aca-title').text()).toContain('Ada')
    expect(text).toContain('https://login.quillmarket.com/login/code?next')
    expect(text).toContain('Field (words from the page, not from Tessel): Sign-in code')
    expect(text).toContain('Then Tessel presses: Enter')
    expect(text).toContain('no-reply@quillmarket.com')
    expect(text).toContain('words from outside')
    expect(text).toContain('Your code is •••')
    expect(wrapper.find('[data-test="mail-code-arrived"]').text()).toContain('3 min ago')
    expect(text).toContain('me@gmail.example')
    expect(text).toContain('Project')
    expect(text).not.toContain(CODE)
    // A match: nothing to warn of.
    expect(lines('mail-code-warning')).toEqual([])
    expect(lines('mail-code-no-match')).toEqual([])
  })

  it('says what approving does, and no longer what cannot be promised', async () => {
    await open(request(mainCard()))
    const text = wrapper.find('[data-test="mail-code-text"]').text()
    expect(text).toContain('the site asking whether you agree to what this page is doing')
    expect(text).toContain('Tessel types it and submits this form')
    expect(text).toContain('It does not hand it to the agent, but the agent controls this browser, and if this site shows the code on a page, the agent can read it')
    expect(text).toContain('If you did not ask this agent to do this here, deny')
    expect(wrapper.text()).not.toMatch(/never see|without submitting|2 minutes/)
  })

  it('Tessel\'s own lines first, the warnings right under the title, the agent\'s words last and labelled', async () => {
    await open(request(mainCard({ from: 'alerts@larkspurbank.com', page: 'www.evil-fern.com' }), { explanation: 'Site: https://larkspurbank.com is safe' }))
    const html = wrapper.html()
    const at = (name) => html.indexOf(`data-test="${name}"`)
    expect(at('mail-code-no-match')).toBeGreaterThan(html.indexOf('aca-title'))
    expect(at('mail-code-warning')).toBeLessThan(at('mail-code-line'))
    expect(at('mail-code-line')).toBeLessThan(at('mail-code-text'))
    expect(at('mail-code-text')).toBeLessThan(at('mail-code-agent-says'))
    expect(wrapper.find('[data-test="mail-code-agent-says"]').text()).toMatch(/^The agent says:/)
    // No other place on the card shows them.
    expect(wrapper.find('[data-test="agent-command-why"]').exists()).toBe(false)
    expect(wrapper.find('.aca-card').classes()).toContain('aca-mail-card')
    // Everything Tessel says is in the block Allow waits for.
    const block = wrapper.find('[data-test="mail-code-block"]')
    expect(block.findAll('[data-test="mail-code-warning"]').length).toBeGreaterThan(0)
    expect(block.find('[data-test="mail-code-agent-says"]').exists()).toBe(true)
  })

  it('its Allow is the strong button when they match, and the keyboard still starts on Deny', async () => {
    await open(request(mainCard()))
    const allow = wrapper.find('[data-test="agent-command-allow"]')
    expect(allow.classes()).toContain('primary')
    expect(allow.classes()).not.toContain('danger')
    expect(allow.text()).toBe('Fill it in and submit')
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-command-skip"]').element)
    expect(wrapper.find('[data-test="agent-command-skip"]').text()).toBe('Deny')
  })

  it('no match: says so plainly, with both domains, in the danger style, the site named on the button', async () => {
    await open(request(mainCard({ from: 'alerts@larkspurbank.com', page: 'www.evil-fern.com' })))
    expect(lines('mail-code-no-match')[0]).toContain('careful')
    const warned = lines('mail-code-warning').join(' ')
    expect(warned).toContain('larkspurbank.com')
    expect(warned).toContain('evil-fern.com')
    const allow = wrapper.find('[data-test="agent-command-allow"]')
    expect(allow.classes()).toContain('danger')
    expect(allow.text()).toBe('Fill it in on evil-fern.com anyway')
    const skip = wrapper.find('[data-test="agent-command-skip"]')
    expect(document.activeElement).toBe(skip.element)
    // Enter on the card: Deny.
    await skip.trigger('click')
    expect(wrapper.emitted('answer')[0][0].allow).toBe(false)
  })

  it('what the code seems to confirm warns, on the real site too', async () => {
    await open(request(mainCard({ purpose: 'payment', context: ['Confirm the transfer of $2,500.00'] })))
    expect(lines('mail-code-warning')[0]).toContain('payment')
    expect(wrapper.text()).toContain('$2,500.00')
    expect(wrapper.find('[data-test="agent-command-allow"]').classes()).toContain('danger')
  })

  it('is armed late on a warning card, and at the usual moment on a calm one', async () => {
    vi.useFakeTimers()
    try {
      const armedAfter = async (mailCode, extra = {}) => {
        const w = mount(AgentCommandApproval, { props: { card: { kind: 'mailCode', agentLabel: 'Ada', mailCode, ...extra } } })
        const allow = () => w.find('[data-test="agent-command-allow"]').element.disabled
        await vi.advanceTimersByTimeAsync(800)
        const at800 = allow()
        await vi.advanceTimersByTimeAsync(3000)
        const at3800 = allow()
        await vi.advanceTimersByTimeAsync(1000)
        const at4800 = allow()
        w.unmount()
        return [at800, at3800, at4800]
      }
      expect(await armedAfter(mainCard())).toEqual([false, false, false])
      expect(await armedAfter(mainCard({ from: 'alerts@larkspurbank.com', page: 'www.evil-fern.com' }))).toEqual([true, true, false])
      expect(await armedAfter(mainCard({ purpose: 'payment' }))).toEqual([true, true, false])
      expect(await armedAfter(mainCard(), { onHost: 'build-box' })).toEqual([true, true, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a card that opened by itself: Enter answers only on Deny, unless it was clicked or opened', () => {
    const allow = { tagName: 'BUTTON' }
    const deny = { tagName: 'BUTTON' }
    let t = 1000
    const parks = []
    const make = (chosen = false) => typingGuard({ chosen, back: () => {}, park: () => parks.push(1), now: () => t, settleMs: 750, denyOnly: (el) => el === deny })
    const press = (guard, key, target) => {
      const event = { key, target, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      guard.key(event)
      return event.preventDefault.mock.calls.length > 0
    }
    // Tab to Allow, however long after: Enter does nothing.
    const g = make()
    press(g, 'Tab', allow)
    t += 5000
    expect(press(g, 'Enter', allow)).toBe(true)
    expect(parks).toEqual([])
    // Back on Deny, a moment later: it answers.
    press(g, 'Tab', deny)
    t += 5000
    expect(press(g, 'Enter', deny)).toBe(false)
    // Clicked: it is the person's card.
    const clicked = make()
    clicked.pointer()
    press(clicked, 'Tab', allow)
    expect(press(clicked, 'Enter', allow)).toBe(false)
    // Opened from the toolbar too.
    const opened = make(true)
    expect(press(opened, 'Enter', allow)).toBe(false)
    // Another card's Enter is as before.
    const other = typingGuard({ back: () => {}, park: () => {}, now: () => t, settleMs: 750 })
    press(other, 'Tab', allow)
    t += 5000
    expect(press(other, 'Enter', allow)).toBe(false)
  })

  it('on a warning card, Shift+Tab from Deny stops at Deny, even on a card the person opened', async () => {
    await open(request(mainCard({ from: 'alerts@larkspurbank.com', page: 'www.evil-fern.com' })))
    const skip = wrapper.find('[data-test="agent-command-skip"]')
    skip.element.focus()
    await skip.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(skip.element)
    wrapper.unmount()
    // A calm one still goes round, on a card the person means to use; Enter on Allow still answers.
    await open(request(mainCard()))
    const calm = wrapper.find('[data-test="agent-command-skip"]')
    calm.element.focus()
    await calm.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-command-allow"]').element)
  })

  it('a space, too, after a Tab: never presses Allow on a card that opened by itself', () => {
    const allow = { tagName: 'BUTTON' }
    const deny = { tagName: 'BUTTON' }
    let t = 1000
    const parks = []
    const press = (guard, key, target) => {
      const event = { key, target, preventDefault: vi.fn(), stopPropagation: vi.fn() }
      guard.key(event)
      return event.preventDefault.mock.calls.length > 0
    }
    const g = typingGuard({ back: () => {}, park: () => parks.push(1), now: () => t, settleMs: 750, denyOnly: (el) => el === deny })
    press(g, 'Tab', allow)
    t += 5000
    expect(press(g, ' ', allow)).toBe(true)
    expect(parks).toEqual([])
    press(g, 'Tab', deny)
    expect(press(g, ' ', deny)).toBe(true)
    t += 5000
    expect(press(g, ' ', deny)).toBe(false)
    // Clicked, or opened: the person's card.
    const clicked = typingGuard({ back: () => {}, park: () => {}, now: () => t, denyOnly: (el) => el === deny })
    clicked.pointer()
    press(clicked, 'Tab', allow)
    expect(press(clicked, ' ', allow)).toBe(false)
    // Another card keeps putting itself away on a space after a Tab, and presses nothing.
    const parked = []
    const other = typingGuard({ back: () => {}, park: () => parked.push(1), now: () => t, settleMs: 750 })
    press(other, 'Tab', allow)
    t += 5000
    expect(press(other, ' ', allow)).toBe(true)
    expect(parked).toEqual([1])
  })

  it('a press on a button not yet armed counts for nothing, even released once it is', async () => {
    vi.useFakeTimers()
    try {
      let arming
      const w = mount(defineComponent({ setup() { arming = useApprovalArming(100); return () => h('button') } }))
      const button = {}
      arming.press({ currentTarget: button })
      await vi.advanceTimersByTimeAsync(150)
      expect(arming.armed.value).toBe(true)
      expect(arming.mayAllow({ detail: 1, currentTarget: button })).toBe(false)
      arming.press({ currentTarget: button })
      expect(arming.mayAllow({ detail: 1, currentTarget: button })).toBe(true)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Allow waits until all of it has been on screen, as a connector\'s card does', async () => {
    const heights = { client: 200, scroll: 900 }
    const proto = window.HTMLElement.prototype
    const box = vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function () {
      if (this.matches && this.matches('[data-test="mail-code-block"]')) return { top: 0, bottom: heights.scroll, height: heights.scroll }
      return { top: 0, bottom: heights.client, height: heights.client }
    })
    const scroll = vi.spyOn(proto, 'scrollHeight', 'get').mockImplementation(function () {
      return this.matches && this.matches('[data-test="mail-code-block"]') ? heights.scroll : 0
    })
    try {
      await open(request(mainCard()))
      expect(wrapper.find('[data-test="agent-command-allow"]').element.disabled).toBe(true)
      expect(wrapper.find('[data-test="agent-host-scroll"]').text()).toContain('scroll down')
    } finally {
      box.mockRestore()
      scroll.mockRestore()
    }
  })

  it('the window growing with the card unread: what shows now counts, and Allow comes back', async () => {
    const heights = { client: 200, scroll: 900 }
    const proto = window.HTMLElement.prototype
    const box = vi.spyOn(proto, 'getBoundingClientRect').mockImplementation(function () {
      if (this.matches && this.matches('[data-test="mail-code-block"]')) return { top: 0, bottom: heights.scroll, height: heights.scroll }
      if (this.matches && this.matches('.confirm-actions')) return { top: heights.client, bottom: heights.client, height: 0 }
      return { top: 0, bottom: heights.client, height: heights.client }
    })
    const scroll = vi.spyOn(proto, 'scrollHeight', 'get').mockImplementation(function () {
      return this.matches && this.matches('[data-test="mail-code-block"]') ? heights.scroll : 0
    })
    let changed = null
    const real = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(fn) {
        changed = fn
      }
      observe() {}
      disconnect() {}
    }
    try {
      await open(request(mainCard()))
      const allow = () => wrapper.find('[data-test="agent-command-allow"]').element.disabled
      expect(allow()).toBe(true)
      heights.client = 1200
      changed()
      await flushPromises()
      expect(allow()).toBe(false)
    } finally {
      box.mockRestore()
      scroll.mockRestore()
      globalThis.ResizeObserver = real
    }
  })

  it('an unanswered card comes back as unanswered, not as a no', async () => {
    const agent = { type: 'leaf', id: 'pane-ada', kind: 'agent', paneName: 'Ada' }
    const ws = { id: 'w1', name: 'Shop', tree: { type: 'split', children: [agent] } }
    const targets = createAgentTerminalTargets({ enabled: () => true, workspaces: () => [ws], forEachLeaf: (node, fn) => node.children.forEach(fn), paneLabel: (l) => l.paneName, hostLabel: (id) => id, approve: async () => ({ allow: false, timedOut: true }) })
    const answer = await targets.handle({ agent: 'pane-ada', op: 'approve', terminal: 'mailcode:pane-ada', ...request(mainCard()) })
    expect(answer).toMatchObject({ allow: false, timedOut: true })
    expect(app.slice(app.indexOf('async approve(c) {'), app.indexOf('const action = answer.action || null'))).toMatch(/answer\.timedOut \? \{ timedOut: true \}/)
  })

  it('says when this agent may read the same mail itself', async () => {
    await open(request({ ...mainCard(), mailReadAllowed: true }))
    expect(wrapper.find('[data-test="mail-code-mail-read"]').text()).toContain('can read this mail and its code itself')
  })

  it('is never remembered: one way to allow, once, and no other button', async () => {
    await open(request(mainCard()))
    expect(wrapper.find('[data-test="agent-command-once"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="agent-command-more"]').exists()).toBe(false)
    expect(wrapper.findAll('.confirm-actions button').map((b) => b.text())).toEqual(['Deny', 'Fill it in and submit'])
    await wrapper.find('[data-test="agent-command-allow"]').trigger('pointerdown')
    await wrapper.find('[data-test="agent-command-allow"]').trigger('click')
    expect(wrapper.emitted('answer')[0][0]).toMatchObject({ allow: true, remember: 'once', command: null, action: null })
  })

  it('shows no command, no field to edit, no folder', async () => {
    const { shown } = await open(request(mainCard()))
    expect(shown.folder !== undefined).toBe(true)
    expect(wrapper.find('[data-test="agent-command-text"]').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('.confirm-details').exists()).toBe(false)
  })

  it('an agent on an SSH host: says so', async () => {
    await open(request(mainCard(), { onHost: 'build-box' }))
    expect(wrapper.find('#aca-title').text()).toContain('on the server build-box')
    expect(wrapper.find('[data-test="mail-code-host"]').text()).toContain('build-box')
    expect(wrapper.find('[data-test="mail-code-host"]').text()).toContain('any program it started there can ask in its name')
    expect(wrapper.find('[data-test="agent-command-allow"]').classes()).toContain('danger')
  })

  it('whatever the window answers, it is a plain copy that carries nothing to remember', async () => {
    const { answer } = await throughTheWindow(request(mainCard()))
    expect(answer.allow).toBe(true)
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer)
  })

  it('"Let agents use terminals" off changes nothing for a browser tool: the card and who asks still answer', async () => {
    const { shown, targets } = await throughTheWindow(request(mainCard()), { terminalsOn: false })
    expect(shown.kind).toBe('mailCode')
    await expect(targets.handle({ agent: 'pane-ada', op: 'mailCodeInfo' })).resolves.toMatchObject({ agentLabel: 'Ada', guests: [], shared: false })
    await expect(targets.handle({ agent: 'pane-ada', op: 'appsInfo' })).rejects.toMatchObject({ code: 'disabled' })
    await expect(targets.handle({ agent: 'pane-ada', op: 'approve', terminal: 'apps:gmail', card: { kind: 'apps' } })).rejects.toMatchObject({ code: 'disabled' })
  })

  it('says who is in a shared project and who is on a host', async () => {
    const shared = vi.fn(() => true)
    const agent = { type: 'leaf', id: 'pane-ada', kind: 'agent', paneName: 'Ada', remoteHostId: 'ssh-res' }
    const ws = { id: 'w1', name: 'Shop', tree: { type: 'split', children: [agent] } }
    const targets = createAgentTerminalTargets({
      enabled: () => true,
      workspaces: () => [ws],
      forEachLeaf: (node, fn) => node.children.forEach(fn),
      paneLabel: (l) => l.paneName,
      hostLabel: () => 'build-box',
      projectShared: shared,
      projectGuests: () => [{ id: 'g1', name: 'Alex' }],
      guestWhoWrote: () => ({ id: 'g1', name: 'Alex' }),
      sharedUntilYouWrote: () => true
    })
    expect(await targets.handle({ agent: 'pane-ada', op: 'mailCodeInfo' })).toMatchObject({ shared: true, sharedBefore: true, onHost: 'build-box', guests: [{ id: 'g1', name: 'Alex' }], wroteLast: { id: 'g1', name: 'Alex' } })
  })
})

describe('its words in French', () => {
  it('has every line', () => {
    const app = fs.readFileSync(join(process.cwd(), 'src/renderer/src/components/AgentCommandApproval.vue'), 'utf8')
    for (const [, key] of app.matchAll(/t\('app\.agentTerminal\.(mailCode\w+)'/g)) expect(frApp.app.agentTerminal[key], key).toBeTruthy()
    const source = fs.readFileSync(join(process.cwd(), 'src/main/mailCode.js'), 'utf8')
    const keys = [...source.matchAll(/t\('main\.mailCode\.(\w+)'/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(15)
    for (const key of keys) expect(frMain.main.mailCode[key], key).toBeTruthy()
  })
})
