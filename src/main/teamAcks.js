// Messages an agent has read through the Tessel team tools (teamMcp/server.cjs)
// leave an ack file in <project>/.tessel/team-channel/<team>/acks/. Tessel,
// the only writer of the channel's state, turns each into an acknowledgement
// (and the sender's receipt), then deletes it.
import fs from 'fs'
import { join, resolve, isAbsolute } from 'path'
import { ackTeamDelivery } from './teamChannel'
import { removeNotice } from './teamNotices'

const ID_RE = /^(?!\.)(?!.*\.\.)[A-Za-z0-9._-]{1,100}$/

// A processed ack file is kept a minute before it is deleted: the team tools
// read state.json, then check the ack files; deleting the file right after
// marking the message delivered could make them show it a second time in
// between.
const ACK_KEPT_MS = 60000
const processedAt = new Map() // ack file -> when it was processed

export function takeTeamAcks({ dir, teamId } = {}) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || typeof teamId !== 'string' || !ID_RE.test(teamId))
    return { ok: false, error: 'Invalid team channel location.' }
  const folder = join(resolve(dir), '.tessel', 'team-channel', teamId, 'acks')
  if (!fs.existsSync(folder)) return { ok: true, count: 0 }
  let count = 0
  for (const name of fs.readdirSync(folder)) {
    if (!name.endsWith('.json')) continue
    const file = join(folder, name)
    const doneAt = processedAt.get(file)
    if (doneAt) {
      if (Date.now() - doneAt < ACK_KEPT_MS) continue
      try {
        fs.rmSync(file, { force: true })
      } catch {
        continue // retried next round
      }
      processedAt.delete(file)
      continue
    }
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // being written: next round
    }
    // A Tessel notice ("n-<id>") is simply removed once read.
    const notice = data && typeof data.id === 'string' && data.id.startsWith('n-')
    const res = notice
      ? { ok: removeNotice({ dir, teamId, id: data.id.slice(2) }) }
      : data && typeof data.id === 'string' && typeof data.toId === 'string'
        ? ackTeamDelivery({ dir, teamId, id: data.id, toId: data.toId })
        : { ok: false }
    // Done, or not a delivery any more (unknown / already confirmed; a notice
    // already removed): deleted a minute from now.
    if (res.ok || /Unknown delivery/.test(res.error || '') || !data) {
      processedAt.set(file, Date.now())
      if (res.ok) count++
    }
  }
  return { ok: true, count }
}
