import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import AgentCommandApproval from '../components/AgentCommandApproval.vue'

describe('the approval card', () => {
  let wrapper
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })
  const open = (card) => {
    wrapper = mount(AgentCommandApproval, {
      props: { card: { kind: 'command', command: 'npm test', explanation: 'Runs the tests', goal: 'Check', own: true, agentLabel: 'Ada', name: 'Ada · terminal', where: 'this computer', disclaimers: [], actions: [], ...card }, armMs: 0 },
      attachTo: document.body
    })
    return wrapper
  }

  describe('it opened by itself and the person goes on writing', () => {
    let field
    const openBy = async (card = {}) => {
      field = document.createElement('textarea')
      document.body.append(field)
      field.focus()
      wrapper = mount(AgentCommandApproval, {
        props: { card: { kind: 'command', command: 'npm test', own: true, agentLabel: 'Ada', ...card }, armMs: 0, openedByUser: false },
        attachTo: document.body
      })
      await flushPromises()
      return wrapper.find('[data-test="agent-command-skip"]')
    }
    afterEach(() => field?.remove())

    it('a letter or an Enter puts the card away and gives the keyboard back: no answer', async () => {
      for (const key of ['a', 'Enter', ' ', '@']) {
        const skip = await openBy()
        expect(document.activeElement).toBe(skip.element)
        await skip.trigger('keydown', { key, ...(key === '@' ? { ctrlKey: true, altKey: true } : {}) })
        expect(document.activeElement).toBe(field)
        expect(wrapper.emitted('park')).toHaveLength(1)
        expect(wrapper.emitted('answer')).toBeUndefined()
        wrapper.unmount()
        wrapper = null
        field.remove()
      }
    })

    it('Tab or a click on the card says it is for the card: Enter answers then', async () => {
      const skip = await openBy()
      await skip.trigger('keydown', { key: 'Tab' })
      await skip.trigger('keydown', { key: 'Enter' })
      expect(wrapper.emitted('park')).toBeUndefined()
      wrapper.unmount()
      field.remove()
      const again = await openBy()
      await wrapper.find('[role="alertdialog"]').trigger('pointerdown')
      await again.trigger('keydown', { key: 'a' })
      expect(wrapper.emitted('park')).toBeUndefined()
    })

    it("on a Live Share guest's computer, the same: their keys stay theirs, and nothing is answered for them", async () => {
      const skip = await openBy({ kind: 'hostRun', hostName: 'Sam', project: 'Shared', command: 'dir' })
      await skip.trigger('keydown', { key: 'Enter' })
      expect(document.activeElement).toBe(field)
      expect(wrapper.emitted('park')).toHaveLength(1)
      expect(wrapper.emitted('answer')).toBeUndefined()
    })

    it('a shortcut is not writing', async () => {
      const skip = await openBy()
      await skip.trigger('keydown', { key: 'c', ctrlKey: true })
      await skip.trigger('keydown', { key: 'Shift' })
      expect(wrapper.emitted('park')).toBeUndefined()
    })

    it('a click beside the card puts it away, it does not answer', async () => {
      await openBy()
      await wrapper.find('[data-test="agent-command-approval"]').trigger('pointerdown')
      expect(wrapper.emitted('park')).toHaveLength(1)
      expect(wrapper.emitted('answer')).toBeUndefined()
    })
  })

  it('opened from the toolbar, the keyboard is for the card: a letter does nothing to it', async () => {
    open({})
    await flushPromises()
    await wrapper.find('[data-test="agent-command-skip"]').trigger('keydown', { key: 'a' })
    expect(wrapper.emitted('park')).toBeUndefined()
  })

  it('starts on Skip: an Enter typed for something else never allows', async () => {
    open({})
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-command-skip"]').element)
    expect(wrapper.text()).toContain('Runs the tests')
    expect(wrapper.text()).toContain('Check')
  })

  it('says why and from which project', async () => {
    open({ project: 'Alex Dev', explanation: 'To read the crash log' })
    expect(wrapper.find('[data-test="agent-command-project"]').text()).toContain('Alex Dev')
    expect(wrapper.find('[data-test="agent-command-why"]').text()).toContain('To read the crash log')
  })

  it('a Live Share guest in the project: said on the card, asked each time for a host', async () => {
    open({ kind: 'host', pc: true, command: '', guests: ['Alex'], fromGuest: 'Alex' })
    const said = wrapper.find('[data-test="agent-command-guest"]').text()
    expect(said).toContain('Alex')
    expect(said).toContain('your computer, not theirs')
    expect(wrapper.find('[data-test="agent-command-once"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="agent-command-allow"]').exists()).toBe(false)
  })

  it('a guest in the project who did not write last: named as who may be behind it', async () => {
    open({ guests: ['Alex', 'Ada'] })
    expect(wrapper.find('[data-test="agent-command-guest"]').text()).toContain('Alex, Ada')
  })

  it('no guest, nothing said, and a host can still be allowed for good', async () => {
    open({ kind: 'host', pc: true, command: '' })
    expect(wrapper.find('[data-test="agent-command-guest"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="agent-command-allow"]').exists()).toBe(true)
  })

  describe('a command of the host, on a guest\'s computer', () => {
    const asked = { kind: 'hostRun', hostName: 'Sam', agentLabel: 'Ada', project: 'Site', command: 'Get-Date', explanation: 'To read the log' }

    it('says who asks and what it can do, and shows the command, which cannot be edited', async () => {
      open(asked)
      expect(wrapper.find('#aca-title').text()).toContain('Ada')
      expect(wrapper.find('#aca-title').text()).toContain('Sam')
      expect(wrapper.find('[data-test="agent-host-run"]').text()).toContain('not from you')
      expect(wrapper.find('[data-test="agent-command-text"]').element.tagName).toBe('PRE')
      expect(wrapper.find('[data-test="agent-command-text"]').text()).toBe('Get-Date')
    })

    it('starts on Deny, and offers no way to allow for good', async () => {
      open(asked)
      await flushPromises()
      const deny = wrapper.find('[data-test="agent-command-skip"]')
      expect(document.activeElement).toBe(deny.element)
      expect(deny.text()).toBe('Deny')
      expect(wrapper.find('[data-test="agent-command-more"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="agent-command-once"]').exists()).toBe(false)
    })

    describe('a command that does not fit', () => {
      const stubs = []
      const stub = (name, get) => {
        const old = Object.getOwnPropertyDescriptor(Element.prototype, name) || Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
        Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get })
        stubs.push([name, old])
      }
      afterEach(() => {
        for (const [name] of stubs.splice(0)) delete HTMLElement.prototype[name]
      })
      // A box 100 px high in a card of 800, with the buttons at `buttonsTop`.
      const overflowing = async (buttonsTop = 500) => {
        stub('scrollHeight', function () {
          return this.tagName === 'PRE' ? 1000 : 0
        })
        stub('clientHeight', function () {
          return this.tagName === 'PRE' ? 100 : 0
        })
        rect = (el) => (el.tagName === 'PRE' ? { top: 100, bottom: 200 } : el.classList.contains('confirm-actions') ? { top: buttonsTop, bottom: buttonsTop + 40 } : { top: 0, bottom: 800 })
        open({ ...asked, command: Array(40).fill('line').join('\n') }, 0)
        await flushPromises()
      }
      let rect = null
      const realRect = HTMLElement.prototype.getBoundingClientRect
      beforeEach(() => {
        HTMLElement.prototype.getBoundingClientRect = function () {
          return rect ? rect(this) : realRect.call(this)
        }
      })
      afterEach(() => {
        HTMLElement.prototype.getBoundingClientRect = realRect
        rect = null
      })
      const scrollTo = async (top) => {
        const box = wrapper.find('[data-test="agent-command-text"]')
        box.element.scrollTop = top
        await box.trigger('scroll')
        await nextTick()
      }
      const stepThrough = async () => {
        for (let top = 100; top <= 900; top += 100) await scrollTo(top)
      }

      it('Allow waits until its end has been in sight, and says so', async () => {
        await overflowing()
        const allow = wrapper.find('[data-test="agent-command-allow"]')
        expect(allow.attributes('disabled')).toBeDefined()
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(true)
        await allow.trigger('click')
        expect(wrapper.emitted('answer')).toBeUndefined()
        await stepThrough()
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(false)
        await scrollTo(0)
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(false)
      })

      it('one jump to the end does not count: what was skipped was never on screen', async () => {
        await overflowing()
        await scrollTo(900)
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(true)
        expect(wrapper.find('[data-test="agent-command-allow"]').attributes('disabled')).toBeDefined()
        await scrollTo(0)
        await stepThrough()
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(false)
      })

      it('an end hidden under the buttons does not count', async () => {
        await overflowing(150)
        await stepThrough()
        expect(wrapper.find('[data-test="agent-host-scroll"]').exists()).toBe(true)
      })

      it('the box can be reached with the keyboard', async () => {
        await overflowing()
        expect(wrapper.find('[data-test="agent-command-text"]').attributes('tabindex')).toBe('0')
      })
    })

    it('each real line is its own: a break cannot pass for a wrap', () => {
      open({ ...asked, command: 'a\n\nb' })
      expect(wrapper.findAll('.aca-l')).toHaveLength(3)
    })

    it('names what is not plain ASCII', () => {
      open({ ...asked, command: 'echo \u00E9t\u00E9 \u0111' })
      const said = wrapper.find('[data-test="agent-host-characters"]').text()
      expect(said).toContain('U+00E9')
      expect(said).toContain('U+0111')
      wrapper.unmount()
      open({ ...asked, command: `echo ${'\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E6\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED'}` })
      expect(wrapper.find('[data-test="agent-host-characters"]').text()).toContain('2')
      wrapper.unmount()
      open(asked)
      expect(wrapper.find('[data-test="agent-host-characters"]').exists()).toBe(false)
    })

    it('says what it can do before the host\'s own words', () => {
      open(asked)
      const html = wrapper.html()
      expect(html.indexOf('agent-host-run')).toBeLessThan(html.indexOf('agent-command-why'))
    })

    it('opens at its top: focusing Deny does not scroll past a long command', async () => {
      const focus = vi.spyOn(HTMLElement.prototype, 'focus')
      open(asked)
      await flushPromises()
      expect(focus).toHaveBeenCalledWith({ preventScroll: true })
      focus.mockRestore()
    })

    it('can say not to ask again', async () => {
      open(asked)
      await wrapper.find('[data-test="agent-command-block"]').trigger('click')
      expect(wrapper.emitted('answer')[0]).toEqual([{ allow: false, block: true }])
    })
  })

  it('Skip and Escape answer no', async () => {
    open({})
    await wrapper.find('[data-test="agent-command-skip"]').trigger('click')
    expect(wrapper.emitted('answer')[0][0]).toEqual({ allow: false })
  })

  it('Allow runs the command as edited', async () => {
    open({})
    await wrapper.find('[data-test="agent-command-text"]').setValue('npm test -- --run')
    await wrapper.find('[data-test="agent-command-allow"]').trigger('click')
    expect(wrapper.emitted('answer')[0][0]).toMatchObject({ allow: true, command: 'npm test -- --run', action: null, remember: 'once' })
  })

  it('the menu offers VS Code\'s rules', async () => {
    open({ actions: [{ kind: 'prefix', keys: ['npm test'], scope: 'session' }, { kind: 'exact', key: '/^npm test$/', scope: 'user' }, { kind: 'session' }] })
    await wrapper.find('[data-test="agent-command-more"]').trigger('click')
    const items = wrapper.findAll('[data-test="agent-command-menu"] button')
    expect(items.map((b) => b.text())).toEqual([
      'Allow npm test … in this session',
      'Allow this exact command line always',
      'Allow all commands in this session',
      'Configure auto approve…'
    ])
    await items[0].trigger('click')
    expect(wrapper.emitted('answer')[0][0]).toMatchObject({ allow: true, action: { kind: 'prefix', keys: ['npm test'], scope: 'session' } })
  })

  it('one of the user\'s terminals: Deny, this time, or in this terminal', async () => {
    open({ kind: 'pane', own: false, name: 'fivem-afterlife', where: 'SSH resources' })
    expect(wrapper.text()).toContain('Ada wants to use the terminal "fivem-afterlife" (SSH resources)')
    await wrapper.find('[data-test="agent-command-allow"]').trigger('click')
    expect(wrapper.emitted('answer')[0][0]).toMatchObject({ allow: true, remember: 'pane' })
    await wrapper.find('[data-test="agent-command-once"]').trigger('click')
    expect(wrapper.emitted('answer')[1][0]).toMatchObject({ allow: true, remember: 'once' })
  })
})

