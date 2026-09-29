// IPC-facing account coordinator. Browser logins are bounded background jobs;
// only account display fields and the browser link cross into the renderer.
import { randomUUID } from 'crypto'
import { ACCOUNT_AUTH_ENV, accountLoginUrl } from './providerLogin'
import { t } from './i18n'

export function createProviderAccounts({ claude, codex, now = Date.now, uuid = randomUUID }) {
  const providers = { claude, codex }
  const jobs = new Map()
  const busy = new Set()
  const text = (value, limit = 200) => (typeof value === 'string' ? value.slice(0, limit) : null)
  function publicAccount(row, system = false) {
    return {
      id: system ? null : text(row?.id, 100),
      label: text(row?.label),
      email: text(row?.email),
      organization: text(row?.organization),
      plan: text(row?.plan),
      status: ['ready', 'missing', 'unknown'].includes(row?.status) ? row.status : 'unknown',
      lastLoginAt: text(row?.lastLoginAt, 40),
      active: !!row?.active
    }
  }
  const providerFor = (provider) => {
    if (!Object.hasOwn(providers, provider)) throw new Error(t('main.accounts.unknownProvider', 'Unknown account provider.'))
    return providers[provider]
  }
  function publicJob(job) {
    return {
      id: job.id,
      provider: job.provider,
      accountId: job.accountId,
      state: job.state,
      url: job.url,
      cancelling: job.controller.signal.aborted && job.state === 'running',
      ...(job.error ? { error: job.error } : {}),
      ...(job.state === 'done'
        ? { result: { ok: true, restartRequired: !!job.restartRequired } }
        : {})
    }
  }
  const failure = (error, fallback) => ({
    ok: false,
    // Backends throw sanitized, human-readable errors. Never accept raw login
    // command stdout as an error; the runner uses fixed messages only.
    error: typeof error?.message === 'string' ? error.message : fallback
  })
  async function mutate(provider, action) {
    if (busy.has(provider))
      return { ok: false, error: t('main.accounts.finishSignInFirst', 'Finish or cancel this provider’s sign-in first.') }
    busy.add(provider)
    try {
      return await action(providerFor(provider))
    } catch (error) {
      return failure(error, t('main.accounts.updateFailed', 'Could not update the account.'))
    } finally {
      busy.delete(provider)
    }
  }
  return {
    async list() {
      const rows = await Promise.all(
        Object.entries(providers).map(async ([provider, service]) => {
          try {
            const row = await service.list()
            return {
              provider,
              selectedId: text(row.selectedId, 100),
              system: publicAccount(row.system, true),
              accounts: (row.accounts || []).map((account) => publicAccount(account)),
              restartRequired: !!row.restartRequired,
              ...(row.error ? { error: text(row.error, 500) } : {})
            }
          } catch {
            return {
              provider,
              selectedId: null,
              accounts: [],
              system: { id: null, label: 'System default', status: 'unknown' },
              error: t('main.accounts.storageUnreadable', 'Account storage could not be read. Existing accounts were kept.')
            }
          }
        })
      )
      return { ok: true, providers: rows, jobs: [...jobs.values()].map(publicJob) }
    },
    startLogin(provider, accountId = null) {
      try {
        providerFor(provider)
      } catch (error) {
        return failure(error)
      }
      if (
        accountId !== null &&
        (typeof accountId !== 'string' || !accountId || accountId.length > 100)
      )
        return { ok: false, error: t('main.accounts.invalidAccount', 'Invalid account.') }
      if (busy.has(provider))
        return { ok: false, error: t('main.accounts.busy', 'This provider already has an operation in progress.') }
      // Completed jobs carry no credential material and are only a UI courtesy.
      for (const [id, job] of jobs)
        if (job.state !== 'running' && (jobs.size >= 12 || now() - job.finishedAt > 15 * 60000))
          jobs.delete(id)
      const job = {
        id: uuid(),
        provider,
        accountId,
        state: 'running',
        url: null,
        controller: new AbortController(),
        startedAt: now()
      }
      jobs.set(job.id, job)
      busy.add(provider)
      const options = {
        signal: job.controller.signal,
        onProgress: (progress) => {
          // Defence at the IPC boundary too; even an alternate backend cannot
          // return arbitrary websites, local files or partial URLs to the UI.
          if (job.state === 'running' && typeof progress?.url === 'string')
            job.url = accountLoginUrl(provider, progress.url + '\n') || job.url
        }
      }
      job.completion = Promise.resolve()
        .then(() =>
          accountId === null
            ? providers[provider].add(options)
            : providers[provider].reauthenticate(accountId, options)
        )
        .then((result) => {
          if (!result?.ok) throw new Error(result?.error || t('main.accounts.signInIncomplete', 'Sign-in did not complete.'))
          job.state = 'done'
          job.restartRequired = result.restartRequired
        })
        .catch((error) => {
          job.state =
            job.controller.signal.aborted && error?.cleanupSafe !== false ? 'cancelled' : 'error'
          job.error = failure(error, t('main.accounts.signInIncomplete', 'Sign-in did not complete.')).error
        })
        .finally(() => {
          job.url = null
          job.finishedAt = now()
          busy.delete(provider)
        })
      return { ok: true, job: publicJob(job) }
    },
    loginStatus(id) {
      const job = jobs.get(id)
      return job
        ? { ok: true, job: publicJob(job) }
        : { ok: false, error: t('main.accounts.sessionNotFound', 'Sign-in session not found.') }
    },
    cancelLogin(id) {
      const job = jobs.get(id)
      if (!job) return { ok: false, error: t('main.accounts.sessionNotFound', 'Sign-in session not found.') }
      if (job.state === 'running') job.controller.abort()
      // Backend cleanup completes after the child exits, never while it could
      // still write credentials into the staging directory.
      return { ok: true, job: publicJob(job) }
    },
    select(provider, id) {
      return mutate(provider, async (service) => {
        const result = await service.select(id)
        return result.ok
          ? {
              ok: true,
              restartRequired: !!result.restartRequired,
              ...(result.warning ? { warning: text(result.warning, 500) } : {})
            }
          : result
      })
    },
    remove(provider, id) {
      return mutate(provider, async (service) => {
        const result = await service.remove(id)
        return result.ok
          ? {
              ok: true,
              restartRequired: !!result.restartRequired,
              ...(result.warning ? { warning: text(result.warning, 500) } : {})
            }
          : result
      })
    },
    async launchEnv(provider, accountId = undefined) {
      if (!Object.hasOwn(providers, provider))
        return { ok: true, env: {}, accountId: null, unsetEnv: [] }
      if (busy.has(provider))
        return { ok: false, error: t('main.accounts.finishBeforeStart', 'Finish or cancel sign-in before starting this agent.') }
      return mutate(provider, async (service) => {
        const result = await service.launchEnv(accountId)
        return result?.ok
          ? { ...result, unsetEnv: result.accountId ? [...ACCOUNT_AUTH_ENV[provider]] : [] }
          : result
      })
    },
    async usageEnv() {
      try {
        return await codex.usageEnv()
      } catch {
        return { ok: false, error: t('main.accounts.codexUnreadable', 'The selected Codex account could not be read.') }
      }
    },
    // Internal only: identity constraints never cross the public account IPC.
    async usageScope(provider, accountId = undefined) {
      try {
        const service = providerFor(provider)
        if (busy.has(provider))
          return { ok: false, error: t('main.accounts.finishBeforeUsage', 'Finish or cancel sign-in before reading usage.') }
        return service.usageScope
          ? await service.usageScope(accountId)
          : await service.usageEnv(accountId)
      } catch {
        return { ok: false, error: t('main.accounts.accountUnreadable', 'The selected provider account could not be read.') }
      }
    },
    async sessionEnv(provider, accountId = undefined) {
      try {
        const service = providerFor(provider)
        return service.sessionEnv
          ? await service.sessionEnv(accountId)
          : await service.usageEnv(accountId)
      } catch {
        return { ok: false, error: t('main.accounts.sessionsUnreadable', 'This account’s saved sessions could not be read.') }
      }
    },
    async close() {
      for (const job of jobs.values()) if (job.state === 'running') job.controller.abort()
      await Promise.allSettled([...jobs.values()].map((job) => job.completion))
    }
  }
}
