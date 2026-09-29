// Quota requests: explicit renderer actions, and the automatic refresh
// (usagePoller.js) once the renderer has configured it. Registering this service
// neither reads credentials nor starts a polling loop.
import { createProviderUsage } from './providerUsage'
import { createResetHistory } from './resetHistory'
import { join } from 'node:path'
import { createExtraProviderUsage } from './extraProviderUsage'
import { createOpencodeUsageReport } from './opencodeUsageReport'
import { t } from './i18n'
import { createUsagePoller } from './usagePoller'
import { USAGE_PROVIDERS, validHiddenUsageProviders } from '../shared/usageProviders'

const LIVE = ['claude', 'codex']

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
  poller: givenPoller
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
      return accounts.cancelLogin(id)
    },
    () => t('main.login.cancelFailed', 'Could not cancel provider sign-in.')
  )
  return usage
}
