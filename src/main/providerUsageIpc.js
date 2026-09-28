// Quota requests are explicit renderer actions. Registering this service neither
// reads credentials nor starts a polling loop.
import { createProviderUsage } from './providerUsage'

export function registerProviderUsage({ ipcMain, accounts, service }) {
  const usage = service || createProviderUsage({ accounts })
  const handle = (name, action, error) => {
    ipcMain.handle(name, async (_event, query) => {
      try {
        return await action(query || {})
      } catch {
        // Upstream errors may contain request headers. Never cross IPC with them.
        return { ok: false, error }
      }
    })
  }
  handle('providerUsage:read', (query) => usage.read(query), 'Could not read provider usage.')
  handle(
    'providerUsage:redeemReset',
    (query) => usage.redeemReset(query),
    'Could not confirm the reset result. Refresh usage before trying again.'
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
      'Could not update the provider account.'
    )
  }
  handle(
    'accounts:cancelLogin',
    (id) => {
      usage.invalidate()
      return accounts.cancelLogin(id)
    },
    'Could not cancel provider sign-in.'
  )
  return usage
}
