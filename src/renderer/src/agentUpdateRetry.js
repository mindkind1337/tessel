// Agent update whose files were in use by its running panes: stop those
// panes, wait until their processes have REALLY ended (not just their
// terminals forgotten: see src/main/processTree.js), then install again.
// If one does not end in time, nothing is retried and nothing relaunched:
// the panes stay stopped (their conversation kept) for you to restart.
//
// job: the update job (phase, retried, paused, error are set here)
// ids: the panes to stop (each checked safe to stop at this moment)
// deps:
//   stopAndWait(ids, timeoutMs) -> { ok, stuck? } (every process ended?)
//   runUpdate() -> true when the install pane opened
//   relaunch(job, what): restart job.paused in place, conversation resumed
//   release(ids): the panes may be restarted again (by you)
//   onStuck({ stuck, stopped }): tell the user
//   log(level, text), label(id)
// -> 'retried' | 'stuck' | 'failed'
import { t } from './i18n'

export const STOP_WAIT_MS = 15000

export async function stopThenRetry(job, ids, deps) {
  const { stopAndWait, runUpdate, relaunch, release, onStuck, log = () => {}, label = String, timeoutMs = STOP_WAIT_MS } = deps
  const stopped = [...ids]
  job.phase = 'retrying'
  job.retried = true
  job.paused = stopped
  log('info', `${job.name}: stopping ${stopped.map(label).join(', ')} to update`) // i18n-ignore
  let res = null
  try {
    res = await stopAndWait(stopped, timeoutMs)
  } catch {
    res = null
  }
  if (!res || !res.ok) {
    const stuck = res && Array.isArray(res.stuck) && res.stuck.length ? res.stuck.filter((id) => stopped.includes(id)) : []
    job.phase = 'failed'
    job.error = 'its panes could not be stopped cleanly'
    job.paused = []
    job.stopped = stopped
    release(stopped)
    log('error', `${job.name}: ${(stuck.length ? stuck : stopped).map(label).join(', ')} did not stop in time; update not run`) // i18n-ignore
    onStuck({ stuck: stuck.length ? stuck : stopped, stopped })
    return 'stuck'
  }
  log('info', `${job.name}: ${stopped.map(label).join(', ')} stopped; updating`) // i18n-ignore
  const ok = await runUpdate()
  if (!ok) {
    job.phase = 'failed'
    job.error = 'could not open a pane'
    await relaunch(job, 'resumed (not updated)')
    return 'failed'
  }
  return 'retried'
}

// "#1 OpenCode could not be stopped cleanly; update not run. Restart it when
// you are ready."
export function stuckMessage({ stuck, stopped }, label = String) {
  const names = stuck.map(label).join(', ')
  const others = stopped.filter((id) => !stuck.includes(id)).map(label)
  const n = stuck.length + others.length
  return (
    t('agentUpdateRetry.stuck', '{{names}} could not be stopped cleanly; update not run.', { names }) +
    (others.length ? ' ' + (others.length === 1
      ? t('agentUpdateRetry.other', '{{names}} is stopped too.', { names: others.join(', ') })
      : t('agentUpdateRetry.others', '{{names}} are stopped too.', { names: others.join(', ') })) : '') +
    ' ' + (n === 1
      ? t('agentUpdateRetry.restartOne', 'Restart it when you are ready.')
      : t('agentUpdateRetry.restartMany', 'Restart them when you are ready.'))
  )
}