describe('security review: the read card', () => {
  it('asks to read a terminal: Deny, this time, or this terminal', async () => {
    const w = mount(AgentCommandApproval, { props: { card: { kind: 'read', command: '', own: false, agentLabel: 'Ada', name: 'srv', where: 'this computer', disclaimers: [], actions: [] }, armMs: 0 }, attachTo: document.body })
    expect(w.text()).toContain('Ada wants to read the terminal "srv" (this computer)')
    expect(w.find('[data-test="agent-command-text"]').exists()).toBe(false)
    await w.find('[data-test="agent-command-allow"]').trigger('click')
    expect(w.emitted('answer')[0][0]).toMatchObject({ allow: true, remember: 'pane' })
    w.unmount()
  })
})

describe('security review: the whole command is seen', () => {
  it('the field grows with the command and says how many lines it has', () => {
    const cmd = Array(8).fill('echo x').join('\n')
    const w = mount(AgentCommandApproval, { props: { card: { kind: 'command', command: cmd, own: true, agentLabel: 'Ada', name: 'n', where: 'w', disclaimers: [], actions: [] } }, attachTo: document.body })
    expect(Number(w.find('[data-test="agent-command-text"]').attributes('rows'))).toBeGreaterThanOrEqual(8)
    expect(w.find('[data-test="agent-command-lines"]').text()).toContain('8 lines')
    w.unmount()
  })
})

describe('security review: a click meant for something else never allows', () => {
  it('Allow is armed only a moment after the card shows, and again after the window comes back', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(AgentCommandApproval, { props: { card: { kind: 'command', command: 'npm test', own: true, agentLabel: 'Ada', name: 'n', where: 'w', disclaimers: [], actions: [] } }, attachTo: document.body })
      const allow = () => w.find('[data-test="agent-command-allow"]')
      await nextTick()
      expect(allow().attributes('disabled')).toBeDefined()
      await allow().trigger('click')
      expect(w.emitted('answer')).toBeUndefined()
      vi.advanceTimersByTime(800)
      await nextTick()
      expect(allow().attributes('disabled')).toBeUndefined()
      window.dispatchEvent(new Event('focus'))
      await nextTick()
      expect(allow().attributes('disabled')).toBeDefined()
      vi.advanceTimersByTime(800)
      await nextTick()
      // A mouse click counts only when pressed on the button itself.
      allow().element.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
      await nextTick()
      expect(w.emitted('answer')).toBeUndefined()
      await allow().trigger('pointerdown')
      allow().element.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
      await nextTick()
      expect(w.emitted('answer')[0][0]).toMatchObject({ allow: true })
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
