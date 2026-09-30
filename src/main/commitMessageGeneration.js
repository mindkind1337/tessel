import { t } from './i18n'
import { resolve } from 'path'

function rootKey(root) {
  if (typeof root !== 'string' || !root) return ''
  const key = resolve(root)
  return process.platform === 'win32' ? key.toLowerCase() : key
}

// Coordinate the preparation and the agent run behind the two SCM IPC calls.
export function createCommitMessageGeneration({ scm, runHeadless, cancelHeadless }) {
  const pending = new Map()
  const stopped = () => ({ ok: false, cancelled: true, error: t('main.agents.stopped', 'Stopped.') })
  function stop(current) {
    if (current.cancelled) return { ok: true }
    current.cancelled = true
    if (current.top) cancelHeadless(current.top)
    return { ok: true }
  }
  return {
    async generate(q = {}) {
      const key = rootKey(q.root)
      if (pending.has(key)) return { ok: false, error: t('main.agents.alreadyGenerating', 'A message is already being generated.') }
      const current = { key, top: null, cancelled: false }
      pending.set(key, current)
      try {
        const d = await scm.scmStagedDiff(q)
        if (current.cancelled) return stopped()
        if (!d.ok) return d
        current.top = d.top
        const res = await runHeadless(q.agent, scm.commitPrompt(d.diff), { cwd: d.top, key: d.top })
        if (current.cancelled) return stopped()
        if (!res.ok) return res
        const message = scm.cleanGeneratedMessage(res.text)
        return message ? { ok: true, message } : { ok: false, error: t('main.error.noCommitMessage', 'The agent gave no message.') }
      } finally {
        pending.delete(key)
      }
    },
    async cancel(q = {}) {
      const current = pending.get(rootKey(q.root))
      if (current) return stop(current)
      // Keep cancellation from another folder in the same repository working.
      // A slow lookup must never cancel a generation started after this request.
      const candidates = [...pending.values()]
      const r = await scm.repoOf(q.root)
      if (r.error) return { ok: false }
      const target = candidates.find((run) => run.top && rootKey(run.top) === rootKey(r.top) && pending.get(run.key) === run)
      return target ? stop(target) : { ok: false }
    }
  }
}
