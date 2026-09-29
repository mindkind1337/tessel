// A remote project's automation prompt, on its host: written through the
// project's Files session (remoteFs.js: contents over stdin, every path
// resolved on the host and refused unless it stays inside the project
// folder), never typed into the host's login shell.
//
// Links are refused all along the way, even ones that stay inside the
// project (a cloned repository can hold them): .tessel, automations, its
// .gitignore and the prompt file must be a real folder or file, as the
// host lists them right before the write. The folder's .gitignore ("*", so
// `git add -A` never takes the prompt) is created only when missing; one of
// yours is left as it is. The prompt is created readable by its owner only.
//
// When a run ends its prompt is emptied, but only through a session to that
// host that is already open (clear with onlyIfConnected): nothing opens a
// connection, or asks for a password, on its own; the scheduler keeps the
// clearing for later (the next time you work with that host).
import { remoteRoot, childPath } from '../shared/remotePath'

const FILE = /^\.tessel\/automations\/(auto-[A-Za-z0-9-]{1,80}\.md)$/

export function createRemotePromptWriter(remoteFs) {
  function place(hostId, path, file) {
    const root = remoteRoot(hostId, path)
    const m = FILE.exec(String(file || ''))
    if (!root || !m) return null
    const tessel = childPath(root, '.tessel')
    const dir = childPath(tessel, 'automations')
    return { root, tessel, dir, name: m[1], target: childPath(dir, m[1]) }
  }
  const refused = (error = '') => ({ ok: false, error })

  // The entry `name` in folder `dir`: { exists, link, dir } or { error }.
  async function entry(root, dir, name) {
    const res = await remoteFs.listDir({ root, dir })
    if (!res || !res.ok) return { error: (res && res.error) || '' }
    const e = res.entries.find((x) => x.name === name)
    return e ? { exists: true, link: !!e.link, dir: !!e.dir } : { exists: false }
  }

  // A real folder `name` in `parent` (created when missing).
  async function realFolder(root, parent, name) {
    let e = await entry(root, parent, name)
    if (e.error !== undefined) return e
    if (!e.exists) {
      await remoteFs.create({ root, dir: parent, name, folder: true })
      e = await entry(root, parent, name)
      if (e.error !== undefined) return e
    }
    if (!e.exists || e.link || !e.dir) return { error: 'link' }
    return { ok: true }
  }

  // -> { ok } | { ok: false, error }
  async function write({ hostId, path, file, text }) {
    const p = place(hostId, path, file)
    if (!p) return refused()
    for (const [parent, name] of [
      [p.root, '.tessel'],
      [p.tessel, 'automations']
    ]) {
      const f = await realFolder(p.root, parent, name)
      if (f.error !== undefined) return refused(f.error === 'link' ? 'link' : f.error)
    }
    const ignore = await entry(p.root, p.dir, '.gitignore')
    if (ignore.error !== undefined) return refused(ignore.error)
    if (ignore.link || (ignore.exists && ignore.dir)) return refused('link')
    if (!ignore.exists) {
      const res = await remoteFs.writeForEdit({ file: childPath(p.dir, '.gitignore'), text: '*\n' })
      if (!res || !res.ok) return refused((res && res.error) || '')
    }
    const prompt = await entry(p.root, p.dir, p.name)
    if (prompt.error !== undefined) return refused(prompt.error)
    if (prompt.link || (prompt.exists && prompt.dir)) return refused('link')
    const res = await remoteFs.writeForEdit({ file: p.target, text, privateNew: true })
    return res && res.ok ? { ok: true } : refused((res && res.error) || '')
  }

  function connected(hostId) {
    const s = remoteFs.snapshot ? remoteFs.snapshot()[hostId] : null
    return !!s && (s.state === 'ready' || s.state === 'busy')
  }

  // The run ended: its prompt emptied. -> { ok } | { ok: false, later: true }
  // (no open session to that host now) | { ok: false, error } (nothing to
  // do any more: a link, a bad name).
  async function clear({ hostId, path, file }, { onlyIfConnected = true } = {}) {
    const p = place(hostId, path, file)
    if (!p) return refused()
    if (onlyIfConnected && !connected(hostId)) return { ok: false, later: true }
    for (const [parent, name] of [
      [p.root, '.tessel'],
      [p.tessel, 'automations']
    ]) {
      const e = await entry(p.root, parent, name)
      if (e.error !== undefined) return { ok: false, later: true }
      if (!e.exists) return { ok: true } // nothing left there
      if (e.link || !e.dir) return refused('link')
    }
    const e = await entry(p.root, p.dir, p.name)
    if (e.error !== undefined) return { ok: false, later: true }
    if (!e.exists) return { ok: true }
    if (e.link || e.dir) return refused('link')
    const res = await remoteFs.writeForEdit({ file: p.target, text: '' })
    return res && res.ok ? { ok: true } : { ok: false, later: true }
  }

  return { write, clear }
}
