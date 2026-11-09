// "Download…" from the file explorer: a file saved where the native dialog
// says, or a folder copied into the folder chosen in it (a new folder named
// after it, "name (2)" when that name is taken). Local projects too (a copy),
// SSH projects (read through the Files session), a Live Share host's files
// (files only). Bytes stay in main; no renderer-supplied destination and no
// automatic opening.
import fs from 'fs/promises'
import { join, isAbsolute, relative, basename } from 'path'
import { isRemotePath } from '../shared/remotePath'
import { isLsharePath, LSHARE_LIMITS } from '../shared/liveSharePath'
import { inside, realPath, within } from './explorer'
import { copyTree, LOCAL_LIMITS } from './localCopy'
import { t } from './i18n'

export function downloadName(file) {
  let name = file.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/, '') // eslint-disable-line no-control-regex
  if (!name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `download-${name || 'file'}`
  return name.slice(0, 200)
}

// A remote folder: at most this much, a file at a time (each over the
// remote cap is left out and counted).
export const FOLDER_LIMITS = Object.freeze({ files: 5000, bytes: 1024 * 1024 * 1024, folders: 2000 })

export function createFileDownload({ dialog, getWindow, downloadsDir, remote, guest, writeFile = fs.writeFile, fsp = fs, progress = () => {}, limits = FOLDER_LIMITS, localLimits = LOCAL_LIMITS }) {
  let busy = false

  const ask = (method, opts) => {
    const win = getWindow()
    return win ? dialog[method](win, opts) : dialog[method](opts)
  }
  const exists = async (p) => {
    try {
      await fsp.lstat(p)
      return true
    } catch {
      return false
    }
  }
  // "name", else "name (2)", "name (3)"… in the chosen folder.
  async function freeName(parent, name) {
    for (let i = 1; i < 100; i++) {
      const p = join(parent, i === 1 ? name : `${name} (${i})`)
      if (!(await exists(p))) return p
    }
    return null
  }
  async function chooseFolder() {
    const choice = await ask('showOpenDialog', {
      title: t('main.download.folderTitle', 'Download the folder into'),
      buttonLabel: t('main.download.here', 'Download here'),
      defaultPath: downloadsDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return choice && !choice.canceled && choice.filePaths && choice.filePaths[0] ? choice.filePaths[0] : null
  }

  async function localFile(file) {
    const st = await fsp.stat(file)
    if (!st.isFile()) return { ok: false }
    const choice = await ask('showSaveDialog', { title: t('main.download.title', 'Download file'), defaultPath: join(downloadsDir(), downloadName(file)) })
    if (!choice || choice.canceled || !choice.filePath) return { ok: false, canceled: true }
    if (relative(file, choice.filePath) === '') return { ok: true, path: choice.filePath }
    await fsp.copyFile(file, choice.filePath)
    return { ok: true, path: choice.filePath }
  }

  async function localFolder(dir) {
    const st = await fsp.lstat(dir)
    // A junction or link (node_modules linked to another copy): not followed.
    if (st.isSymbolicLink()) return { ok: false, error: t('main.download.link', 'This folder is a link to another place: it is not copied.') }
    if (!st.isDirectory()) return { ok: false }
    const parent = await chooseFolder()
    if (!parent) return { ok: false, canceled: true }
    const dest = await freeName(parent, downloadName(dir))
    if (!dest) return { ok: false, error: t('main.download.failed', 'The file could not be downloaded or saved there.') }
    const realDir = realPath(dir) || dir
    if (within(realDir, join(realPath(parent) || parent, basename(dest)))) return { ok: false, error: t('main.download.intoItself', 'A folder cannot be downloaded into itself.') }
    // A file at a time, bounded; links inside are left out, never followed.
    const state = await copyTree(dir, dest, { fsp, limits: localLimits, progress })
    return { ok: true, path: dest, files: state.files, skipped: state.links + state.skipped, tooLarge: 0, cut: state.cut }
  }

  async function remoteFolder(root, dir) {
    const parent = await chooseFolder()
    if (!parent) return { ok: false, canceled: true }
    const dest = await freeName(parent, downloadName(dir))
    if (!dest) return { ok: false, error: t('main.download.failed', 'The file could not be downloaded or saved there.') }
    await fsp.mkdir(dest)
    const where = new Map([[dir, dest]])
    const queue = [dir]
    const asked = new Set()
    let files = 0
    let bytes = 0
    let folders = 0
    let skipped = 0
    let tooLarge = 0
    let cut = false
    while (queue.length && !cut) {
      const batch = queue.splice(0, asked.has(queue[0]) ? 1 : 32)
      // direct: listed by the Files session itself, not the host's daemon
      // (its tree would keep following every folder of the download).
      const res = await remote.listMany({ root, dirs: batch, dotfiles: true, direct: true })
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || t('main.download.readFailed', 'The remote file could not be downloaded.') }
      // A folder the answer did not reach (cut at its size): asked once more,
      // then counted as left out.
      const answered = new Set((res.results || []).map((r) => r.dir))
      for (const d of batch) {
        if (answered.has(d)) continue
        if (asked.has(d)) skipped++
        else {
          asked.add(d)
          queue.unshift(d)
        }
      }
      for (const r of res.results || []) {
        const base = where.get(r.dir)
        if (!base || !r.ok) {
          skipped++
          continue
        }
        if (r.truncated) cut = true
        for (const e of r.entries || []) {
          if (e.link) {
            skipped++
            continue
          }
          const target = join(base, downloadName(e.name))
          if (e.dir) {
            if (++folders > limits.folders) {
              cut = true
              break
            }
            try {
              await fsp.mkdir(target)
            } catch {
              skipped++
              continue
            }
            where.set(e.path, target)
            queue.push(e.path)
            continue
          }
          if (files >= limits.files || bytes >= limits.bytes) {
            cut = true
            break
          }
          const got = await remote.readDownload(e.path)
          if (got && got.code === 'too-large') {
            tooLarge++
            continue
          }
          if (!got || !got.ok || !Buffer.isBuffer(got.buf)) {
            skipped++
            continue
          }
          try {
            await writeFile(target, got.buf, { flag: 'wx' })
          } catch {
            skipped++
            continue
          }
          files++
          bytes += got.buf.length
          progress({ done: files, name: e.name })
        }
        if (cut) break
      }
    }
    return { ok: true, path: dest, files, skipped, tooLarge, cut }
  }

  // file: a path (a remote or shared file, as before), or { file, root,
  // folder } from the explorer (a local path must be below root).
  return async function download(q) {
    const file = typeof q === 'string' ? q : q && typeof q === 'object' ? q.file : null
    const root = q && typeof q === 'object' && typeof q.root === 'string' ? q.root : null
    const folder = !!(q && typeof q === 'object' && q.folder === true)
    if (typeof file !== 'string' || !file) return { ok: false }
    const shared = isLsharePath(file)
    const ssh = isRemotePath(file)
    if (!shared && !ssh && (!root || isRemotePath(root) || isLsharePath(root) || !isAbsolute(file) || !inside(root, file))) return { ok: false }
    if (folder && (shared || (ssh && (!root || !isRemotePath(root))))) return { ok: false }
    if (busy) return { ok: false, error: t('main.download.busy', 'A download is already in progress.') }
    busy = true
    try {
      if (!shared && !ssh) return folder ? await localFolder(file) : await localFile(file)
      if (folder) return await remoteFolder(root, file)
      const opts = { title: t('main.download.title', 'Download file'), defaultPath: join(downloadsDir(), downloadName(file)) }
      const choice = await ask('showSaveDialog', opts)
      if (!choice || choice.canceled || !choice.filePath) return { ok: false, canceled: true }
      const max = shared ? LSHARE_LIMITS.downloadBytes : 50 * 1024 * 1024
      const res = await (shared ? guest() : remote).readDownload(file)
      if (res?.code === 'too-large') return { ok: false, error: t('main.download.tooLarge', 'This file exceeds the download limit ({{mb}} MB).', { mb: max / 1024 / 1024 }) }
      if (!res?.ok || !Buffer.isBuffer(res.buf) || res.buf.length > max) return { ok: false, error: res?.error || t('main.download.readFailed', 'The remote file could not be downloaded.') }
      await writeFile(choice.filePath, res.buf)
      return { ok: true, path: choice.filePath }
    } catch {
      return { ok: false, error: t('main.download.failed', 'The file could not be downloaded or saved there.') }
    } finally {
      busy = false
    }
  }
}
