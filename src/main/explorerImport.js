// Files dropped from Windows onto a folder of the file explorer: copied into
// a project of this computer, or sent to the folder on the SSH host. Nothing
// already there is replaced (those are named back as skipped), links and
// junctions are not followed (left out and counted), and one drop is bounded
// (localCopy.js's limits on this computer, IMPORT_LIMITS to a host). A Live
// Share project takes none.
import fs from 'fs'
import { basename, isAbsolute, join } from 'path'
import { isRemotePath } from '../shared/remotePath'
import { isLsharePath } from '../shared/liveSharePath'
import { inside, taken, realPath, reallyInside, within, fsErrorText } from './explorer'
import { MAX_EDIT_BYTES } from './editorFiles'
import { copyTree, copyState, LOCAL_LIMITS } from './localCopy'
import { t } from './i18n'

export const IMPORT_LIMITS = Object.freeze({ items: 200, files: 5000, bytes: 1024 * 1024 * 1024, folders: 2000 })

export function createExplorerImport({ remote, fsp = fs.promises, progress = () => {}, limits = IMPORT_LIMITS, localLimits = LOCAL_LIMITS, maxUploadBytes = MAX_EDIT_BYTES }) {
  let busy = false

  async function isLink(p) {
    try {
      return (await fsp.lstat(p)).isSymbolicLink()
    } catch {
      return false
    }
  }

  async function toLocal(root, dir, list, out) {
    const parent = inside(root, dir)
    let st = null
    try {
      st = parent ? await fsp.stat(parent) : null
    } catch {
      st = null
    }
    if (!st || !st.isDirectory()) return { ok: false, error: t('main.explorer.notFolder', 'The destination is not a folder.') }
    // A folder of the project that is a junction or link to elsewhere
    // (node_modules linked to another copy) takes nothing.
    if (!reallyInside(root, parent)) return { ok: false, error: t('main.explorer.throughLink', 'Not through a link: it would leave the project.') }
    const realParent = realPath(parent)
    const state = copyState()
    for (const src of list) {
      const name = basename(src)
      const target = inside(root, join(parent, name))
      if (!target) {
        out.failed.push({ name, error: t('main.explorer.outside', 'Outside the project.') })
        continue
      }
      if (taken(target)) {
        out.skipped.push(name)
        continue
      }
      if (await isLink(src)) {
        out.failed.push({ name, error: t('main.explorer.importLink', 'A link is not copied.') })
        continue
      }
      const realSrc = realPath(src)
      if (realSrc && within(realSrc, join(realParent, name))) {
        out.failed.push({ name, error: t('main.explorer.copyIntoItself', 'A folder cannot be copied into itself.') })
        continue
      }
      if (state.cut) {
        out.cut = true
        break
      }
      const before = state.files + state.folders
      try {
        await copyTree(src, target, { fsp, limits: localLimits, progress, state })
        if (state.files + state.folders > before) out.copied.push(name)
        else if (!state.cut) out.failed.push({ name, error: t('main.explorer.notCopiedKind', 'Not a file or folder: not copied.') })
      } catch (err) {
        out.failed.push({ name, error: fsErrorText(err) })
      }
    }
    out.files = state.files
    out.links += state.links
    out.unreadable = state.skipped
    if (state.cut) out.cut = true
    return out
  }

  async function toRemote(root, dir, list, out) {
    let files = 0
    let bytes = 0
    let folders = 0
    // One local file or folder into the host folder `into` (virtual path).
    // -> 'sent' | 'exists' | 'failed' | 'large' | 'cut' | 'link'; what failed
    // below a folder is named in out.failed / out.tooLarge, links counted.
    async function send(src, into) {
      if (files >= limits.files || bytes >= limits.bytes) {
        out.cut = true
        return 'cut'
      }
      const name = basename(src)
      let st
      try {
        st = await fsp.lstat(src)
      } catch (err) {
        out.failed.push({ name, error: fsErrorText(err) })
        return 'failed'
      }
      if (st.isSymbolicLink()) return 'link'
      if (st.isDirectory()) {
        if (folders >= limits.folders) {
          out.cut = true
          return 'cut'
        }
        const made = await remote.create({ root, dir: into, name, folder: true })
        if (made && made.exists) return 'exists'
        if (!made || !made.ok) {
          out.failed.push({ name, error: (made && made.error) || t('main.remoteFs.createFailed', 'It could not be created on the host.') })
          return 'failed'
        }
        folders++
        let kids = []
        try {
          kids = await fsp.readdir(src)
        } catch (err) {
          out.failed.push({ name, error: fsErrorText(err) })
        }
        for (const k of kids) {
          const r = await send(join(src, k), made.path)
          if (r === 'exists') out.failed.push({ name: k, error: t('main.explorer.exists', '"{{name}}" already exists here.', { name: k }) })
          if (r === 'link') out.links++
          if (r === 'cut') break
        }
        return 'sent'
      }
      if (!st.isFile()) return 'special'
      if (st.size > maxUploadBytes) {
        out.tooLarge.push(name)
        return 'large'
      }
      let data
      try {
        data = await fsp.readFile(src)
      } catch (err) {
        out.failed.push({ name, error: fsErrorText(err) })
        return 'failed'
      }
      const res = await remote.upload({ root, dir: into, name, data })
      if (res && res.ok) {
        files++
        bytes += data.length
        progress({ done: files, name })
        return 'sent'
      }
      if (res && res.exists) return 'exists'
      if (res && res.tooLarge) {
        out.tooLarge.push(name)
        return 'large'
      }
      out.failed.push({ name, error: (res && res.error) || t('main.remoteFs.uploadFailed', 'It could not be written on the host.') })
      return 'failed'
    }
    for (const src of list) {
      const name = basename(src)
      const r = await send(src, dir)
      if (r === 'sent') out.copied.push(name)
      else if (r === 'exists') out.skipped.push(name)
      else if (r === 'link') out.failed.push({ name, error: t('main.explorer.importLink', 'A link is not copied.') })
      else if (r === 'special') out.failed.push({ name, error: t('main.explorer.notCopiedKind', 'Not a file or folder: not copied.') })
      else if (r === 'cut') break
    }
    out.files = files
    return out
  }

  // -> { ok: true, copied: [names], skipped: [names], tooLarge: [names],
  // failed: [{ name, error }], links (left out below the dropped folders),
  // cut (a limit stopped it, or more than `items` were dropped), files } |
  // { ok: false, error }
  return async function importPaths({ root, dir, paths } = {}) {
    if (typeof root !== 'string' || !root || !Array.isArray(paths)) return { ok: false, error: t('main.explorer.importNothing', 'Nothing to copy.') }
    if (isLsharePath(root)) return { ok: false, error: t('main.explorer.importShared', 'Dropping files is not available in a Live Share project.') }
    const all = paths.filter((p) => typeof p === 'string' && isAbsolute(p) && !isRemotePath(p) && !isLsharePath(p))
    const list = all.slice(0, limits.items)
    if (!list.length) return { ok: false, error: t('main.explorer.importNothing', 'Nothing to copy.') }
    const into = typeof dir === 'string' && dir ? dir : root
    if (busy) return { ok: false, error: t('main.explorer.importBusy', 'Files are still being copied. Try again when it is done.') }
    busy = true
    const out = { ok: true, copied: [], skipped: [], tooLarge: [], failed: [], links: 0, cut: all.length > list.length, files: 0 }
    try {
      return isRemotePath(root) ? await toRemote(root, into, list, out) : await toLocal(root, into, list, out)
    } finally {
      busy = false
    }
  }
}
