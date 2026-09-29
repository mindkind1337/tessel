// Quota requests are explicit renderer actions. Registering this service neither
// reads credentials nor starts a polling loop.
import { createProviderUsage } from './providerUsage'
import { createResetHistory } from './resetHistory'
import { join } from 'node:path'
import { createExtraProviderUsage } from './extraProviderUsage'
import { createOpencodeUsageReport } from './opencodeUsageReport'
import { t } from './i18n'

export function registerProviderUsage({
  ipcMain,
  accounts,
  service,
  userData,
  log,
  listAgents = async () => [],
  opencodeReport = createOpencodeUsageReport()
}) {
  const history = userData
    ? createResetHistory({ file: join(userData, 'reset-history.json'), log })
    : null
  const usage = service || createProviderUsage({ accounts, history, log })
  const extra = createExtraProviderUsage({ listAgents })
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
    (query) =>
      ['claude', 'codex'].includes(query.provider) ? usage.read(query) : extra.read(query),
    () => t('main.usage.readFailed', 'Could not read provider usage.')
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
        return accounts[name](provider, name === 'startLogin' && id === undefined ? null : id)
      },
      () => t('main.accounts.providerUpdateFailed', 'Could not update the provider account.')
    )
  }
  handle(
    'accounts:cancelLogin',
    (id) => {
      usage.invalidate()
      return accounts.cancelLogin(id)
    },
    () => t('main.login.cancelFailed', 'Could not cancel provider sign-in.')
  )
  return usage
}
