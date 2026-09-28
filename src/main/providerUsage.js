// Independent implementation informed by stablyai/orca's rate-limits clients
// (MIT, Lovecast Inc., 2026). These first-party OAuth endpoints are an Orca
// implementation contract, not a documented public API. No OAuth refresh,
// background polling, credential writes, or automatic redemption retries.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

const ENDPOINTS = Object.freeze({
  codex: 'https://chatgpt.com/backend-api/wham/usage',
  credits: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
  consume: 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume',
  claude: 'https://api.anthropic.com/api/oauth/usage'
})
const AUTH_LIMIT = 1024 * 1024
const RESPONSE_LIMIT = 256 * 1024
const TICKET_TTL = 5 * 60 * 1000
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
class UsageError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const fail = (code, message) => {
  throw new UsageError(code, message)
}
const stale = () =>
  fail('stale', 'The selected account or login changed. Refresh usage and confirm again.')
const identity = (value) => ({
  account: text(value?.accountUuid ?? value?.accountId ?? value?.account),
  email: text(value?.emailAddress ?? value?.email)?.toLowerCase() || null,
  organization: text(
    value?.organizationUuid ?? value?.organizationId ?? value?.orgId ?? value?.organization
  )
})
function matches(expected, current) {
  return (
    !['account', 'email', 'organization'].some(
      (key) => expected[key] && current[key] && expected[key] !== current[key]
    ) &&
    !!(
      (expected.account && expected.account === current.account) ||
      (expected.email && expected.email === current.email)
    ) &&
    (!expected.organization || expected.organization === current.organization)
  )
}
function parse(raw, kind = 'auth') {
  try {
    const value = JSON.parse(raw)
    if (object(value)) return value
  } catch {
    /* Never expose JSON/token text. */
  }
  fail(
    kind,
    kind === 'auth'
      ? 'The selected login could not be read safely.'
      : 'The usage service returned an unsupported response.'
  )
}
function timestamp(value, secondsOnly = false) {
  if (value === null || value === undefined || value === '') return null
  let number =
    typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : value
  if (finite(number)) number *= secondsOnly || number < 10_000_000_000 ? 1000 : 1
  else if (!secondsOnly && typeof value === 'string') number = Date.parse(value)
  return finite(number) && number > 0 && number <= 8.64e15 ? number : null
}
function plan(value) {
  const normalized = text(value)?.toLowerCase()
  return [
    'free',
    'plus',
    'pro',
    'max',
    'team',
    'business',
    'enterprise',
    'edu',
    'education'
  ].includes(normalized)
    ? normalized
    : undefined
}
function window(label, used, reset, secondsOnly = false) {
  return finite(used)
    ? { label, usedPct: Math.min(100, Math.max(0, used)), resetsAt: timestamp(reset, secondsOnly) }
    : null
}
function codexWindows(data) {
  const windows = []
  for (const [index, raw] of [
    data.rate_limit?.primary_window,
    data.rate_limit?.secondary_window
  ].entries()) {
    if (!object(raw)) continue
    const seconds = raw.limit_window_seconds
    const label =
      finite(seconds) && seconds > 0
        ? Math.abs(seconds - 18000) <= 60
          ? '5-hour'
          : Math.abs(seconds - 604800) <= 60
            ? 'Weekly'
            : `${Math.ceil(seconds / 60)} min`
        : index === 0
          ? 'Primary window'
          : 'Secondary window'
    const mapped = window(label, raw.used_percent, raw.reset_at, true)
    if (mapped) windows.push(mapped)
  }
  return windows
}
function claudeWindows(data) {
  const windows = []
  for (const [key, label] of [
    ['five_hour', '5-hour'],
    ['seven_day', 'Weekly'],
    ['seven_day_sonnet', 'Sonnet weekly'],
    ['seven_day_opus', 'Opus weekly']
  ]) {
    const raw = data[key]
    const mapped = window(label, raw?.utilization ?? raw?.used_percentage, raw?.resets_at)
    if (mapped) windows.push(mapped)
  }
  const scoped =
    Array.isArray(data.limits) &&
    data.limits.find(
      (value) =>
        value?.kind === 'weekly_scoped' &&
        text(value?.scope?.model?.display_name)?.toLowerCase() === 'fable' &&
        finite(value.percent)
    )
  const fable = scoped
    ? { utilization: scoped.percent, resets_at: scoped.resets_at }
    : (data.fable_weekly ?? data.fable_seven_day ?? data.seven_day_fable)
  const mapped = window(
    'Fable weekly',
    fable?.utilization ?? fable?.used_percentage,
    fable?.resets_at
  )
  if (mapped) windows.push(mapped)
  return windows
}
function credits(data, now) {
  if (!object(data)) return null
  const rows = Array.isArray(data.credits) ? data.credits : null
  const available =
    data.available_count ??
    (rows ? rows.filter((row) => text(row?.status)?.toLowerCase() === 'available').length : null)
  if (!Number.isSafeInteger(available) || available < 0) return null
  const expiries = (rows || [])
    .filter((row) => text(row?.status)?.toLowerCase() === 'available')
    .map((row) => timestamp(row?.expires_at))
    .filter((at) => at !== null)
  const nextExpiresAt = expiries.length ? Math.min(...expiries) : null
  return {
    availableCount: available,
    nextExpiresAt,
    eligible: available > 0 && (nextExpiresAt === null || nextExpiresAt > now)
  }
}

