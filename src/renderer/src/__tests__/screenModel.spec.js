import { describe, it, expect } from 'vitest'
import { modelInLine, modelFromScreen } from '../../../shared/screenModel'

describe('the model an agent shows on its screen', () => {
  it('finds model names as agents print them', () => {
    expect(modelInLine('  kimi-k2-turbo-preview  ·  ~/proj  ·  ctx 12%')).toBe('kimi-k2-turbo-preview')
    expect(modelInLine('Model: moonshot/kimi-k2.5 | tokens 3k')).toBe('moonshot/kimi-k2.5')
    expect(modelInLine('[gpt-5.5] act mode')).toBe('gpt-5.5')
    expect(modelInLine('Opus 4.7 (1M) · Claude Max')).toBe('Opus 4.7 (1M)')
    expect(modelInLine('using deepseek-v4-flash.')).toBe('deepseek-v4-flash')
    expect(modelInLine('openrouter/qwen3-coder-plus')).toBe('openrouter/qwen3-coder-plus')
    expect(modelInLine('gemini-3-pro-preview')).toBe('gemini-3-pro-preview')
  })

  it('ignores ordinary words that look close', () => {
    expect(modelInLine('the gpt of it, a sonnet, the opus')).toBe(null)
    expect(modelInLine('see chapter o3 page')).toBe(null)
    expect(modelInLine('myclaude-script.js ran')).toBe(null)
    expect(modelInLine('')).toBe(null)
  })

  it('reads the status bar first (bottom up), then the banner, never the middle', () => {
    expect(
      modelFromScreen({
        top: ['Welcome to Kimi CLI', 'model: kimi-k2-0905'],
        bottom: ['> tell me about gpt-4o', '', 'kimi-k2-turbo · 20% context']
      })
    ).toBe('kimi-k2-turbo')
    // No status bar: the banner.
    expect(modelFromScreen({ top: ['Welcome', 'model: kimi-k2-0905'], bottom: ['> hi', 'Hello!'] })).toBe('kimi-k2-0905')
    expect(modelFromScreen({ top: ['Welcome'], bottom: ['> hi'] })).toBe(null)
    expect(modelFromScreen()).toBe(null)
  })
})
