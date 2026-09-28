// Transport and provider mappings adapted from Orca (MIT, Lovecast Inc., 2026).
// Explicit requests only. No polling, token refresh, credential writes or logs.
import { installedUsageProviders } from '../shared/usageProviders'
import { createUsageProviderSources, ProviderReadError, refuse } from './usageProviderSources'
import {
  mapGemini,
  mapKimi,
  mapCursor,
  mapCursorLegacy,
  mapGrok,
  mapOpenCodeGo,
  mapMiniMax
} from './usageProviderMapping'

export const USAGE_URLS = Object.freeze({
  geminiProject: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  gemini: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  kimi: 'https://api.kimi.com/coding/v1/usages',
  cursor: 'https://cursor.com/api/usage-summary',
  cursorLegacy: 'https://cursor.com/api/usage',
  grok: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  grokMonthly: 'https://cli-chat-proxy.grok.com/v1/billing',
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  minimax: 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains'
})
export function createExtraProviderUsage({
  listAgents,
  sources = createUsageProviderSources(),
  request = globalThis.fetch,
  clock = Date.now,
  timeoutMs = 10000
} = {}) {
  const sequences = new Map()
  async function capabilities() {
    const installed = installedUsageProviders(await listAgents())
    const providers = await Promise.all(
      installed.map(async (p) => ({ ...p, quota: p.report || (await sources.present(p.id)) }))
    )
    return { ok: true, providers: providers.filter((p) => p.report || p.quota) }
  }
  async function json(key, headers, signal, body) {
    const url = USAGE_URLS[key]
    if (!url) refuse('validation', 'Unsupported usage endpoint.')
    const response = await request(url, {
      method: body ? 'POST' : 'GET',
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal
    })
    if (
      response.redirected ||
      (response.url && response.url !== url) ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => {})
      refuse('redirect', 'The usage request redirected and was refused.')
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (key === 'opencode-go' && response.status === 403)
        refuse('unavailable', 'This OpenCode account has no Go subscription.')
      refuse(
        response.status === 401 || response.status === 403 ? 'auth' : 'network',
        response.status === 401 || response.status === 403
          ? 'Provider access was refused. Sign in with its CLI and retry.'
          : 'The provider usage service is temporarily unavailable.'
      )
    }
    const reader = response.body?.getReader()
    if (!reader) refuse('response', 'The usage service returned no data.')
    let size = 0
    const chunks = []
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (signal.aborted) refuse('timeout', 'The usage request timed out.')
        size += item.value.byteLength
        if (size > 256 * 1024) refuse('response', 'The usage response exceeded its size limit.')
        chunks.push(Buffer.from(item.value))
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        refuse('response', 'The usage response could not be read.')
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  return {
    capabilities,
    async read({ provider, accountId } = {}) {
      const sequence = (sequences.get(provider) || 0) + 1
      if (
        typeof provider !== 'string' ||
        !Object.hasOwn(USAGE_URLS, provider) ||
        ['geminiProject', 'cursorLegacy', 'grokMonthly'].includes(provider) ||
        accountId !== null
      )
        return {
          ok: false,
          code: 'validation',
          error: 'Choose a supported provider and its local login.'
        }
      sequences.set(provider, sequence)
      const controller = new AbortController()
      let timer
      const work = async () => {
        const installed = installedUsageProviders(await listAgents())
        if (!installed.some((p) => p.id === provider))
          refuse('unavailable', 'The matching agent is not installed.')
        const login = await sources.auth(provider)
        const fetch = (key, body) => {
          if (controller.signal.aborted) refuse('timeout', 'The usage request timed out.')
          return json(key, login.headers, controller.signal, body)
        }
        let windows = [],
          unlimited = false
        if (provider === 'gemini') {
          const project = await fetch('geminiProject', {
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
          })
          if (
            typeof project?.cloudaicompanionProject !== 'string' ||
            !project.cloudaicompanionProject
          )
            refuse('response', 'Gemini did not return a quota project.')
          windows = mapGemini(await fetch('gemini', { project: project.cloudaicompanionProject }))
        } else {
          const data = await fetch(provider)
          if (provider === 'kimi') windows = mapKimi(data)
          if (provider === 'cursor') {
            ;({ windows, unlimited = false } = mapCursor(data))
            if (!windows.length && !unlimited)
              windows = mapCursorLegacy(await fetch('cursorLegacy'))
          }
          if (provider === 'grok') {
            windows = mapGrok(data)
            if (!windows.length) windows = mapGrok(await fetch('grokMonthly'))
          }
          if (provider === 'opencode-go') windows = mapOpenCodeGo(data)
          if (provider === 'minimax') {
            if (data?.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0)
              refuse(
                data.base_resp.status_code === 1004 ? 'auth' : 'response',
                'MiniMax refused the usage request. Check its API key.'
              )
            windows = mapMiniMax(data, clock())
          }
        }
        const current = await sources.auth(provider)
        if (login.fingerprint !== current.fingerprint || sequences.get(provider) !== sequence)
          refuse('stale', 'The provider login or usage request changed. Refresh usage.')
        if (!windows.length && !unlimited)
          refuse('unavailable', 'This account did not return supported quota windows.')
        return {
          ok: true,
          provider,
          accountId: null,
          source: 'live',
          observedAt: clock(),
          windows,
          ...(unlimited ? { unlimited: true } : {})
        }
      }
      try {
        return await Promise.race([
          work(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => {
                controller.abort()
                reject(new ProviderReadError('timeout', 'The usage request timed out.'))
              },
              Math.max(1, Math.min(timeoutMs, 30000))
            )
          })
        ])
      } catch (error) {
        return {
          ok: false,
          provider,
          accountId: null,
          code: error instanceof ProviderReadError ? error.code : 'network',
          error:
            error instanceof ProviderReadError
              ? error.message
              : 'Could not read provider usage. Try again.'
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
  }
}