async function inspect(file) {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root
  const parts = path.relative(current, absolute).split(path.sep).filter(Boolean)
  let stat
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    stat = await fs.lstat(current)
    if (
      stat.isSymbolicLink() ||
      (index === parts.length - 1 ? !stat.isFile() || stat.nlink > 1 : !stat.isDirectory())
    )
      throw new Error('Unsafe auth path')
  }
  if (fold(await fs.realpath(absolute)) !== fold(absolute)) throw new Error('Unsafe auth path')
  return stat
}
async function boundedCredentialRead(file) {
  const before = await inspect(file)
  if (before.size > AUTH_LIMIT) throw new Error('Auth size limit')
  const handle = await fs.open(file, 'r')
  try {
    const opened = await handle.stat()
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile())
      throw new Error('Auth changed')
    const buffer = Buffer.alloc(AUTH_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    const after = await inspect(file)
    if (
      length > AUTH_LIMIT ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error('Auth changed')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await handle.close()
  }
}

export function createProviderUsage({
  accounts,
  home = os.homedir(),
  env = process.env,
  request = globalThis.fetch,
  readFile = boundedCredentialRead,
  clock = Date.now,
  history,
  log,
  timeoutMs = 10000
} = {}) {
  const generation = { codex: 0, claude: 0 }
  const readSequence = { codex: 0, claude: 0 }
  const tickets = new Map()
  const redeeming = new Map()
  const controllers = new Map()
  const timeout = finite(timeoutMs) ? Math.max(1, Math.min(30000, timeoutMs)) : 10000
  function validate(provider, accountId) {
    if (!['codex', 'claude'].includes(provider))
      fail('validation', 'This provider does not support live usage.')
    if (
      accountId !== null &&
      (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId))
    )
      fail('validation', 'Choose an explicit account before reading usage.')
  }
  async function scope(provider, accountId) {
    validate(provider, accountId)
    const epoch = generation[provider]
    const state = await accounts.list()
    const row = state?.providers?.find((item) => item.provider === provider)
    if (
      !state?.ok ||
      !row ||
      row.error ||
      row.selectedId !== accountId ||
      state.jobs?.some((job) => job.provider === provider && job.state === 'running')
    )
      stale()
    const account =
      accountId === null ? row.system : row.accounts?.find((item) => item.id === accountId)
    if (!account || account.status !== 'ready')
      fail('auth', 'The selected account has no verified OAuth login. Check AI provider accounts.')
    const resolved = accounts.usageScope
      ? await accounts.usageScope(provider, accountId)
      : await accounts.sessionEnv(provider, accountId)
    if (!resolved?.ok || resolved.accountId !== accountId || epoch !== generation[provider]) stale()
    const effective = { ...env, ...resolved.env }
    const directory =
      provider === 'codex'
        ? effective.CODEX_HOME || path.join(home, '.codex')
        : effective.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
    if (typeof directory !== 'string' || !path.isAbsolute(directory))
      fail('auth', 'The selected login location is unavailable.')
    const authPath = path.join(
      path.resolve(directory),
      provider === 'codex' ? 'auth.json' : '.credentials.json'
    )
    const configPath = effective.CLAUDE_CONFIG_DIR
      ? path.join(directory, '.claude.json')
      : path.join(home, '.claude.json')
    return {
      provider,
      accountId,
      epoch,
      authPath,
      configPath,
      expectedIdentity: resolved.expectedIdentity,
      accountLabel:
        text(account.label) || (accountId === null ? 'System default' : 'Saved account'),
      plan: plan(account.plan)
    }
  }
  async function localRead(file) {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      fail('auth', 'The selected login could not be read safely.')
    }
    if (!(typeof raw === 'string' || Buffer.isBuffer(raw)) || Buffer.byteLength(raw) > AUTH_LIMIT)
      fail('auth', 'The selected login could not be read safely.')
    return String(raw)
  }
  async function auth(snapshot) {
    const raw = await localRead(snapshot.authPath)
    const parsed = parse(raw)
    const accessToken =
      snapshot.provider === 'codex'
        ? parsed.tokens?.access_token
        : parsed.claudeAiOauth?.accessToken
    if (typeof accessToken !== 'string' || !/^[\x21-\x7e]{1,16384}$/.test(accessToken))
      fail(
        'auth',
        'The selected account has no usable OAuth token. Sign in again with the provider CLI.'
      )
    let who = null
    if (snapshot.provider === 'claude' && snapshot.accountId !== null) {
      const expected = identity(snapshot.expectedIdentity)
      who = identity(parse(await localRead(snapshot.configPath)).oauthAccount)
      const tokenIdentity = identity(parsed.claudeAiOauth)
      const tokenConflict = ['account', 'email', 'organization'].some(
        (key) =>
          tokenIdentity[key] &&
          ((who[key] && tokenIdentity[key] !== who[key]) ||
            (expected[key] && tokenIdentity[key] !== expected[key]))
      )
      if (!matches(expected, who) || tokenConflict)
        fail(
          'identity',
          'Claude runtime authentication does not match this selected account. Select the account again before refreshing usage.'
        )
    }
    const headers =
      snapshot.provider === 'codex'
        ? {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': 'codex-cli',
            'OpenAI-Beta': 'codex-1',
            originator: 'Codex Desktop'
          }
        : {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': 'claude-code/2.1.0'
          }
    if (snapshot.provider === 'codex' && parsed.tokens?.account_id !== undefined) {
      const id = parsed.tokens.account_id
      if (typeof id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(id))
        fail('auth', 'The selected login has an invalid account identity.')
      headers['ChatGPT-Account-Id'] = id
    }
    return {
      headers,
      fingerprint: createHash('sha256').update(raw).update(JSON.stringify(who)).digest('hex')
    }
  }
  async function stable(snapshot, fingerprint) {
    const current = await scope(snapshot.provider, snapshot.accountId)
    if (
      current.epoch !== snapshot.epoch ||
      fold(current.authPath) !== fold(snapshot.authPath) ||
      current.configPath !== snapshot.configPath
    )
      stale()
    const login = await auth(current)
    if (login.fingerprint !== fingerprint || current.epoch !== generation[current.provider]) stale()
    return login
  }
  async function network(snapshot, url, headers, body, post = false) {
    if (generation[snapshot.provider] !== snapshot.epoch) stale()
    const controller = new AbortController()
    controllers.set(controller, { provider: snapshot.provider, post })
    let timer
    try {
      const work = (async () => {
        const response = await request(url, {
          method: post ? 'POST' : 'GET',
          headers: { ...headers, ...(post ? { 'Content-Type': 'application/json' } : {}) },
          ...(post ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: controller.signal
        })
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => {})
          fail('timeout', 'The usage request timed out.')
        }
        if (
          response.redirected ||
          (response.url && response.url !== url) ||
          (response.status >= 300 && response.status < 400)
        ) {
          await response.body?.cancel().catch(() => {})
          fail('redirect', 'The usage endpoint redirected; the request was refused.')
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          fail(
            response.status === 401 || response.status === 403 ? 'auth' : 'upstream',
            response.status === 401 || response.status === 403
              ? 'Usage access was refused. Sign in again with the provider CLI; no token was refreshed.'
              : 'The usage service is unavailable. Try again later.'
          )
        }
        if (Number(response.headers?.get('content-length')) > RESPONSE_LIMIT) {
          await response.body?.cancel().catch(() => {})
          fail('response', 'The usage response exceeded its size limit.')
        }
        const reader = response.body?.getReader()
        if (!reader) fail('response', 'The usage service returned an empty response.')
        const chunks = []
        let length = 0
        try {
          while (true) {
            const item = await reader.read()
            if (item.done) break
            length += item.value.byteLength
            if (length > RESPONSE_LIMIT)
              fail('response', 'The usage response exceeded its size limit.')
            chunks.push(Buffer.from(item.value))
          }
          return parse(Buffer.concat(chunks).toString('utf8'), 'response')
        } finally {
          await reader.cancel().catch(() => {})
        }
      })()
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new UsageError('timeout', 'The usage request timed out.'))
        }, timeout)
      })
      return await Promise.race([work, deadline])
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
    }
  }
  const errorResult = (error, extra = {}) => ({
    ok: false,
    ...extra,
    code: error instanceof UsageError ? error.code : 'network',
    error: error instanceof UsageError ? error.message : 'The usage request could not be completed.'
  })
  function mint(snapshot, fingerprint, credit, windows) {
    if (redeeming.has(`${snapshot.provider}:${snapshot.accountId}`)) return null
    for (const [key, value] of tickets) {
      if (value.expiresAt <= clock()) tickets.delete(key)
      else if (value.snapshot.provider === snapshot.provider && !value.promise) {
        if (
          value.snapshot.accountId === snapshot.accountId &&
          value.snapshot.epoch === snapshot.epoch &&
          value.fingerprint === fingerprint
        )
          return key
        tickets.delete(key)
      }
    }
    if (tickets.size >= 32) return null
    const resetToken = randomBytes(24).toString('hex')
    tickets.set(resetToken, {
      snapshot: { ...snapshot },
      fingerprint,
      credits: credit,
      windows,
      expiresAt: clock() + TICKET_TTL,
      requestId: randomUUID(),
      promise: null
    })
    return resetToken
  }
  async function redeem(ticket) {
    let sent = false
    let before = ticket.credits?.availableCount ?? null
    let after = null
    const at = clock()
    const { snapshot } = ticket
    const audit = (outcome, extra = {}) =>
      history?.record({
        id: ticket.requestId,
        at,
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        accountLabel: snapshot.accountLabel,
        windows: ticket.windows,
        creditsBefore: before,
        creditsAfter: after,
        outcome,
        ...(outcome !== 'pending' ? { completedAt: clock() } : {}),
        ...extra
      })
    const finish = (result) => {
      try {
        audit(
          {
            reset: 'reset',
            nothingToReset: 'nothing_to_reset',
            noCredit: 'no_credit',
            alreadyRedeemed: 'already_redeemed'
          }[result.outcome] || 'error',
          { uncertain: result.uncertain, code: result.code }
        )
      } catch {
        result.historyError = 'The reset result could not be saved to local history.'
        try {
          log?.warn(
            'reset',
            'Could not save reset result; do not retry the reset to repair history.'
          )
        } catch {
          /* best effort */
        }
      }
      return result
    }
    try {
      // Write ahead: a crash after the POST leaves a visible uncertain attempt.
      // Refuse consumption if its audit cannot be saved.
      try {
        audit('pending')
      } catch {
        fail('history', 'Could not save reset history. No reset was sent.')
      }
      if (ticket.expiresAt <= clock() || snapshot.epoch !== generation[snapshot.provider]) stale()
      const login = await stable(snapshot, ticket.fingerprint)
      const available = credits(await network(snapshot, ENDPOINTS.credits, login.headers), clock())
      if (!available)
        fail(
          'response',
          'Reset availability could not be verified. Refresh usage before trying again.'
        )
      before = available.availableCount
      if (!available.eligible) {
        after = before
        return finish({
          ok: true,
          provider: snapshot.provider,
          accountId: snapshot.accountId,
          outcome: 'noCredit'
        })
      }
      const latest = await stable(snapshot, ticket.fingerprint)
      if (ticket.expiresAt <= clock()) stale()
      sent = true
      const data = await network(
        snapshot,
        ENDPOINTS.consume,
        latest.headers,
        { redeem_request_id: ticket.requestId },
        true
      )
      const outcomes = {
        reset: 'reset',
        nothing_to_reset: 'nothingToReset',
        no_credit: 'noCredit',
        already_redeemed: 'alreadyRedeemed'
      }
      if (!Object.hasOwn(outcomes, data.code))
        fail('response', 'The reset service returned an unknown outcome.')
      await stable(snapshot, ticket.fingerprint)
      if (history) {
        // Optional observation after the explicit reset. Never infer before - 1.
        try {
          const current = await network(snapshot, ENDPOINTS.credits, latest.headers)
          await stable(snapshot, ticket.fingerprint)
          after = credits(current, clock())?.availableCount ?? null
        } catch {
          /* result is known; a missing after-reading must not change it */
        }
      }
      return finish({
        ok: true,
        provider: snapshot.provider,
        accountId: snapshot.accountId,
        outcome: outcomes[data.code]
      })
    } catch (error) {
      return finish(
        sent
          ? {
              ok: false,
              provider: snapshot.provider,
              accountId: snapshot.accountId,
              uncertain: true,
              error:
                'The reset may have been applied to the confirmed account. Refresh usage before taking any further action.'
            }
          : errorResult(error, { provider: snapshot.provider, accountId: snapshot.accountId })
      )
    }
  }
  return {
    // Explicit opening/refresh only. Orca exposes credit status, granted and
    // expiry dates; these are not a dated redemption ledger.
    async creditHistory({ provider, accountId } = {}) {
      try {
        if (provider !== 'codex') fail('validation', 'Credit history is available for Codex only.')
        const snapshot = await scope(provider, accountId)
        const login = await auth(snapshot)
        const data = await network(snapshot, ENDPOINTS.credits, login.headers)
        await stable(snapshot, login.fingerprint)
        if (!Array.isArray(data.credits))
          return { ok: true, provider, accountId, available: false, entries: [] }
        const entries = data.credits.slice(0, 500).map((row) => ({
          status: ['available', 'consumed', 'redeemed', 'used', 'expired'].includes(
            text(row?.status)?.toLowerCase()
          )
            ? row.status.trim().toLowerCase()
            : 'unknown',
          grantedAt: timestamp(row?.granted_at),
          expiresAt: timestamp(row?.expires_at)
        }))
        return {
          ok: true,
          provider,
          accountId,
          available: true,
          observedAt: clock(),
          entries,
          truncated: data.credits.length > entries.length
        }
      } catch (error) {
        return errorResult(error)
      }
    },
    async read({ provider, accountId } = {}) {
      try {
        validate(provider, accountId)
        const sequence = ++readSequence[provider]
        const snapshot = await scope(provider, accountId)
        const login = await auth(snapshot)
        const data = await network(snapshot, ENDPOINTS[provider], login.headers)
        const windows = provider === 'codex' ? codexWindows(data) : claudeWindows(data)
        if (!windows.length && !(provider === 'codex' && typeof data.plan_type === 'string'))
          fail('response', 'The usage service returned no recognized usage windows.')
        let resetCredits = null
        let resetCreditsError = null
        if (provider === 'codex') {
          resetCredits = credits(data.rate_limit_reset_credits, clock())
          if (
            !resetCredits ||
            (resetCredits.availableCount > 0 && resetCredits.nextExpiresAt === null)
          ) {
            try {
              const fresh = credits(
                await network(snapshot, ENDPOINTS.credits, login.headers),
                clock()
              )
              if (!fresh) throw new Error('Invalid credit response')
              resetCredits = fresh
            } catch {
              resetCreditsError =
                'Reset credit availability could not be refreshed. Refresh usage before resetting.'
            }
          }
        }
        await stable(snapshot, login.fingerprint)
        if (sequence !== readSequence[provider]) stale()
        const result = {
          ok: true,
          provider,
          accountId,
          source: 'live',
          observedAt: clock(),
          windows
        }
        const selectedPlan = plan(data.plan_type) || snapshot.plan
        if (selectedPlan) result.plan = selectedPlan
        if (resetCreditsError) result.resetCreditsError = resetCreditsError
        if (provider === 'codex' && resetCredits) {
          const resetToken =
            resetCredits.eligible && !resetCreditsError
              ? mint(snapshot, login.fingerprint, resetCredits, windows)
              : null
          result.resetCredits = { ...resetCredits, eligible: resetCredits.eligible && !!resetToken }
          if (resetToken) result.resetToken = resetToken
        }
        return result
      } catch (error) {
        return errorResult(error, {
          provider: ['codex', 'claude'].includes(provider) ? provider : null,
          accountId: typeof accountId === 'string' ? accountId : null
        })
      }
    },
    async redeemReset({ provider, accountId, resetToken, confirmed } = {}) {
      try {
        validate(provider, accountId)
        if (provider !== 'codex' || confirmed !== true)
          fail('confirmation', 'Confirm a Codex reset before consuming a reset credit.')
        const ticket = typeof resetToken === 'string' ? tickets.get(resetToken) : null
        if (
          !ticket ||
          ticket.snapshot.provider !== provider ||
          ticket.snapshot.accountId !== accountId ||
          ticket.snapshot.epoch !== generation[provider] ||
          ticket.expiresAt <= clock()
        )
          stale()
        if (!ticket.promise) {
          const key = `${provider}:${accountId}`
          if (redeeming.has(key))
            fail('busy', 'A reset for this account is already in progress. Wait for its result.')
          redeeming.set(key, ticket)
          ticket.promise = redeem(ticket).finally(() => {
            if (redeeming.get(key) === ticket) redeeming.delete(key)
          })
        }
        return await ticket.promise
      } catch (error) {
        const result = errorResult(error)
        if (['codex', 'claude'].includes(provider)) {
          try {
            history?.record({
              id: randomUUID(),
              at: clock(),
              completedAt: clock(),
              provider,
              accountId,
              accountLabel: accountId === null ? 'System default' : 'Unverified account',
              outcome: 'error',
              code: result.code
            })
          } catch {
            result.historyError = 'The reset result could not be saved to local history.'
          }
        }
        return result
      }
    },
    invalidate(provider) {
      const targets =
        provider === undefined
          ? ['codex', 'claude']
          : ['codex', 'claude'].includes(provider)
            ? [provider]
            : []
      for (const target of targets) {
        generation[target]++
        readSequence[target]++
      }
      for (const [key, ticket] of tickets)
        if (targets.includes(ticket.snapshot.provider)) tickets.delete(key)
      // Do not suggest a consuming request was undone by switching accounts.
      for (const [controller, item] of controllers)
        if (!item.post && targets.includes(item.provider)) controller.abort()
    }
  }
}
