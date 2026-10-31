// Save a remote/shared file only to a destination chosen in the native dialog.
// Bytes stay in main; no renderer-supplied destination and no automatic opening.
import fs from 'fs/promises'
import { join } from 'path'
import { isRemotePath } from '../shared/remotePath'
import { isLsharePath, LSHARE_LIMITS } from '../shared/liveSharePath'
import { t } from './i18n'

export function downloadName(file) {
  let name = file.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/[. ]+$/, '') // eslint-disable-line no-control-regex
  if (!name || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `download-${name || 'file'}`
  return name.slice(0, 200)
}

export function createFileDownload({ dialog, getWindow, downloadsDir, remote, guest, writeFile = fs.writeFile }) {
  let busy = false
  return async function download(file) {
    if (typeof file !== 'string' || (!isRemotePath(file) && !isLsharePath(file))) return { ok: false }
    if (busy) return { ok: false, error: t('main.download.busy', 'A download is already in progress.') }
    busy = true
    try {
      const opts = { title: t('main.download.title', 'Download file'), defaultPath: join(downloadsDir(), downloadName(file)) }
      const win = getWindow()
      const choice = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
      if (!choice || choice.canceled || !choice.filePath) return { ok: false, canceled: true }
      const shared = isLsharePath(file)
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
