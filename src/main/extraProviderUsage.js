// Transport and provider mappings adapted from Orca (MIT, Lovecast Inc., 2026).
// Reads on request, or from the automatic refresh (usagePoller.js). No token
// refresh, credential writes or logs.
import { installedUsageProviders } from '../shared/usageProviders'
import { createUsageProviderSources, ProviderReadError, refuse } from './usageProviderSources'
import {
  mapGemini,
  mapKimi,
  mapCursor,
  mapCursorLegacy,
  mapGrok,
  mapOpenCodeGo,
  mapMiniMax,
  mapOpenCodeConsole,
  mapZcode,
  openCodeWorkspaceIds
} from './usageProviderMapping'
import { randomUUID } from 'node:crypto'
import { t } from './i18n'
import { retryAfterMs } from './usagePoller'

// The console's server-function id for its workspaces list (stable, from Orca).
const OPENCODE_WORKSPACES_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'
export const USAGE_URLS = Object.freeze({
  geminiProject: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  gemini: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  kimi: 'https://api.kimi.com/coding/v1/usages',
  cursor: 'https://cursor.com/api/usage-summary',
  cursorLegacy: 'https://cursor.com/api/usage',
  grok: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
  grokMonthly: 'https://cli-chat-proxy.grok.com/v1/billing',
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  // OpenCode's legacy console, with the session cookie saved in Settings (Orca's
  // opencode-go-usage-fetcher.ts): its workspaces, then a workspace's Go status.
  opencodeWorkspaces: `https://opencode.ai/_server?id=${OPENCODE_WORKSPACES_ID}`,
  opencodeConsole: 'https://opencode.ai/console/api/go/status',
  minimax: 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains',
  // Settings > MiniMax endpoint: China (Orca's minimax-request-context.ts).
  minimaxCn: 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains',
  // ZCode's Coding Plan quota, on the host of its configured endpoint (Orca's
  // zcode-usage-fetcher.ts): Z.ai, then BigModel (China) and its dev host.
  zcode: 'https://api.z.ai/api/monitor/usage/quota/limit',
  zcodeCn: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
  zcodeDev: 'https://dev.bigmodel.cn/api/monitor/usage/quota/limit'
})
// Internal endpoints of a provider's read, never a provider of their own.
const SUB_REQUESTS = ['geminiProject', 'cursorLegacy', 'grokMonthly', 'opencodeWorkspaces', 'opencodeConsole', 'minimaxCn', 'zcodeCn', 'zcodeDev']
// Providers read through another one's quota: Antigravity shares Google Code
// Assist's with Gemini CLI, and keeps its own token in the OS keyring, so its
// quota is Gemini's (after Orca's src/main/rate-limits/antigravity-usage-mirror.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.). Only a successful read is shown.
export const USAGE_MIRRORS = Object.freeze({ antigravity: 'gemini' })
export function createExtraProviderUsage({
  listAgents,
  // Settings' saved usage credentials (providerCredentials.js).
  credentials = null,
  sources = createUsageProviderSources({ credentials }),
  request = globalThis.fetch,
  clock = Date.now,
  timeoutMs = 10000
} = {}) {
  const sequences = new Map()
  // The providers to read: installed ones, and the ones a key saved in
  // Settings links (a GLM Coding Plan key without ZCode, named after its plan).
  async function installedProviders() {
    const agents = await listAgents()
    let linked = []
    try {
      linked = (await sources.linked?.()) || []
    } catch {
      linked = []
    }
    const own = new Set(installedUsageProviders(agents).map((p) => p.id))
    return installedUsageProviders(agents, linked).map((p) =>
      own.has(p.id) || p.id !== 'zcode' ? p : { ...p, name: 'GLM Coding Plan' } // i18n-ignore product name
    )
  }
  async function capabilities() {
    const installed = await installedProviders()
    const providers = await Promise.all(
      installed.map(async (p) => ({
        ...p,
        quota: p.quota !== false && (p.report || (await sources.present(USAGE_MIRRORS[p.id] || p.id)))
      }))
    )
    return { ok: true, providers: providers.filter((p) => p.report || p.quota) }
  }
  async function json(key, headers, signal, body, asText = false) {
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
      if (response.status === 429) {
        const error = new ProviderReadError(
          'rate-limited',
          t('main.usage.rateLimited', 'The usage service is limiting requests. Tessel will try again later.')
        )
        error.retryAfterMs = retryAfterMs(response.headers, clock())
        throw error
      }
      // Cursor: only a 401 means the sign-in expired. A 403, 5xx or other
      // failure is a usage read that did not work, not a reason to sign in
      // again (after Orca's src/main/rate-limits/cursor-fetcher.ts, MIT,
      // Copyright (c) 2026 Lovecast Inc.).
      if (key === 'cursor' || key === 'cursorLegacy') {
        if (response.status === 401)
          refuse(
            'expired',
            t('main.usage.cursorSignInExpired', 'Cursor sign-in expired. Sign in again with Cursor or cursor-agent login.')
          )
        refuse(
          'server',
          t('main.usage.cursorUnreadable', 'Cursor usage could not be read (HTTP {{status}}).', {
            status: response.status
          })
        )
      }
      if (key === 'opencode-go' && response.status === 403)
        refuse('unavailable', t('main.usage.noOpenCodeGo', 'This OpenCode account has no Go subscription.'))
      if (key === 'opencodeConsole' && response.status === 401)
        refuse(
          'auth',
          t(
            'main.usage.openCodeConsoleSession',
            'OpenCode refused the cookie. Paste the full Cookie header including __Host-console_session (auth alone is not enough).'
          )
        )
      if ((key === 'minimax' || key === 'minimaxCn') && (response.status === 401 || response.status === 403))
        refuse(
          'auth',
          headers?.Cookie
            ? t('main.usage.minimaxCookieExpired', 'MiniMax session cookie expired. Replace it in Settings.')
            : t('main.usage.minimaxKeyExpired', 'MiniMax API key expired. Replace it in Settings.')
        )
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
        if (size > (asText ? 1024 * 1024 : 256 * 1024)) refuse('response', t('main.usage.tooLarge', 'The usage response exceeded its size limit.'))
        chunks.push(Buffer.from(item.value))
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        return asText ? text : JSON.parse(text)
      } catch {
        refuse('response', t('main.usage.unreadable', 'The usage response could not be read.'))
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }
  return {
    capabilities,
    // Cursor and Grok: who is signed in, for Settings (no token).
    signIn: (provider) => sources.signIn?.(provider),
    async read({ provider, accountId } = {}) {
      const sequence = (sequences.get(provider) || 0) + 1
      if (
        typeof provider !== 'string' ||
        !(Object.hasOwn(USAGE_URLS, provider) || Object.hasOwn(USAGE_MIRRORS, provider)) ||
        SUB_REQUESTS.includes(provider) ||
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
        asked = false, // the source's login was reached
        secrets = [] // the login's key or cookie, never in an error
      const redact = (text) =>
        secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text))
      const work = async () => {
        const installed = await installedProviders()
        if (!installed.some((p) => p.id === provider))
          refuse('unavailable', t('main.usage.agentNotInstalled', 'The matching agent is not installed.'))
        asked = true
        const login = await sources.auth(source)
        for (const name of ['Authorization', 'Cookie']) {
          const value = login?.headers?.[name]
          if (typeof value === 'string' && value.length >= 4)
            secrets.push(value, value.replace(/^Bearer\s+/i, ''))
        }
        secrets = [...new Set(secrets.filter((value) => value.length >= 4))].sort((a, b) => b.length - a.length)
        const fetch = (key, body, headers = login.headers, asText = false) => {
          if (controller.signal.aborted) refuse('timeout', t('main.usage.timedOut', 'The usage request timed out.'))
          return json(key, headers, controller.signal, body, asText)
        }
        // OpenCode's legacy console: the workspace from Settings, or the ones
        // its session can see, then the first workspace that answers.
        const openCodeConsole = async ({ cookie, workspaceId }) => {
          const base = { Cookie: cookie, Origin: 'https://opencode.ai' }
          const ids = workspaceId
            ? [workspaceId]
            : openCodeWorkspaceIds(
                await fetch(
                  'opencodeWorkspaces',
                  null,
                  {
                    ...base,
                    Referer: 'https://opencode.ai',
                    'X-Server-Id': OPENCODE_WORKSPACES_ID,
                    'X-Server-Instance': `server-fn:${randomUUID()}`,
                    Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8'
                  },
                  true
                )
              )
          if (!ids.length)
            refuse(
              'unavailable',
              t(
                'main.usage.openCodeNoWorkspace',
                'No workspace found for this cookie. Add an OpenCode Go API key (or run /connect in OpenCode), or set a Workspace ID override.'
              )
            )
          let failure = null
          for (const id of ids.slice(0, 5)) {
            try {
              const found = mapOpenCodeConsole(
                await fetch('opencodeConsole', null, {
                  ...base,
                  Accept: 'application/json',
                  Referer: `https://opencode.ai/console/${id}/go`,
                  'x-org-id': id
                })
              )
              if (found.length) return found
            } catch (error) {
              if (error?.code === 'rate-limited' || error?.code === 'timeout') throw error
              failure = error
            }
          }
          if (failure) throw failure
          refuse('response', t('main.usage.unreadable', 'The usage response could not be read.'))
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
        } else if (provider === 'opencode-go' && !login.headers.Authorization) {
          windows = await openCodeConsole(login.console)
        } else if (provider === 'opencode-go' && login.console) {
          // A Black-only account's key has no Go entitlement: its usage is
          // behind the console session (as in Orca); the key's verdict otherwise.
          try {
            windows = mapOpenCodeGo(await fetch('opencode-go'))
          } catch (error) {
            if (error?.code === 'rate-limited' || error?.code === 'timeout') throw error
            try {
              windows = await openCodeConsole(login.console)
            } catch (consoleError) {
              if (consoleError?.code === 'rate-limited' || consoleError?.code === 'timeout') throw consoleError
              throw error
            }
          }
        } else {
          // A Coding Plan key that Z.ai or BigModel refuses: the key to
          // replace (the one saved in Settings, or ZCode's own), never a retry.
          const zcodeKeyRefused = () =>
            refuse(
              'auth',
              login.planKey
                ? t('main.usage.zcodePlanKeyRefused', 'The GLM Coding Plan key was refused (expired or incorrect). Replace it in Settings.')
                : t('main.usage.zcodeKeyRefused', "ZCode's Coding Plan key was refused (expired or incorrect). Update it in ZCode.")
            )
          let data
          try {
            data = await fetch(provider === 'minimax' || provider === 'zcode' ? login.endpoint || provider : provider)
          } catch (error) {
            if (provider === 'zcode' && error?.code === 'auth') zcodeKeyRefused()
            throw error
          }
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
          if (provider === 'zcode') {
            windows = mapZcode(data, clock())
            // Wrong or expired key: HTTP 200 with { code: 401, success: false }.
            if (!windows && (data?.code === 401 || data?.code === 403)) zcodeKeyRefused()
            if (!windows)
              refuse(
                'response',
                login.planKey
                  ? t('main.usage.zcodePlanRefused', 'The GLM Coding Plan quota service refused the request.')
                  : t('main.usage.zcodeRefused', 'ZCode refused the quota request. Check its Coding Plan key.')
              )
          }
          if (provider === 'minimax') {
            const code = data?.base_resp?.status_code
            // An expired cookie or key answers HTTP 200 with status 1004.
            if (code !== undefined && code !== 0)
              refuse(
                code === 1004 ? 'auth' : 'response',
                code === 1004
                  ? login.transport === 'cookie'
                    ? t('main.usage.minimaxCookieExpired', 'MiniMax session cookie expired. Replace it in Settings.')
                    : t('main.usage.minimaxKeyExpired', 'MiniMax API key expired. Replace it in Settings.')
                  : t('main.usage.minimaxRefused', 'MiniMax refused the usage request. Check its API key.')
              )
            windows = mapMiniMax(data, clock(), login.models)
            if (!windows.length)
              refuse(
                'unavailable',
                t('main.usage.minimaxNoModel', 'MiniMax usage data for the configured model was not found.')
              )
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
        if (source !== provider && asked && code !== 'stale' && code !== 'rate-limited')
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
          // Tessel's own words; a key is never echoed, even by mistake.
          error:
            error instanceof ProviderReadError
              ? redact(error.message)
              : t('main.usage.readRetry', 'Could not read provider usage. Try again.'),
          ...(error instanceof ProviderReadError && Number.isFinite(error.retryAfterMs)
            ? { retryAfterMs: error.retryAfterMs }
            : {})
        }
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    }
  }
}
