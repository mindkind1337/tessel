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
import { t } from './i18n'

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
// Providers read through another one's quota: Antigravity shares Google Code
// Assist's with Gemini CLI, and keeps its own token in the OS keyring, so its
// quota is Gemini's (after Orca's src/main/rate-limits/antigravity-usage-mirror.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.). Only a successful read is shown.
export const USAGE_MIRRORS = Object.freeze({ antigravity: 'gemini' })
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
      installed.map(async (p) => ({
        ...p,
        quota: p.quota !== false && (p.report || (await sources.present(USAGE_MIRRORS[p.id] || p.id)))
      }))
    )
    return { ok: true, providers: providers.filter((p) => p.report || p.quota) }
  }
  async function json(key, headers, signal, body) {
    const url = USAGE_URLS[key]
    if (!url) refuse('validation', t('main.usage.unsupportedEndpoint', 'Unsupported usage endpoint.'))
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
      refuse('redirect', t('main.usage.redirectRefused', 'The usage request redirected and was refused.'))
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      if (key === 'opencode-go' && response.status === 403)
        refuse('unavailable', t('main.usage.noOpenCodeGo', 'This OpenCode account has no Go subscription.'))
      refuse(
        response.status === 401 || response.status === 403 ? 'auth' : 'network',
        response.status === 401 || response.status === 403
          ? t('main.usage.providerRefused', 'Provider access was refused. Sign in with its CLI and retry.')
          : t('main.usage.providerUnavailable', 'The provider usage service is temporarily unavailable.')
      )
    }
    const reader = response.body?.getReader()
    if (!reader) refuse('response', t('main.usage.noData', 'The usage service returned no data.'))
    let size = 0
    const chunks = []
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        if (signal.aborted) refuse('timeout', t('main.usage.timedOut', 'The usage request timed out.'))
        size += item.value.byteLength
        if (size > 256 * 1024) refuse('response', t('main.usage.tooLarge', 'The usage response exceeded its size limit.'))
        chunks.push(Buffer.from(item.value))
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        refuse('response', t('main.usage.unreadable', 'The usage response could not be read.'))
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
        !(Object.hasOwn(USAGE_URLS, provider) || Object.hasOwn(USAGE_MIRRORS, provider)) ||
        ['geminiProject', 'cursorLegacy', 'grokMonthly'].includes(provider) ||
        accountId !== null
      )
        return {
          ok: false,
          code: 'validation',
          error: t('main.usage.chooseProvider', 'Choose a supported provider and its local login.')
        }
      sequences.set(provider, sequence)
      // The provider whose quota answers (itself, or the one it mirrors).
      const source = USAGE_MIRRORS[provider] || provider
      const controller = new AbortController()
      let timer,
        asked = false // the source's login was reached
      const work = async () => {
        const installed = installedUsageProviders(await listAgents())
        if (!installed.some((p) => p.id === provider))
          refuse('unavailable', t('main.usage.agentNotInstalled', 'The matching agent is not installed.'))
        asked = true
        const login = await sources.auth(source)
        const fetch = (key, body) => {
          if (controller.signal.aborted) refuse('timeout', t('main.usage.timedOut', 'The usage request timed out.'))
          return json(key, login.headers, controller.signal, body)
        }
        let windows = [],
          unlimited = false
        if (source === 'gemini') {
          const project = await fetch('geminiProject', {
            metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' }
          })
          if (
            typeof project?.cloudaicompanionProject !== 'string' ||
            !project.cloudaicompanionProject
          )
            refuse('response', t('main.usage.geminiNoProject', 'Gemini did not return a quota project.'))
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
                t('main.usage.minimaxRefused', 'MiniMax refused the usage request. Check its API key.')
              )
            windows = mapMiniMax(data, clock())
          }
        }
        const current = await sources.auth(source)
        if (login.fingerprint !== current.fingerprint || sequences.get(provider) !== sequence)
          refuse('stale', t('main.usage.loginChanged', 'The provider login or usage request changed. Refresh usage.'))
        if (!windows.length && !unlimited)
          refuse('unavailable', t('main.usage.noWindows', 'This account did not return supported quota windows.'))
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
                reject(new ProviderReadError('timeout', t('main.usage.timedOut', 'The usage request timed out.')))
              },
              Math.max(1, Math.min(timeoutMs, 30000))
            )
          })
        ])
      } catch (error) {
        const code = error instanceof ProviderReadError ? error.code : 'network'
        if (source !== provider && asked && code !== 'stale')
          return {
            ok: false,
            provider,
            accountId: null,
            code: 'unavailable',
            // Its own words: the request was Gemini's, not a failed Antigravity sign-in.
            error: ['unavailable', 'auth', 'expired'].includes(code)
              ? t(
                  'main.usage.antigravityNoGemini',
                  'Antigravity usage is shown from the shared Google Code Assist quota, which needs a Gemini CLI sign-in.'
                )
              : t(
                  'main.usage.antigravityUnreadable',
                  'Antigravity usage comes from the shared Google Code Assist quota, which could not be read right now.'
                )
          }
        return {
          ok: false,
          provider,
          accountId: null,
          code,
          error:
            error instanceof ProviderReadError
              ? error.message
              : t('main.usage.readRetry', 'Could not read provider usage. Try again.')
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
  }
}
