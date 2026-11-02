// @vitest-environment node
// A name the main process uses but never imports builds without a word and only fails when
// someone reaches it: Settings > Backup > Export and opening a file outside Tessel both did.
import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const main = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = ['process', 'Buffer', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'URL', 'URLSearchParams', 'fetch', 'AbortSignal', 'AbortController', 'TextDecoder', 'TextEncoder', '__dirname', '__filename', 'require', 'module', 'queueMicrotask', 'performance', 'structuredClone', 'Blob', 'File', 'FormData', 'Request', 'Response', 'Headers', 'crypto', 'WebSocket', 'globalThis', '__TESSEL_BUILD__']
// Code sent into a web page, where these exist.
const IN_A_PAGE = ['browserPasswords.js']

describe('the main process', () => {
  it('uses no name it has not imported', async () => {
    const eslint = new ESLint({
      cwd: main,
      overrideConfigFile: true,
      overrideConfig: [{ files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: Object.fromEntries(NODE.map((n) => [n, 'readonly'])) }, rules: { 'no-undef': 'error' } }],
      ignorePatterns: ['__tests__/**', ...IN_A_PAGE]
    })
    const results = await eslint.lintFiles(['**/*.js'])
    const missing = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'no-undef').map((m) => `${relative(main, r.filePath).split(sep).join('/')}:${m.line} ${m.message}`))
    expect(missing).toEqual([])
  }, 120000)
})
