// Quota requests: explicit renderer actions, and the automatic refresh
// (usagePoller.js) once the renderer has configured it. Registering this service
// neither reads credentials nor starts a polling loop.
import { createProviderUsage } from './providerUsage'
import { createResetHistory } from './resetHistory'
import { join, resolve, isAbsolute } from 'node:path'
import os from 'node:os'
import { createExtraProviderUsage } from './extraProviderUsage'
import { createOpencodeUsageReport } from './opencodeUsageReport'
import { t } from './i18n'
import { createUsagePoller } from './usagePoller'
import { USAGE_PROVIDERS, validHiddenUsageProviders } from '../shared/usageProviders'

const LIVE = ['claude', 'codex']
const HOME_VARS = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
// How long the shown account's folder is remembered between live readings.
const LIVE_SCOPE_TTL_MS = 30 * 1000

// A login folder, compared as the file system does (Windows: any case).
function folderKey(dir, platform = process.platform) {
  if (typeof dir !== 'string' || !dir || !isAbsolute(dir)) return null
  const full = resolve(dir) // no trailing separator
  return platform === 'win32' ? full.toLowerCase() : full
}

// The folder a provider keeps its login in, from a set of variables.
export function loginFolder(provider, env, { home = os.homedir(), base = process.env } = {}) {
  const name = HOME_VARS[provider]
  if (!name) return null
  const own = env && typeof env[name] === 'string' && env[name] ? env[name] : null
  const inherited = typeof base?.[name] === 'string' && base[name] ? base[name] : null
  return folderKey(own || inherited || join(home, provider === 'codex' ? '.codex' : '.claude'))
}

// Live readings from chats (sessions.js onRateLimit) for the usage poller:
// kept only when the chat runs under the account the indicator shows (same
// login folder) and started after the last account change.
export function createLiveUsageIngest({ accounts, poller, clock = Date.now, home, base, log } = {}) {
  const scopes = new Map() // provider -> { at, accountId, folder } | pending promise
  const changedAt = { claude: 0, codex: 0 }
  async function shown(provider) {
    const cached = scopes.get(provider)
    if (cached && clock() - cached.at < LIVE_SCOPE_TTL_MS) return cached
    const state = await accounts.list()
    const row = state?.ok ? state.providers?.find((item) => item.provider === provider) : null
    if (!row || row.error) return null
    const accountId = row.selectedId ?? null
    const account =
      accountId === null ? row.system : row.accounts?.find((item) => item.id === accountId)
    if (account?.status !== 'ready') return null
    const resolved = accounts.usageScope
      ? await accounts.usageScope(provider, accountId)
      : await accounts.sessionEnv?.(provider, accountId)
    if (!resolved?.ok || (resolved.accountId ?? null) !== accountId) return null
    const folder = loginFolder(provider, resolved.env || {}, { home, base })
    if (!folder) return null
    const scope = { at: clock(), accountId, folder }
    scopes.set(provider, scope)
    return scope
  }
  return {
    // An account was switched (or a sign-in changed): nothing older counts.
    changed(provider) {
      const now = clock()
      for (const id of provider === undefined ? Object.keys(changedAt) : [provider]) {
        if (id in changedAt) {
          changedAt[id] = now
          scopes.delete(id)
        }
      }
    },
    async ingest({ provider, env, since, rateLimit } = {}) {
      if (!LIVE.includes(provider)) return null
      const began = clock()
      // A chat started before the last switch may run under the old login.
      if (!Number.isFinite(since) || since < changedAt[provider]) return null
      const folder = loginFolder(provider, env && typeof env === 'object' ? env : {}, { home, base })
      if (!folder) return null
      let scope
      try {
        scope = await shown(provider)
      } catch {
        return null
      }
      // Another account's chat, or a switch while the account was read.
      if (!scope || scope.folder !== folder || changedAt[provider] > began) {
        if (scope) log?.info?.('usage', `live ${provider} reading ignored: another account`) // i18n-ignore
        return null
      }
      return poller.ingest?.(provider, scope.accountId, rateLimit) ?? null
    }
  }
}

