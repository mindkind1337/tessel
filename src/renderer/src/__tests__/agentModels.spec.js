import { setSelectValue, selectOptions } from './selectTestUtils'
// Orca's model per agent in the interface: Settings > Agents defaults, the
// new pane menu's model pill, the picker, and the Claude /model switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsDialog from '../components/SettingsDialog.vue'
import LaunchMenu from '../components/LaunchMenu.vue'
import SessionOptionPicker from '../components/SessionOptionPicker.vue'
import { settings, resetSettings, loadSettings } from '../settings'
import { modelLists, modelsFor, refreshModels, loadModelLists, resetModelListsForTests, refreshIfStale, MODEL_LIST_MAX_AGE_MS } from '../agentModels'
import { createClaudeModelSwitchObserver, hasClaudeModelSwitchConfirmation, hasClaudeModelSwitchSuccess } from '../claudeModelSwitch'
import { sessionPillLabel } from '../sessionOptionLabels'
import { setMessages } from '../i18n'

const agents = [
  { id: 'claude', name: 'Claude Code', command: 'claude', available: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', available: true },
  { id: 'aider', name: 'Aider', command: 'aider', available: true }
]

describe('additional agent catalogs in Settings', () => {
  it('offers all six catalogs, refreshes only discovery agents and saves Pi thinking', async () => {
    const previousApi = window.shellApi
    resetSettings()
    resetModelListsForTests()
    const ids = ['pi', 'cursor', 'antigravity', 'amp', 'kimi', 'copilot']
    window.shellApi = {
      openExternal() {},
      probeAgentModels: vi.fn(async ({ agent }) => ({
        ok: true, fetchedAt: Date.now(), models: [{ id: `${agent}/sample`, label: 'Sample', effortLevels: ['off', 'high'] }]
      }))
    }
    const w = mount(SettingsDialog, { props: { agents: ids.map((id) => ({ id, name: id, command: id, available: true })) } })
    try {
      for (const id of ids) {
        expect(w.find(`[data-test="agent-model-${id}"]`).exists()).toBe(true)
        expect(w.find(`[data-test="agent-models-refresh-${id}"]`).exists()).toBe(['pi', 'cursor', 'antigravity'].includes(id))
      }
      await w.get('[data-test="agent-models-refresh-pi"]').trigger('click')
      await flushPromises()
      await setSelectValue(w.get('[data-test="agent-model-pi"]'), 'pi/sample')
      const effort = w.get('[data-test="agent-option-pi-effort"]')
      expect((await selectOptions(effort)).map((o) => o.attributes('data-value'))).toEqual(['', 'off', 'high'])
      await setSelectValue(effort, 'off')
      expect(settings.agentSessionOptions.pi.valuesByModel['pi/sample']).toEqual({ effort: 'off' })
      await setSelectValue(w.get('[data-test="agent-model-kimi"]'), 'kimi-code/kimi-for-coding')
      expect(w.find('[data-test="agent-option-kimi-effort"]').exists()).toBe(false)
      await setSelectValue(w.get('[data-test="agent-model-amp"]'), 'deep')
      expect(w.find('[data-test="agent-option-amp-effort"]').exists()).toBe(true)
      await setSelectValue(w.get('[data-test="agent-model-amp"]'), 'smart')
      expect(w.find('[data-test="agent-option-amp-effort"]').exists()).toBe(false)
    } finally {
      w.unmount()
      window.shellApi = previousApi
      resetSettings()
      resetModelListsForTests()
    }
  })
})

describe('Settings > Agents: default model and effort', () => {
  let wrapper, previousApi, probes
  beforeEach(() => {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    probes = []
    previousApi = window.shellApi
    window.shellApi = {
      openExternal() {},
      probeAgentModels: vi.fn(async (q) => {
        probes.push(q)
        return q.agent === 'claude'
          ? { ok: true, fetchedAt: Date.UTC(2026, 8, 28), models: [{ id: 'opus[1m]', label: 'Opus (1M context)', effortLevels: ['low', 'max'] }] }
          : { ok: false, reason: 'failed', detail: '1: not signed in' }
      })
    }
    wrapper = mount(SettingsDialog, { props: { agents }, attachTo: document.body })
  })
  afterEach(() => {
    wrapper.unmount()
    resetSettings()
    settings.agentSessionOptions = {}
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    window.shellApi = previousApi
  })

  const select = (id) => wrapper.get(`[data-test="${id}"]`)

  it('lists the catalog; nothing chosen = the agent default, no values saved', async () => {
    expect(wrapper.find('[data-test="agent-models-aider"]').exists()).toBe(false)
    const opts = (await selectOptions(select('agent-model-claude')))
    expect(opts.map((o) => o.text())).toEqual(["Agent's own default", 'Fable', 'Opus', 'Sonnet', 'Haiku'])
    expect(select('agent-model-claude').element.value).toBe('')
    expect(wrapper.find('[data-test="agent-option-claude-effort"]').exists()).toBe(false)
    expect(settings.agentSessionOptions).toEqual({})
  })

  it('choosing a model, then its effort, saves them; back to the default drops the model', async () => {
    await setSelectValue(select('agent-model-claude'), 'opus')
    expect(settings.agentSessionOptions.claude.model).toBe('opus')
    const effort = select('agent-option-claude-effort')
    expect((await selectOptions(effort)).map((o) => o.text())).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max'])
    await setSelectValue(effort, 'max')
    expect(settings.agentSessionOptions.claude.valuesByModel.opus).toEqual({ effort: 'max' })
    // Fast mode is a running session's toggle (Orca): said, not offered here.
    expect(wrapper.get('[data-test="agent-models-status-claude"]').text()).toContain('Fast mode is switched in a running pane')
    await setSelectValue(effort, '')
    expect(settings.agentSessionOptions.claude.valuesByModel.opus).toEqual({})
    await setSelectValue(select('agent-model-claude'), '')
    expect(settings.agentSessionOptions.claude.model).toBeUndefined()
    // Codex: its reasoning effort.
    await setSelectValue(select('agent-model-codex'), 'gpt-5.5')
    expect((await selectOptions(select('agent-option-codex-effort'))).map((o) => o.attributes('data-value'))).toEqual(['', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('Refresh models asks the CLI (only then) and lists what it answered; a failure is explained', async () => {
    expect(probes).toEqual([])
    expect(wrapper.get('[data-test="agent-models-status-claude"]').text()).toContain('Built-in list')
    await wrapper.get('[data-test="agent-models-refresh-claude"]').trigger('click')
    await flushPromises()
    expect(probes).toEqual([{ agent: 'claude', command: '' }])
    expect((await selectOptions(select('agent-model-claude'))).map((o) => o.text())).toEqual(["Agent's own default", 'Opus (1M context)'])
    expect(wrapper.get('[data-test="agent-models-status-claude"]').text()).toMatch(/1 models listed by Claude Code/)
    await wrapper.get('[data-test="agent-models-refresh-codex"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="agent-models-status-codex"]').text()).toContain('Codex CLI could not list its models: 1: not signed in')
  })

  it('saved settings are checked on load', () => {
    loadSettings({ agentSessionOptions: { claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }, codex: { model: 'a b' } } })
    expect(settings.agentSessionOptions).toEqual({ claude: { model: 'opus', valuesByModel: { opus: { effort: 'high' } } }, codex: { valuesByModel: {} } })
  })
})

describe('the model lists', () => {
  afterEach(() => resetModelListsForTests())
  it('the kept lists load at start without probing', async () => {
    const prev = window.shellApi
    const probe = vi.fn()
    window.shellApi = { agentModelLists: async () => ({ codex: { models: [{ id: 'gpt-7', label: 'GPT-7' }], fetchedAt: 5 } }), probeAgentModels: probe }
    await loadModelLists()
    expect(modelLists.codex.models[0].id).toBe('gpt-7')
    expect(modelsFor('codex').map((m) => m.id)).toContain('gpt-7')
    expect(probe).not.toHaveBeenCalled()
    expect((await refreshModels('aider')).reason).toBe('unsupported')
    window.shellApi = prev
  })
})

describe('a model menu that opens refreshes a missing or old list', () => {
  let prev
  beforeEach(() => {
    resetModelListsForTests()
    prev = window.shellApi
  })
  afterEach(() => {
    resetModelListsForTests()
    window.shellApi = prev
  })

  it('missing: one background probe, and its models are listed', async () => {
    const probe = vi.fn(async () => ({ ok: true, fetchedAt: Date.now(), models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }] }))
    window.shellApi = { agentModelLists: async () => ({}), probeAgentModels: probe }
    refreshIfStale('codex')
    refreshIfStale('codex')
    await flushPromises()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(modelsFor('codex').map((m) => m.id)).toContain('gpt-6-astra')
  })

  it('fresh: no probe; a day old: probed again', async () => {
    const probe = vi.fn(async () => ({ ok: true, fetchedAt: Date.now(), models: [{ id: 'gpt-7', label: 'GPT-7' }] }))
    window.shellApi = { agentModelLists: async () => ({ codex: { models: [{ id: 'gpt-6', label: 'GPT-6' }], fetchedAt: Date.now() } }), probeAgentModels: probe }
    await loadModelLists()
    refreshIfStale('codex')
    await flushPromises()
    expect(probe).not.toHaveBeenCalled()
    modelLists.codex.fetchedAt = Date.now() - MODEL_LIST_MAX_AGE_MS - 1
    refreshIfStale('codex')
    await flushPromises()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a failure waits 30 s before the next try; an agent without a probe is left alone', async () => {
    const probe = vi.fn(async () => ({ ok: false, reason: 'failed' }))
    window.shellApi = { agentModelLists: async () => ({}), probeAgentModels: probe }
    refreshIfStale('codex')
    await flushPromises()
    refreshIfStale('codex')
    await flushPromises()
    expect(probe).toHaveBeenCalledTimes(1)
    refreshIfStale('aider')
    await flushPromises()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('the picker', () => {
  it("a running Claude: /fast is an action, never On/Off; Codex's model opens its own picker", async () => {
    const w = mount(SessionOptionPicker, { props: { agentId: 'claude', models: modelsFor('claude'), values: { model: 'opus' }, live: true } })
    expect(w.get('[data-test="sop-toggle"]').text()).toBe('Toggle fast mode')
    await w.get('[data-test="sop-toggle"]').trigger('click')
    expect(w.emitted('action')[0][0]).toEqual({ optionId: 'fastMode' })
    // Before it starts: no fast mode (no launch flag for it).
    await w.setProps({ live: false })
    expect(w.find('[data-test="sop-toggle"]').exists()).toBe(false)
    const c = mount(SessionOptionPicker, { props: { agentId: 'codex', models: modelsFor('codex'), values: null, live: true } })
    await c.get('[data-test="sop-agent-picker"]').trigger('click')
    expect(c.emitted('action')[0][0]).toEqual({ optionId: 'model' })
    // While it works: nothing can be picked.
    await c.setProps({ disabledReason: 'busy' })
    await c.get('[data-model="gpt-5.5"]').trigger('click')
    expect(c.emitted('set')).toBeUndefined()
  })

  it('French words from the catalog', () => {
    setMessages('fr', { pane: { sessionOptions: { value: { xhigh: 'Extra élevé' }, model: 'Modèle' } } })
    expect(sessionPillLabel(modelsFor('claude'), { model: 'opus', effort: 'xhigh' })).toBe('Opus · Extra élevé')
    expect(sessionPillLabel([], null)).toBe('Modèle')
    setMessages('en', {})
  })
})

describe("Claude's /model confirmation (Orca's observer)", () => {
  const ESC = String.fromCharCode(27)
  it('reads the words Claude spaces with cursor moves', () => {
    expect(hasClaudeModelSwitchConfirmation(`Switch${ESC}[2Cmodel?${ESC}[1C This conversation is cached for the current model`)).toBe(true)
    expect(hasClaudeModelSwitchSuccess('Set model to Opus 5 (1M context)', 'Opus (1M context)')).toBe(true)
    expect(hasClaudeModelSwitchSuccess('Set model to Sonnet 5', 'Opus')).toBe(false)
  })

  it('answers the "Switch model?" question with Enter, then sees it applied', async () => {
    let watcher
    const submit = vi.fn(() => true)
    const o = createClaudeModelSwitchObserver({ expectedModelLabel: 'Opus', subscribe: (w) => ((watcher = w), () => {}), submit, timeoutMs: 1000 })
    watcher('Switch model? This conversation is cached for the current model') // before arm: ignored
    expect(submit).not.toHaveBeenCalled()
    o.arm()
    o.startDetection()
    watcher('Switch model?\r\n  This conversation is cached for the current model')
    expect(submit).toHaveBeenCalledTimes(1)
    watcher('⎿  Set model to Opus 5.5')
    expect(await o.result).toBe('applied')
  })

  it('"Kept model as" is a no; silence is unknown', async () => {
    let watcher
    const o = createClaudeModelSwitchObserver({ expectedModelLabel: 'Opus', subscribe: (w) => ((watcher = w), () => {}), submit: () => true, timeoutMs: 1000 })
    o.arm()
    watcher('Kept model as Sonnet')
    expect(await o.result).toBe('rejected')
    const silent = createClaudeModelSwitchObserver({ expectedModelLabel: 'Opus', subscribe: () => () => {}, submit: () => true, timeoutMs: 5 })
    silent.arm()
    silent.startDetection()
    expect(await silent.result).toBe('unknown')
  })
})

describe('OpenCode: models from `opencode models`', () => {
  let prev
  beforeEach(() => {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    prev = window.shellApi
  })
  afterEach(() => {
    resetSettings()
    settings.agentSessionOptions = {}
    resetModelListsForTests()
    window.shellApi = prev
  })
  const listed = [
    { id: 'opencode/big-pickle', label: 'Opencode Big Pickle' },
    { id: 'opencode/nemotron-3-ultra-free', label: 'Opencode Nemotron 3 Ultra Free' }
  ]

  it('opening its model menu asks the CLI once; the picker lists them, no effort', async () => {
    const probe = vi.fn(async () => ({ ok: true, fetchedAt: Date.now(), models: listed }))
    window.shellApi = { agentModelLists: async () => ({}), probeAgentModels: probe }
    expect(modelsFor('opencode')).toEqual([])
    const w = mount(SessionOptionPicker, { props: { agentId: 'opencode', models: [], values: null, defaultLabel: "Agent's own default" } })
    await flushPromises()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls[0][0]).toEqual({ agent: 'opencode', command: '' })
    await w.setProps({ models: modelsFor('opencode'), values: { model: 'opencode/big-pickle' } })
    expect(w.findAll('[data-test="sop-model"]').map((b) => b.attributes('data-model'))).toEqual(['opencode/big-pickle', 'opencode/nemotron-3-ultra-free'])
    expect(w.find('[data-option="effort"]').exists()).toBe(false)
    expect(w.find('[data-test="sop-agent-picker"]').exists()).toBe(false)
    await w.get('[data-model="opencode/nemotron-3-ultra-free"]').trigger('click')
    expect(w.emitted('set')[0][0]).toEqual({ optionId: 'model', value: 'opencode/nemotron-3-ultra-free' })
    w.unmount()
  })

  it('a running OpenCode changes model in its own /models picker', async () => {
    window.shellApi = { agentModelLists: async () => ({ opencode: { models: listed, fetchedAt: Date.now() } }), probeAgentModels: vi.fn() }
    await loadModelLists()
    const w = mount(SessionOptionPicker, { props: { agentId: 'opencode', models: modelsFor('opencode'), values: null, live: true } })
    await w.get('[data-test="sop-agent-picker"]').trigger('click')
    expect(w.emitted('action')[0][0]).toEqual({ optionId: 'model' })
    expect(window.shellApi.probeAgentModels).not.toHaveBeenCalled()
    w.unmount()
  })

  it('Settings > Agents: no built-in list, Refresh models is offered', async () => {
    window.shellApi = { openExternal() {}, probeAgentModels: vi.fn(async () => ({ ok: true, fetchedAt: Date.now(), models: listed })) }
    const w = mount(SettingsDialog, { props: { agents: [{ id: 'opencode', name: 'OpenCode', command: 'opencode', available: true }] }, attachTo: document.body })
    expect(w.get('[data-test="agent-models-status-opencode"]').text()).toContain('No list yet')
    await w.get('[data-test="agent-models-refresh-opencode"]').trigger('click')
    await flushPromises()
    expect((await selectOptions(w.get('[data-test="agent-model-opencode"]'))).map((o) => o.attributes('data-value'))).toEqual(['', 'opencode/big-pickle', 'opencode/nemotron-3-ultra-free'])
    w.unmount()
  })
})

describe('the model the agent reports by its full id', () => {
  it('is the listed row with that name, never a second row with the raw id', () => {
    const models = [
      { id: 'opus', label: 'Opus 5.5', options: [] },
      { id: 'fable', label: 'Fable 5.1', options: [] }
    ]
    const w = mount(SessionOptionPicker, { props: { agentId: 'claude', models, values: { model: 'claude-fable-5-1' } } })
    const rows = w.findAll('[data-test="sop-model"]')
    expect(rows.map((r) => r.attributes('data-model'))).toEqual(['opus', 'fable'])
    expect(w.get('[data-model="fable"]').attributes('aria-checked')).toBe('true')
    w.unmount()
    // A model the list does not have: one extra row, named, not its raw id.
    const x = mount(SessionOptionPicker, { props: { agentId: 'claude', models, values: { model: 'claude-sonnet-4-6' } } })
    expect(x.findAll('[data-test="sop-model"]').at(-1).text()).toContain('Sonnet 4.6')
    x.unmount()
  })
})
