// Background agent updates reuse the pane flow's safety: the same job, the
// same stop / wait / relaunch (stopThenRetry + relaunchPaused), whichever way
// the update runs. Checked in App.vue's source (the flow needs the whole app).
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { updateFailureText } from '../agentUpdateErrors'

const src = fs.readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.vue'), 'utf8')
const body = (name) => {
  const at = src.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  expect(at, name).toBeGreaterThan(0)
  return src.slice(at, src.indexOf('\n}\n', at) >= 0 ? src.indexOf('\n}\n', at) : src.indexOf('\r\n}\r\n', at))
}

describe('background agent updates in App.vue', () => {
  it('the stop-and-retry of files in use runs the update the way it was started', () => {
    expect(body('stopAndRetryUpdate')).toMatch(/runUpdate: \(\) => runUpdate\(job\.agentId\)/)
    expect(body('runUpdate')).toMatch(/job\.via === 'pane' \? runUpdatePane\(agentId\) : runUpdateBackground\(agentId\)/)
  })
  it('a background run ends in the same result handler as a pane (relaunch, restart when idle)', () => {
    const bg = body('runUpdateBackground')
    expect(bg).toMatch(/api\s*\.run\(\{ agentId/)
    expect(bg).toMatch(/onAgentUpdateResult\(agentId, r/)
    const res = body('onAgentUpdateResult')
    expect(res).toMatch(/relaunchPaused\(job/)
    expect(res).toMatch(/restartAfterUpdate\[id\]/)
  })
  it('files in use: asked with Close and reopen them, which starts the existing waiting-stop flow', () => {
    const res = body('onAgentUpdateResult')
    expect(res).toMatch(/closeAndReopenForUpdate\(agentId\)/)
    const reopen = body('closeAndReopenForUpdate')
    expect(reopen).toMatch(/job\.phase = 'waiting-stop'/)
    expect(reopen).toMatch(/agentUpdateTick\(\)/)
    // Never by image name: only Tessel's own panes, through the pty host.
    expect(src).not.toMatch(/taskkill[^\n]*\/IM/i)
  })
  it('explains failures in plain words', () => {
    expect(updateFailureText('in-use', 'Claude Code', { panes: 2 })).toMatch(/running in other panes.*close and reopen them/)
    expect(updateFailureText('in-use', 'Claude Code', { panes: 0 })).toMatch(/outside Tessel/)
    expect(updateFailureText('network', 'X')).toMatch(/network/)
    expect(updateFailureText('permission', 'X')).toMatch(/administrator/)
    expect(updateFailureText('not-found', 'X')).toMatch(/not found/)
  })
})
