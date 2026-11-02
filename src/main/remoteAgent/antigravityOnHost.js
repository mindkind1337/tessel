// Antigravity CLI on an SSH host: its conversations are on the host, so a pane there is matched to
// one with the host's files, the way agentSessionSources.js does with this computer's. Tessel's
// helper (__t_agyfind in remoteShell.js) sends what is needed: the start of each recent conversation's
// transcript, and the end of agy's history.jsonl, which names each conversation's folder.
import { antigravityWorkspace, parseAntigravityHead } from '../agentSessionSources'

export const AGY_FILES = 20
export const AGY_HEAD_BYTES = 16 * 1024
export const AGY_HISTORY_BYTES = 256 * 1024
// The most the helper can send, with room for its header lines.
export const AGY_OUTPUT_CAP = AGY_FILES * AGY_HEAD_BYTES + AGY_HISTORY_BYTES + 8 * 1024

const FILE_LINE = /^@file ([0-9A-Za-z_-]{1,100}) (\d{1,15}) (\d{1,10})$/
const HISTORY_LINE = /^@history (\d{1,10})$/

// The helper's output: header lines, each followed by that many bytes and a line break.
// -> { files: [{ id, mtimeMs, head }], history } (what cannot be read is left out)
export function parseAgyFind(out) {
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(String(out || ''), 'utf8')
  const files = []
  let history = ''
  let at = 0
  while (at < buf.length) {
    const nl = buf.indexOf(10, at)
    if (nl < 0) break
    const line = buf.toString('latin1', at, nl)
    const file = FILE_LINE.exec(line)
    const hist = file ? null : HISTORY_LINE.exec(line)
    if (!file && !hist) break
    const size = Number(file ? file[3] : hist[1])
    const start = nl + 1
    if (start + size > buf.length) break
    const text = buf.toString('utf8', start, start + size)
    if (file) files.push({ id: file[1], mtimeMs: Number(file[2]) * 1000, head: text })
    else history = text
    at = start + size + 1
  }
  return { files, history }
}

// As agentSessionSources.js antigravitySessions: rows for agentResume.js pickSession. A sub-agent's
// conversation is not named in history.jsonl, so it has no folder and is never picked.
export function agyHostSessions({ files = [], history = '' } = {}) {
  return files.map(({ id, mtimeMs, head }) => {
    const first = parseAntigravityHead(head)
    return { id, cwd: antigravityWorkspace(history, first.prompt, first.promptAt, id), time: first.started || mtimeMs, updated: mtimeMs }
  })
}
