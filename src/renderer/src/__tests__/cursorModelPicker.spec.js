// Cursor's grouped model list in the pickers: the pane menu
// (SessionOptionPicker), the chat composer's snapshot and Settings > Agents
// show one row per base model, with the variant in use selected as its row
// plus its effort / Fast / Thinking.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import fs from 'fs'
import path from 'path'
import SessionOptionPicker from '../components/SessionOptionPicker.vue'
import SettingsDialog from '../components/SettingsDialog.vue'
import { tesselSessionOptionSnapshot } from '../components/chat/orca/native-chat-session-option-pickers.js'
import { modelLists, modelsFor, resetModelListsForTests } from '../agentModels'
import { settings, resetSettings } from '../settings'
import { parseCursorModelList } from '../../../shared/agentModelProbe'
import { sessionChoiceLabel } from '../sessionOptionLabels'
import { setMessages } from '../i18n'
import { selectOptions, setSelectValue } from './selectTestUtils'
import { sessionChoiceError } from '../cliRequests'

const listed = parseCursorModelList(fs.readFileSync(path.join(__dirname, '../../../shared/__tests__/fixtures/cursor-list-models.txt'), 'utf8'))

beforeEach(() => {
  resetModelListsForTests()
  modelLists.cursor = { models: listed, fetchedAt: Date.now() }
})
afterEach(() => resetModelListsForTests())

describe('the pane menu with Cursor', () => {
  it('lists one row per model, not one per variant', () => {
    const w = mount(SessionOptionPicker, { props: { agentId: 'cursor', models: modelsFor('cursor'), values: null } })
    const ids = w.findAll('[data-test="sop-model"]').map((b) => b.attributes('data-model'))
    expect(ids).toHaveLength(39)
    expect(ids.slice(0, 4)).toEqual(['auto', 'gpt-5.3-codex', 'gpt-5.2', 'composer-2.5'])
    expect(ids).not.toContain('gpt-5.3-codex-high-fast')
    w.unmount()
  })

  it('a variant id in use shows its row selected with High and Fast set, never a raw row', () => {
    const w = mount(SessionOptionPicker, { props: { agentId: 'cursor', models: modelsFor('cursor'), values: { model: 'gpt-5.3-codex-high-fast' } } })
    expect(w.findAll('[data-test="sop-model"]')).toHaveLength(39)
    expect(w.get('[data-model="gpt-5.3-codex"]').attributes('aria-checked')).toBe('true')
    expect(w.get('[data-test="sop-option"][data-option="effort"][data-value="high"]').attributes('aria-checked')).toBe('true')
    expect(w.findAll('[data-test="sop-option"][data-option="effort"]').map((b) => b.attributes('data-value'))).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(w.get('input[data-option="fastMode"]').element.checked).toBe(true)
    expect(w.find('input[data-option="thinking"]').exists()).toBe(false)
    w.unmount()
  })

  it("Thinking is a switch where the model has both; a choice is sent as the row's option", async () => {
    const w = mount(SessionOptionPicker, { props: { agentId: 'cursor', models: modelsFor('cursor'), values: { model: 'claude-opus-5-thinking-max-fast' } } })
    expect(w.get('[data-model="claude-opus-5"]').attributes('aria-checked')).toBe('true')
    expect(w.get('[data-test="sop-option"][data-option="effort"][data-value="max"]').attributes('aria-checked')).toBe('true')
    expect(w.get('input[data-option="thinking"]').element.checked).toBe(true)
    expect(w.get('input[data-option="fastMode"]').element.checked).toBe(true)
    await w.get('[data-test="sop-option"][data-option="effort"][data-value="low"]').trigger('click')
    expect(w.emitted('set')[0][0]).toEqual({ optionId: 'effort', value: 'low' })
    w.unmount()
  })
})

describe('the chat composer with Cursor', () => {
  it('a reported variant id is its row, with its effort', () => {
    const [model, effort] = tesselSessionOptionSnapshot({ agent: 'cursor', models: modelsFor('cursor'), values: { model: 'gpt-5.6-sol-xhigh-fast' }, permissionModes: false })
    expect(model.kind.currentValue).toBe('gpt-5.6-sol')
    expect(model.kind.choices).toHaveLength(39)
    expect(model.kind.choices.some((c) => c.value === 'gpt-5.6-sol-xhigh-fast')).toBe(false)
    expect(effort.kind.currentValue).toBe('xhigh')
    expect(effort.kind.choices.map((c) => c.value)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('Settings > Agents with Cursor', () => {
  let previousApi
  beforeEach(() => {
    resetSettings()
    previousApi = window.shellApi
    window.shellApi = { openExternal() {}, agentModelLists: async () => ({}) }
  })
  afterEach(() => {
    window.shellApi = previousApi
    resetSettings()
  })

  it('a default saved as a variant id shows its row and options; a change keeps them on the row', async () => {
    settings.agentSessionOptions = { cursor: { model: 'gpt-5.3-codex-high-fast', valuesByModel: {} } }
    const w = mount(SettingsDialog, { props: { agents: [{ id: 'cursor', name: 'Cursor', command: 'cursor-agent', available: true }] } })
    try {
      await flushPromises()
      const modelSelect = w.get('[data-test="agent-model-cursor"]')
      const rows = await selectOptions(modelSelect)
      expect(rows).toHaveLength(40) // the agent's own default and 39 models
      expect(rows.find((o) => o.attributes('aria-selected') === 'true').attributes('data-value')).toBe('gpt-5.3-codex')
      const effort = w.get('[data-test="agent-option-cursor-effort"]')
      expect((await selectOptions(effort)).find((o) => o.attributes('aria-selected') === 'true').attributes('data-value')).toBe('high')
      expect(w.get('[data-test="agent-option-cursor-fastMode"]').element.checked).toBe(true)
      await setSelectValue(effort, 'xhigh')
      expect(settings.agentSessionOptions.cursor.model).toBe('gpt-5.3-codex')
      expect(settings.agentSessionOptions.cursor.valuesByModel['gpt-5.3-codex']).toEqual({ effort: 'xhigh', fastMode: true })
    } finally {
      w.unmount()
    }
  })
})

describe('a model asked from the command line', () => {
  it('takes a row or an exact listed variant id, never an unlisted one', () => {
    const models = modelsFor('cursor')
    expect(sessionChoiceError('cursor', 'gpt-5.3-codex-high-fast', null, models)).toBeNull()
    expect(sessionChoiceError('cursor', 'gpt-5.3-codex', 'xhigh', models)).toBeNull()
    expect(sessionChoiceError('cursor', 'gpt-5.3-codex-ultra', null, models)).toMatch(/Unknown model/)
  })
})

describe('effort words', () => {
  it('None in English and French', () => {
    expect(sessionChoiceLabel({ value: 'none' })).toBe('None')
    setMessages('fr', { pane: { sessionOptions: { value: { none: 'Aucune' } } } })
    expect(sessionChoiceLabel({ value: 'none' })).toBe('Aucune')
    setMessages('en', {})
  })
})
