import { describe, it, expect, afterEach } from 'vitest'
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
      props: { card: { kind: 'command', command: 'npm test', explanation: 'Runs the tests', goal: 'Check', own: true, agentLabel: 'Ada', name: 'Ada · terminal', where: 'this computer', disclaimers: [], actions: [], ...card } },
      attachTo: document.body
    })
    return wrapper
  }

  it('starts on Skip: an Enter typed for something else never allows', async () => {
    open({})
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.find('[data-test="agent-command-skip"]').element)
    expect(wrapper.text()).toContain('Runs the tests')
    expect(wrapper.text()).toContain('Check')
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
    const w = mount(AgentCommandApproval, { props: { card: { kind: 'read', command: '', own: false, agentLabel: 'Ada', name: 'srv', where: 'this computer', disclaimers: [], actions: [] } }, attachTo: document.body })
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
