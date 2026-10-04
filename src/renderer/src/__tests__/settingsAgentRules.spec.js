// Settings > Agents > Detection rules: the status of the rules in use and
// "Open rules file".
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import { resetSettings } from '../settings'
import { applyAgentStateRules } from '../agentStateRules'
import { setUiLanguage } from '../i18n'

describe('Settings > Agents > Detection rules', () => {
  let wrapper, previousApi, opens

  beforeEach(() => {
    resetSettings()
    opens = 0
    previousApi = window.shellApi
    window.shellApi = {
      agentRules: {
        open: async () => {
          opens++
          return opens > 1 ? { ok: false, error: 'No app is associated with .json' } : { ok: true, file: 'x' }
        }
      }
    }
    wrapper = mount(SettingsDialog, { props: { agents: [], section: 'agents' }, attachTo: document.body })
  })

  afterEach(() => {
    wrapper?.unmount()
    applyAgentStateRules({ state: 'builtin' })
    resetSettings()
    window.shellApi = previousApi
  })

  const status = () => wrapper.get('[data-test="agent-rules-status"]')

  it('shows built-in, override active or invalid with its reason, live', async () => {
    expect(status().text()).toContain('Built-in rules')
    applyAgentStateRules({ state: 'override', size: 3, override: { engineVersion: 1, agents: {} } })
    await flushPromises()
    expect(status().text()).toContain('Your rules file is in use (3 change(s)')
    applyAgentStateRules({ state: 'invalid', reason: 'agents.robot: "robot" is not an agent Tessel knows' })
    await flushPromises()
    expect(status().text()).toContain('ignored')
    expect(status().text()).toContain('"robot" is not an agent')
    expect(status().classes()).toContain('set-error')
  })

  // The main process sends the reason as a code: said here in the
  // interface's language, the parser's own words kept as they are.
  it('says why the file is ignored in French, from its code', async () => {
    await setUiLanguage('fr')
    try {
      applyAgentStateRules({
        state: 'invalid',
        reason: 'agents.claude.rules[0]: regex repeats a group that can match in more than one way',
        problem: { code: 'unsafeRegex', at: 'agents.claude.rules[0]', why: 'repeatedGroup' }
      })
      await flushPromises()
      expect(status().text()).toContain('agents.claude.rules[0] : la regex répète un groupe')
      expect(status().text()).not.toContain('repeats a group')
      applyAgentStateRules({ state: 'invalid', reason: 'not valid JSON: Unexpected end', problem: { code: 'badJson', detail: 'Unexpected end of JSON input' } })
      await flushPromises()
      expect(status().text()).toContain('JSON non valide : Unexpected end of JSON input')
      expect(status().text()).not.toContain('not valid JSON')
    } finally {
      await setUiLanguage('en')
    }
  })

  // "Open rules file" creates the commented example, which changes nothing:
  // it is not "in use (0 change(s))".
  it('says a rules file with no change keeps the built-in rules', async () => {
    applyAgentStateRules({ state: 'override', size: 0, override: { engineVersion: 1, agents: {} } })
    await flushPromises()
    expect(status().text()).not.toContain('0 change')
    expect(status().text()).toContain('changes nothing yet')
  })

  it('Open rules file asks the main process, and says when it could not', async () => {
    await wrapper.get('[data-test="agent-rules-open"]').trigger('click')
    await flushPromises()
    expect(opens).toBe(1)
    expect(wrapper.find('[data-test="agent-rules"]').text()).not.toContain('No app')
    await wrapper.get('[data-test="agent-rules-open"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="agent-rules"]').text()).toContain('No app is associated with .json')
  })
})
