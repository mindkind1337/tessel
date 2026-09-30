import { describe, it, expect } from 'vitest'
import { parsePiModelList, parseCursorModelList, parseAntigravityModelList, listedToCatalogModels, MODEL_PROBE_MAX_OUTPUT } from '../agentModelProbe'
import { catalogModelsFor, sessionOptionLaunchText, getAgentSessionOptionCatalog } from '../agentSessionOptions'

describe('Pi, Cursor and Antigravity model output fixtures', () => {
  it('Pi uses qualified ids and only offers thinking for capable rows', () => {
    const rows = parsePiModelList('provider model context max-out thinking input\nopenai gpt-5.4 272k 32k yes text,image\nlocal small 32k 8k no text\nopenai gpt-5.4 272k 32k yes text,image\nwarning: please sign in')
    expect(rows.map((r) => r.id)).toEqual(['openai/gpt-5.4', 'local/small'])
    const models = listedToCatalogModels('pi', rows)
    expect(models[0].options[0].kind.choices.map((c) => c.value)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(models[1].options).toEqual([])
    expect(sessionOptionLaunchText('pi', { model: rows[0].id, effort: 'off' }, '', models)).toBe('--model openai/gpt-5.4 --thinking off')
    expect(sessionOptionLaunchText('pi', { model: rows[1].id, effort: 'high' }, '', models)).toBe('--model local/small')
    expect(sessionOptionLaunchText('pi', { model: rows[0].id, effort: 'high' }, '--thinking low', models)).toBe('--model openai/gpt-5.4')
  })

  it('Cursor cleans markers, deduplicates and retains only known option mappings', () => {
    const rows = parseCursorModelList('Available models\nauto - Auto (default)\ngpt-5.3-codex - Codex (current)\nnew-model - New Model\nnew-model - Duplicate\nUse --model to choose')
    expect(rows).toEqual([{ id: 'auto', label: 'Auto', isDefault: true }, { id: 'gpt-5.3-codex', label: 'Codex' }, { id: 'new-model', label: 'New Model' }])
    const models = catalogModelsFor('cursor', listedToCatalogModels('cursor', rows))
    expect(models.find((m) => m.id === 'gpt-5.3-codex').options.map((o) => o.id)).toEqual(['effort', 'fastMode'])
    expect(models.find((m) => m.id === 'new-model').options).toEqual([])
    expect(sessionOptionLaunchText('cursor', { model: 'new-model', effort: 'high' }, '', models)).toBe('--model new-model')
  })

  it('Antigravity accepts only tab-separated ids and names, keeping the effort control', () => {
    const rows = parseAntigravityModelList('id\tlabel\ngemini-3.5-flash\tGemini 3.5 Flash\nGemini 3.5 Flash (Medium)\nbad id\tBad\n--yolo\tBad\n$(whoami)\tBad')
    expect(rows).toEqual([{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }])
    const models = listedToCatalogModels('antigravity', rows)
    expect(sessionOptionLaunchText('antigravity', { model: rows[0].id, effort: 'medium' }, '', models)).toBe('--model gemini-3.5-flash --effort medium')
  })

  it.each([parsePiModelList, parseCursorModelList, parseAntigravityModelList])('bounds hostile output without parsing shell values', (parse) => {
    expect(parse('x'.repeat(MODEL_PROBE_MAX_OUTPUT + 1))).toEqual([])
    expect(parse('bad;touch/x - Bad\nbad;touch/x\tBad\nbad;touch x 2k 1k yes text')).toEqual([])
  })

  it('bounds accepted rows and labels', () => {
    const rows = parseCursorModelList(Array.from({ length: 400 }, (_, i) => `model-${i} - ${'x'.repeat(200)}`).join('\n'))
    expect(rows).toHaveLength(300)
    expect(rows[0].label).toHaveLength(120)
  })
})

describe('fixed catalogs and launch arguments', () => {
  it.each(['pi', 'cursor', 'antigravity', 'amp', 'kimi', 'copilot'])('%s keeps the CLI default and refuses shell syntax', (agent) => {
    expect(getAgentSessionOptionCatalog(agent)).toBeTruthy()
    expect(sessionOptionLaunchText(agent, {})).toBe('')
    expect(sessionOptionLaunchText(agent, { effort: 'high' })).toBe('')
    expect(sessionOptionLaunchText(agent, { model: 'x;echo_bad' })).toBe('')
    expect(sessionOptionLaunchText(agent, { model: '--yolo' })).toBe('')
  })

  it('Amp uses modes and limits effort to large/deep', () => {
    expect(sessionOptionLaunchText('amp', { model: 'smart', effort: 'high' })).toBe('--mode smart')
    expect(sessionOptionLaunchText('amp', { model: 'rush', effort: 'high' })).toBe('--mode rush')
    expect(sessionOptionLaunchText('amp', { model: 'deep', effort: 'high' })).toBe('--mode deep --effort high')
    expect(sessionOptionLaunchText('amp', { model: 'large', effort: 'low' }, '--effort=medium')).toBe('--mode large')
    expect(sessionOptionLaunchText('amp', { model: 'deep' }, '--mode smart')).toBe('')
    expect(getAgentSessionOptionCatalog('amp').modelApply.midSession).toBeUndefined()
  })

  it('Kimi passes --model without inventing thinking flags', () => {
    expect(sessionOptionLaunchText('kimi', { model: 'kimi-code/kimi-for-coding', effort: 'high', thinking: true })).toBe('--model kimi-code/kimi-for-coding')
    expect(sessionOptionLaunchText('kimi', { model: 'kimi-code/kimi-for-coding' }, '-mother')).toBe('')
  })

  it('Copilot uses its documented reasoning flag, honoring both effort aliases', () => {
    expect(sessionOptionLaunchText('copilot', { model: 'gpt-5.4', effort: 'xhigh' })).toBe('--model gpt-5.4 --reasoning-effort xhigh')
    for (const alias of ['--effort', '--reasoning-effort']) {
      expect(sessionOptionLaunchText('copilot', { model: 'gpt-5.4', effort: 'high' }, `${alias}=low`)).toBe('--model gpt-5.4')
    }
    expect(sessionOptionLaunchText('copilot', { model: 'claude-sonnet-4.6', effort: 'high' })).toBe('--model claude-sonnet-4.6')
    expect(sessionOptionLaunchText('copilot', { model: 'auto' })).toBe('--model auto')
    expect(sessionOptionLaunchText('copilot', { model: 'gpt-5.4' }, '--model auto')).toBe('')
  })
})
