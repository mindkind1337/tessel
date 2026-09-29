// A remote project's automation prompt, on its host: written through the
// project's Files session (remoteFs.js: contents over stdin, every path
// resolved on the host, links included, and refused unless it stays inside
// the project folder, so a .tessel that is a link to elsewhere in a cloned
// repository is refused), never typed into the host's login shell.
//
// The folder .tessel/automations gets a .gitignore of "*", so an agent that
// runs `git add -A` never commits the prompt; the file is emptied when the
// run ends (remoteFs has no delete but the trash, on purpose).
import { remoteRoot, childPath } from '../shared/remotePath'
import { REMOTE_PROMPT_DIR } from '../shared/automations'

const FILE = /^\.tessel\/automations\/auto-[A-Za-z0-9-]{1,80}\.md$/

export function createRemotePromptWriter(remoteFs) {
  function place(hostId, path, file) {
    const root = remoteRoot(hostId, path)
    if (!root || !FILE.test(String(file || ''))) return null
    return { root, dir: childPath(root, REMOTE_PROMPT_DIR), target: childPath(root, file) }
  }

  // -> { ok } | { ok: false, error }
  async function write({ hostId, path, file, text }) {
    const p = place(hostId, path, file)
    if (!p) return { ok: false, error: '' }
    let dir = p.root
    for (const name of REMOTE_PROMPT_DIR.split('/')) {
      // Already there: fine. Anything else (a link out of the project) shows
      // when a file is written in it.
      await remoteFs.create({ root: p.root, dir, name, folder: true })
      dir = childPath(dir, name)
    }
    const ignore = await remoteFs.writeForEdit({ file: childPath(p.dir, '.gitignore'), text: '*\n' })
    if (!ignore || !ignore.ok) return { ok: false, error: (ignore && ignore.error) || '' }
    const res = await remoteFs.writeForEdit({ file: p.target, text })
    return res && res.ok ? { ok: true } : { ok: false, error: (res && res.error) || '' }
  }

  // The run ended: nothing of its prompt stays on the host.
  async function clear({ hostId, path, file }) {
    const p = place(hostId, path, file)
    if (!p) return { ok: false, error: '' }
    const res = await remoteFs.writeForEdit({ file: p.target, text: '' })
    return res && res.ok ? { ok: true } : { ok: false, error: (res && res.error) || '' }
  }

  return { write, clear }
}
