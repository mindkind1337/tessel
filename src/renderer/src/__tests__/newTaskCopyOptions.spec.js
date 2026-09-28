import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NewTaskDialog from '../components/NewTaskDialog.vue'

const props = {
  wsName: 'Proj',
  cwd: 'C:\\Proj',
  agentKinds: [{ id: 'claude', name: 'Claude Code' }],
  openAgents: [],
  isolation: { available: true }
}

describe('New task: options of its own copy', () => {
  it('sends the starting branch, .env copy and setup choice with the task', async () => {
    const w = mount(NewTaskDialog, { props })
    await w.find('#nt-title').setValue('Fix login')
    const opts = w.find('[data-test="copy-options"]')
    expect(opts.exists()).toBe(true)
    await opts.find('input.nt-branch').setValue('develop')
    const boxes = opts.findAll('input[type="checkbox"]')
    await boxes[1].setValue(true) // run the setup script
    await w.find('form').trigger('submit')
    expect(w.emitted('start')[0][0]).toMatchObject({
      isolated: true,
      worktreeOptions: { baseBranch: 'develop', copyEnv: true, runSetup: true }
    })
  })

  it('no options when it works directly in the project folder', async () => {
    const w = mount(NewTaskDialog, { props })
    await w.findAll('input[name="nt-where"]')[1].setValue(true)
    expect(w.find('[data-test="copy-options"]').exists()).toBe(false)
  })
})
