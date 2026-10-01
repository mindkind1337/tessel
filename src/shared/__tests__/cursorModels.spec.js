// Cursor's model list grouped into one row per base model (cursorModels.js),
// on the real `cursor-agent --list-models` output (fixtures/cursor-list-models.txt).
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseCursorModelList, listedToCatalogModels } from '../agentModelProbe'
import { parseCursorModelId, groupCursorModels, composeCursorModel, decomposeCursorModel, cursorPickerFilter, cursorModelFromStatusLine, cursorModelOnScreen, cursorPickerShown } from '../cursorModels'
import { catalogModelsFor, sessionOptionLaunchText, composedModelId, listedModelValues, valuesOnListedRow, getAgentSessionOptionCatalog } from '../agentSessionOptions'

const output = fs.readFileSync(path.join(__dirname, 'fixtures', 'cursor-list-models.txt'), 'utf8')
const rows = parseCursorModelList(output)
const grouped = groupCursorModels(rows)
const models = catalogModelsFor('cursor', listedToCatalogModels('cursor', rows))
const row = (id) => models.find((m) => m.id === id)
const optionIds = (id) => row(id).options.map((o) => o.id)
const efforts = (id) => row(id).options.find((o) => o.id === 'effort').kind.choices.map((c) => c.value)

describe("Cursor's model list, grouped", () => {
  it('reads every listed id; "Auto (current, default)" is the default row named Auto', () => {
    expect(rows).toHaveLength(246)
    expect(rows[0]).toEqual({ id: 'auto', label: 'Auto', isDefault: true })
  })

  it('spells ids by the rules of the list', () => {
    expect(parseCursorModelId('gpt-5.3-codex-low-fast')).toEqual({ base: 'gpt-5.3-codex', effort: 'low', fast: true, thinking: false })
    expect(parseCursorModelId('claude-opus-5-thinking-high-fast')).toEqual({ base: 'claude-opus-5', effort: 'high', fast: true, thinking: true })
    expect(parseCursorModelId('claude-4.6-opus-max-thinking')).toEqual({ base: 'claude-4.6-opus', effort: 'max', fast: false, thinking: true })
    expect(parseCursorModelId('claude-4.5-sonnet-thinking')).toEqual({ base: 'claude-4.5-sonnet', effort: '', fast: false, thinking: true })
    expect(parseCursorModelId('gpt-5.5-extra-high-fast')).toEqual({ base: 'gpt-5.5', effort: 'xhigh', fast: true, thinking: false })
    expect(parseCursorModelId('composer-2.5-fast')).toEqual({ base: 'composer-2.5', effort: '', fast: true, thinking: false })
    expect(parseCursorModelId('kimi-k2.7-code').base).toBe('kimi-k2.7-code')
  })

  it('becomes 39 rows, auto first and the default', () => {
    expect(grouped).toHaveLength(39)
    expect(models).toHaveLength(39)
    expect(models[0]).toMatchObject({ id: 'auto', label: 'Auto', isDefault: true, options: [] })
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(['auto'])
  })

  it('every listed id round-trips: decompose, then compose gives the same id', () => {
    for (const r of rows) {
      const values = listedModelValues(models, r.id)
      expect(values, r.id).not.toBeNull()
      expect(composedModelId('cursor', values, models), r.id).toBe(r.id)
      const d = decomposeCursorModel(grouped, r.id)
      expect(composeCursorModel(grouped.find((m) => m.id === d.model), d)).toBe(r.id)
    }
  })

  it('never composes an id Cursor did not list, whatever the choice', () => {
    const listed = new Set(rows.map((r) => r.id))
    for (const m of models) {
      for (const effort of [undefined, 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        for (const fastMode of [undefined, true, false])
          for (const thinking of [undefined, true, false]) {
            const id = composeCursorModel(m, { effort, fastMode, thinking })
            expect(listed.has(id), `${m.id} ${effort} ${fastMode} ${thinking} -> ${id}`).toBe(true)
          }
    }
  })

  it('names a row without effort, Fast or Thinking words, keeping 1M and (NO ZDR)', () => {
    expect(row('gpt-5.3-codex').label).toBe('Codex 5.3')
    expect(row('grok-4.7').label).toBe('Grok 4.7')
    expect(row('claude-opus-5').label).toBe('Claude Opus 5 1M')
    expect(row('claude-fable-5').label).toBe('Claude Fable 5 1M (NO ZDR)')
    expect(row('gpt-5.5').label).toBe('GPT-5.5 1M')
    expect(row('claude-4.5-sonnet').label).toBe('Claude Sonnet 4.5')
    expect(models.every((m) => !/​|\s{2}|Fast$|Thinking/.test(m.label))).toBe(true)
  })

  it('offers only the efforts, Fast and Thinking each model has', () => {
    expect(optionIds('gpt-5.3-codex')).toEqual(['effort', 'fastMode'])
    expect(efforts('gpt-5.3-codex')).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(optionIds('claude-opus-5')).toEqual(['effort', 'fastMode', 'thinking'])
    expect(efforts('claude-opus-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(optionIds('claude-fable-5-1')).toEqual(['effort', 'thinking'])
    expect(efforts('gpt-5.6-sol')).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(efforts('kimi-k3')).toEqual(['low', 'high', 'max'])
    expect(optionIds('composer-2.5')).toEqual(['fastMode'])
    expect(optionIds('claude-4.6-sonnet')).toEqual(['thinking'])
    expect(optionIds('claude-4-sonnet')).toEqual(['thinking'])
    for (const plain of ['auto', 'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash', 'gpt-5-mini', 'kimi-k2.7-code']) expect(row(plain).options).toEqual([])
  })

  it("defaults to the model's own setting (the label without an effort word), else the middle one", () => {
    const def = (id) => row(id).options.find((o) => o.id === 'effort').kind.defaultValue
    expect(def('gpt-5.3-codex')).toBe('medium') // the id without a suffix
    expect(def('claude-opus-5')).toBe('high') // "Claude Opus 5 1M" is -high
    expect(def('claude-opus-4-7')).toBe('xhigh')
    expect(def('kimi-k3')).toBe('max')
    expect(def('grok-4.7')).toBe('medium') // every label says its effort: the middle one
    expect(composeCursorModel(row('claude-opus-5'), {})).toBe('claude-opus-5-high')
    expect(composeCursorModel(row('cursor-grok-4.6'), {})).toBe('cursor-grok-4.6-high')
  })

  it('composes the closest listed variant for a combination Cursor lacks', () => {
    // Opus 5 has Extra High and Max with Thinking only.
    expect(composeCursorModel(row('claude-opus-5'), { effort: 'xhigh', thinking: false })).toBe('claude-opus-5-high')
    expect(composeCursorModel(row('claude-opus-5'), { effort: 'xhigh', thinking: true, fastMode: true })).toBe('claude-opus-5-thinking-xhigh-fast')
    // GPT-5.4 Low has no Fast variant.
    expect(composeCursorModel(row('gpt-5.4'), { effort: 'low', fastMode: true })).toBe('gpt-5.4-low')
    // Sonnet 5: Thinking at High and Extra High.
    expect(composeCursorModel(row('claude-sonnet-5'), { effort: 'xhigh', thinking: true })).toBe('claude-sonnet-5-thinking-xhigh')
    // An effort the model does not have: its default.
    expect(composeCursorModel(row('gpt-5.1'), { effort: 'max' })).toBe('gpt-5.1')
  })

  it('decomposes a reported id into its row and options', () => {
    expect(listedModelValues(models, 'gpt-5.3-codex-high-fast')).toEqual({ model: 'gpt-5.3-codex', effort: 'high', fastMode: true })
    expect(listedModelValues(models, 'claude-opus-5-thinking-max')).toEqual({ model: 'claude-opus-5', effort: 'max', fastMode: false, thinking: true })
    expect(listedModelValues(models, 'gpt-5.5-extra-high')).toEqual({ model: 'gpt-5.5', effort: 'xhigh', fastMode: false })
    expect(listedModelValues(models, 'auto')).toEqual({ model: 'auto' })
    expect(listedModelValues(models, 'not-listed')).toBeNull()
    expect(valuesOnListedRow(models, { model: 'grok-4.7-low-fast' })).toEqual({ model: 'grok-4.7', effort: 'low', fastMode: true })
    expect(valuesOnListedRow(models, { model: 'grok-4.7', effort: 'high' })).toEqual({ model: 'grok-4.7', effort: 'high' })
  })

  it('launches with the exact listed id', () => {
    expect(sessionOptionLaunchText('cursor', { model: 'claude-opus-5', effort: 'max', thinking: true, fastMode: true }, '', models)).toBe('--model claude-opus-5-thinking-max-fast')
    expect(sessionOptionLaunchText('cursor', { model: 'claude-opus-5' }, '', models)).toBe('--model claude-opus-5-high')
    expect(sessionOptionLaunchText('cursor', { model: 'gpt-5.3-codex', effort: 'high', fastMode: true }, '', models)).toBe('--model gpt-5.3-codex-high-fast')
    expect(sessionOptionLaunchText('cursor', { model: 'gpt-5.3-codex', effort: 'medium' }, '', models)).toBe('--model gpt-5.3-codex')
    expect(sessionOptionLaunchText('cursor', { model: 'auto' }, '', models)).toBe('--model auto')
    // A variant id saved before the grouping still launches as itself.
    expect(sessionOptionLaunchText('cursor', { model: 'grok-4.7-xhigh-fast' }, '', models)).toBe('--model grok-4.7-xhigh-fast')
  })
})

describe('the order of Cursor rows', () => {
  it('Auto, then Claude by tier newest first, then GPT, Gemini, Grok, Composer, Kimi, the rest', async () => {
    const fs = await import('fs')
    const { join } = await import('path')
    const { parseCursorModelList } = await import('../agentModelProbe')
    const { groupCursorModels } = await import('../cursorModels')
    const rows = groupCursorModels(parseCursorModelList(fs.readFileSync(join(__dirname, 'fixtures', 'cursor-list-models.txt'), 'utf8')))
    const labels = rows.map((r) => r.label)
    expect(labels[0]).toBe('Auto')
    expect(labels.slice(1, 5)).toEqual(['Claude Fable 5.1 1M (NO ZDR)', 'Claude Fable 5 1M (NO ZDR)', 'Claude Opus 5.5 1M', 'Claude Opus 5 1M'])
    const first = (word) => labels.findIndex((l) => l.startsWith(word))
    expect(first('Claude')).toBeLessThan(first('GPT'))
    expect(first('GPT')).toBeLessThan(first('Gemini'))
    expect(first('Gemini')).toBeLessThan(first('Grok'))
    expect(first('Grok')).toBeLessThan(first('Composer'))
    expect(labels.indexOf('Grok 4.7')).toBeLessThan(labels.indexOf('Grok 4.5'))
  })
})

// Cursor's TUI (2026.10): /model <text> filters its picker by name (an id
// matches nothing), and the line under its prompt says the model in use.
describe("Cursor's own picker and status line", () => {
  it('filters its picker by the name it shows, without context notes', () => {
    expect(cursorPickerFilter(row('gpt-5.6-sol'))).toBe('GPT-5.6 Sol')
    expect(cursorPickerFilter(row('gpt-5.3-codex'))).toBe('Codex 5.3')
    expect(cursorPickerFilter(row('claude-opus-5-5'))).toBe('Claude Opus 5.5')
    expect(cursorPickerFilter(row('claude-fable-5-1'))).toBe('Claude Fable 5.1')
    expect(cursorPickerFilter(null)).toBe('')
  })

  it('reads the status line as the exact listed id, its effort and Fast', () => {
    expect(cursorModelFromStatusLine('GPT-5.6 Sol 272K High Fast', models)).toMatchObject({ model: 'gpt-5.6-sol-high-fast', row: 'gpt-5.6-sol', name: 'GPT-5.6 Sol Fast', effort: 'high', fastMode: true })
    expect(cursorModelFromStatusLine('  GPT-5.6 Luna 272K Medium ', models)).toMatchObject({ model: 'gpt-5.6-luna-medium', name: 'GPT-5.6 Luna', effort: 'medium', fastMode: false })
    expect(cursorModelFromStatusLine('Codex 5.3 High', models)).toMatchObject({ model: 'gpt-5.3-codex-high', effort: 'high' })
    expect(cursorModelFromStatusLine('Claude Opus 5.5 300K Extra High', models)).toMatchObject({ model: 'claude-opus-5-5-xhigh', effort: 'xhigh' })
    expect(cursorModelFromStatusLine('Auto', models)).toMatchObject({ model: 'auto', effort: null })
  })

  it('never takes other text for it', () => {
    expect(cursorModelFromStatusLine('GPT-5.6 Sol is a good model', models)).toBeNull()
    expect(cursorModelFromStatusLine('C:\Tessel · main', models)).toBeNull()
    expect(cursorModelFromStatusLine('→ GPT-5.6 Sol   272K Medium (Tab to modify)', models)).toBeNull()
  })

  it('reads the screen from the bottom up, and nothing while its picker is open', () => {
    const screen = ['Cursor Agent', '→ Plan, search, build anything', 'GPT-5.6 Luna 272K Medium', 'C:\Tessel · main']
    expect(cursorModelOnScreen(screen, models)).toMatchObject({ model: 'gpt-5.6-luna-medium' })
    const picker = ['Available models', 'Filter:', '→ Auto', 'Grok 4.7   256K High Fast', 'Type to filter • Enter to select • Tab to edit']
    expect(cursorPickerShown(picker)).toBe(true)
    expect(cursorModelOnScreen(picker, models)).toBeNull()
  })

  it('switches mid-session by name: /model with the id would only filter to nothing', () => {
    const mid = getAgentSessionOptionCatalog('cursor').modelApply.midSession
    expect(mid.kind).toBe('picker-filter')
    expect(mid.build('Codex 5.3')).toBe('/model Codex 5.3')
    expect(mid.build('')).toBe('/model')
  })
})
