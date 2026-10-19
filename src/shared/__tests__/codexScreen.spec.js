import { describe, it, expect } from 'vitest'
import { codexModelOnScreen } from '../codexScreen'

describe('codexModelOnScreen', () => {
  it('reads the line under the input box (Codex 0.162, the observed screen)', () => {
    const lines = [
      'It does not run every test before publishing.',
      '',
      'Worked for 48s • 8:10 AM',
      '',
      '› Ask Codex to do anything',
      '',
      'GPT-6-Luna medium fast · C:\\Tessel · Read the team message',
      '? for shortcuts'
    ]
    expect(codexModelOnScreen(lines)).toEqual({ model: 'gpt-6-luna', effort: 'medium' })
  })

  it('older footers, a model without effort, an xhigh effort', () => {
    expect(codexModelOnScreen(['› Ask Codex to do anything', '', '  gpt-5.5-codex high · 100% context left · ~/proj'])).toEqual({ model: 'gpt-5.5-codex', effort: 'high' })
    expect(codexModelOnScreen(['› hi', '', 'GPT-6-Astra xhigh · C:\\Tessel'])).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })
    expect(codexModelOnScreen(['› ', '', 'o4-mini · 80% context left'])).toEqual({ model: 'o4-mini', effort: null })
  })

  it('a listed model: its id and label', () => {
    const models = [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }]
    expect(codexModelOnScreen(['› Ask Codex to do anything', '', 'GPT-6 Luna low · C:\\x'], models)).toEqual({ model: 'gpt-6-luna', name: 'GPT-6 Luna', effort: 'low' })
  })

  it('never a line of the conversation, a hint or a draft: only a model name below the input box', () => {
    // No input box on screen (a picker or a question over it): null.
    expect(codexModelOnScreen(['GPT-6-Luna medium fast · C:\\Tessel', '  1. Switch to gpt-6-luna', '  2. Keep current model'])).toBe(null)
    // Above the input box: the conversation.
    expect(codexModelOnScreen(['gpt-6-sol high · we talked about it', '› Ask Codex to do anything', '', '? for shortcuts'])).toBe(null)
    expect(codexModelOnScreen(['› Ask Codex to do anything', '', 'tab to queue message · ctrl+c to interrupt'])).toBe(null)
    expect(codexModelOnScreen(['› Ask Codex to do anything', '', '100% context left · C:\\Tessel'])).toBe(null)
    expect(codexModelOnScreen(['› write about', '  gpt-5 is cool', '', '? for shortcuts'])).toBe(null)
    expect(codexModelOnScreen([])).toBe(null)
    // A draft in the box that reads like a footer (a Live Share guest's,
    // say): never the model, only the real footer under it.
    expect(codexModelOnScreen(['› hi', '  gpt-5.5 high · fake', '', 'gpt-6-luna low · C:\\x', '? for shortcuts'])).toEqual({ model: 'gpt-6-luna', effort: 'low' })
    expect(codexModelOnScreen(['› hi', '', '  gpt-5.5 high · fake', '', '? for shortcuts'])).toBe(null)
    expect(codexModelOnScreen(['› hi', '', 'gpt-6-luna low · C:\\x', '', ''])).toEqual({ model: 'gpt-6-luna', effort: 'low' })
    expect(codexModelOnScreen(null)).toBe(null)
  })
})