export function registerProviderUsage({
  ipcMain,
  accounts,
  service,
  userData,
  log,
  listAgents = async () => [],
  opencodeReport = createOpencodeUsageReport(),
  send = () => {},
  getWindow = () => null,
  poller: givenPoller,
  // Receives the function that takes the chats' live readings.
  onLiveIngest = null
}) {
  const history = userData
    ? createResetHistory({ file: join(userData, 'reset-history.json'), log })
    : null
  const usage = service || createProviderUsage({ accounts, history, log })
  const extra = createExtraProviderUsage({ listAgents })
  const readOne = (query) => (LIVE.includes(query.provider) ? usage.read(query) : extra.read(query))
  // The providers the automatic refresh reads: shown in the Usage menu, with a
  // login found (Claude and Codex: their selected account is signed in).
  async function autoTargets(hidden) {
    const caps = await extra.capabilities()
    const ids = (caps?.providers || [])
      .filter((p) => p.quota && !hidden.includes(p.id))
      .map((p) => p.id)
    let state = null
    const out = []
    for (const provider of ids) {
      if (!LIVE.includes(provider)) {
        out.push({ provider, accountId: null })
        continue
      }
      state ??= await accounts.list()
      const row = state?.ok ? state.providers?.find((item) => item.provider === provider) : null
      if (!row || row.error) continue
      const accountId = row.selectedId ?? null
      const account =
        accountId === null ? row.system : row.accounts?.find((item) => item.id === accountId)
      if (account?.status === 'ready') out.push({ provider, accountId })
    }
    return out
  }
  const poller =
    givenPoller ||
    createUsagePoller({
      read: readOne,
      targets: autoTargets,
      send: (result) => send('providerUsage:update', result),
      getWindow,
      log
    })
  const live = createLiveUsageIngest({ accounts, poller, log })
  try {
    onLiveIngest?.((event) => live.ingest(event))
  } catch {
    /* no live readings then */
  }
  const known = (query) =>
    USAGE_PROVIDERS.some((p) => p.id === query.provider) &&
    (query.accountId === null || query.accountId === undefined || typeof query.accountId === 'string')
  // error: a function, so the message is in the language of the moment.
  const handle = (name, action, error) => {
    ipcMain.handle(name, async (_event, query) => {
      try {
        return await action(query || {})
      } catch {
        // Upstream errors may contain request headers. Never cross IPC with them.
        return { ok: false, error: typeof error === 'function' ? error() : error }
      }
    })
  }
  handle(
    'providerUsage:capabilities',
    () => extra.capabilities(),
    () => t('main.usage.detectFailed', 'Could not detect usage providers.')
  )
  handle(
    'providerUsage:read',
    // Shares a read of the same provider already in flight (automatic or not).
    (query) => (known(query) ? poller.read(query) : readOne(query)),
    () => t('main.usage.readFailed', 'Could not read provider usage.')
  )
  // Settings: the providers hidden from the Usage menu and the interval (0 = off).
  handle(
    'providerUsage:autoRefresh',
    (query) =>
      poller.configure({
        hidden: validHiddenUsageProviders(query.hidden),
        intervalMs: query.intervalMs === 0 ? 0 : Number(query.intervalMs)
      }),
    () => t('main.usage.autoRefreshFailed', 'Could not set the usage refresh.')
  )
  // OpenCode's usage report (tokens and recorded cost), from its own
  // databases on this computer. Only its filter errors (Tessel's own words)
  // cross IPC.
  ipcMain.handle('usage:opencodeReport', async (_event, query) => {
    try {
      return await opencodeReport(query || {})
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : t('main.usage.opencodeReportFailed', 'Could not read OpenCode usage.')
      }
    }
  })
  handle(
    'providerUsage:resetHistory',
    (query) => history?.read(query) || { ok: false, error: t('main.reset.historyUnavailable', 'Local reset history is unavailable.') },
    () => t('main.reset.historyReadFailed', 'Could not read reset history.')
  )
  handle(
    'providerUsage:creditHistory',
    (query) => usage.creditHistory(query),
    () => t('main.usage.creditHistoryFailed', 'Could not read provider credit history.')
  )
  handle(
    'providerUsage:redeemReset',
    (query) => usage.redeemReset(query),
    () => t('main.reset.confirmFailed', 'Could not confirm the reset result. Refresh usage before trying again.')
  )
  // Revoke any outstanding confirmation before a mutation starts, including an
  // A -> B -> A account switch. Failed mutations still safely revoke tickets.
  for (const name of ['select', 'remove', 'startLogin']) {
    handle(
      `accounts:${name}`,
      ({ provider, id }) => {
        usage.invalidate(provider)
        poller.forget(provider)
        live.changed(provider)
        return accounts[name](provider, name === 'startLogin' && id === undefined ? null : id)
      },
      () => t('main.accounts.providerUpdateFailed', 'Could not update the provider account.')
    )
  }
  handle(
    'accounts:cancelLogin',
    (id) => {
      usage.invalidate()
      poller.forget()
      live.changed()
      return accounts.cancelLogin(id)
    },
    () => t('main.login.cancelFailed', 'Could not cancel provider sign-in.')
  )
  return usage
}
