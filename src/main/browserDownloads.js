import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Chromium writes the original response in its existing session. Never fetch
// the URL again, persist download history, or log a URL/header/file name.
export function createBrowserDownloads({ directory, send, reveal = () => {} }) {
  const records = new Map()
  const active = new Map()
  const destinations = new Map()
  function prepare(page, saveAs, owner, allowed = () => true) {
    const now = Date.now()
    for (const [id, entry] of destinations) if (entry.expiresAt <= now) destinations.delete(id)
    const previous = destinations.get(page)
    if (previous && previous.owner !== owner) return { ok: false, error: 'destination-in-use' }
    if (saveAs === null) { destinations.delete(page); return { ok: true, cleared: true } }
    if (typeof saveAs !== 'string' || !path.isAbsolute(saveAs) || saveAs.length > 3000) return { ok: false, error: 'absolute-file-path-required' }
    const name = path.basename(saveAs)
    // No Windows device names, alternate streams, trailing dots or separators.
    if (!name || /[<>:"/\\|?*]/.test(name) || [...saveAs].some((c) => c.charCodeAt(0) < 32) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return { ok: false, error: 'invalid-file-name' }
    try { fs.mkdirSync(path.dirname(saveAs), { recursive: true }) } catch { return { ok: false, error: 'destination-unavailable' } }
    if (destinations.size >= 128) return { ok: false, error: 'too-many-destinations' }
    const entry = { saveAs: path.resolve(saveAs), owner, allowed, expiresAt: now + 60000 }
    destinations.set(page, entry)
    return { ok: true, saveAs: entry.saveAs, expiresAt: entry.expiresAt, scope: 'next-download-only' }
  }
  function list(page) {
    return [...records.values()].filter((r) => r.webContentsId === page).map((r) => ({ ...r }))
  }
  function accept(item, page, { unattended = false } = {}) {
    if (active.size >= 8) throw new Error('Too many active downloads') // i18n-ignore
    const destination = destinations.get(page)
    destinations.delete(page)
    if (destination && (destination.expiresAt <= Date.now() || !destination.allowed())) throw new Error('Download destination expired or revoked') // i18n-ignore
    const silent = !!destination || unattended
    const folder = destination ? path.dirname(destination.saveAs) : unattended ? path.join(directory(), 'Tessel') : directory()
    if (silent) fs.mkdirSync(folder, { recursive: true })
    const raw = destination ? path.basename(destination.saveAs) : String(item.getFilename() || 'download')
    // eslint-disable-next-line no-control-regex -- strip forbidden filename bytes
    const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download'
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let target = path.join(folder, name)
    let n = 1
    const reserved = new Set([...active.values()].map((a) => a.target))
    while (fs.existsSync(target) || reserved.has(target)) target = path.join(folder, `${stem} (${n++})${ext}`)
    const id = crypto.randomUUID()
    // Save unattended transfers to a private staging name. Publish exclusively
    // on completion, so even a file created during the transfer is not replaced.
    const staging = silent ? path.join(folder, `.tessel-download-${id}.part`) : null
    if (staging) {
      fs.closeSync(fs.openSync(staging, 'wx', 0o600))
      try { item.setSavePath(staging) } catch (error) { fs.unlinkSync(staging); throw error }
    } else item.setSaveDialogOptions({ defaultPath: target, properties: ['showOverwriteConfirmation', 'createDirectory'] })
    const r = { id, webContentsId: page, name: path.basename(target), state: silent ? 'progressing' : 'choosing', receivedBytes: 0, totalBytes: item.getTotalBytes(), path: null, error: null }
    records.set(id, r)
    active.set(id, { item, target })
    for (const [key] of records) {
      if (records.size <= 100) break
      if (!active.has(key)) records.delete(key)
    }
    const emit = () => send('browser:downloadChanged', { ...r })
    let last = 0
    item.on('updated', (_event, state) => {
      r.state = state
      r.receivedBytes = item.getReceivedBytes()
      r.totalBytes = item.getTotalBytes()
      r.error = state === 'interrupted' ? 'transfer-interrupted' : null
      if (Date.now() - last > 200 || state === 'interrupted') { last = Date.now(); emit() }
    })
    item.once('done', (_event, state) => {
      r.state = state
      r.receivedBytes = item.getReceivedBytes()
      r.totalBytes = item.getTotalBytes()
      r.path = state === 'completed' ? item.getSavePath() : null
      r.error = state === 'interrupted' ? 'transfer-failed' : null
      if (staging) {
        if (state === 'completed') {
          try {
            for (;;) {
              try {
                // Hard links publish atomically on NTFS; EXCL copy also supports
                // destinations whose filesystem does not offer hard links.
                try { fs.linkSync(staging, target) } catch (error) {
                  if (error.code === 'EEXIST') throw error
                  fs.copyFileSync(staging, target, fs.constants.COPYFILE_EXCL)
                }
                break
              } catch (error) {
                if (error.code !== 'EEXIST') throw error
                target = path.join(folder, `${stem} (${n++})${ext}`)
              }
            }
            r.path = target
            r.name = path.basename(target)
          } catch {
            r.state = 'interrupted'
            r.path = null
            r.error = 'save-failed'
          }
        }
        try { fs.unlinkSync(staging) } catch { /* No private paths in logs. */ }
      }
      active.delete(id)
      emit()
    })
    emit()
  }
  function cancel(page, id) {
    if (records.get(id)?.webContentsId !== page || !active.has(id)) return false
    active.get(id).item.cancel()
    return true
  }
  function show(page, id) {
    const r = records.get(id)
    if (r?.webContentsId !== page || r.state !== 'completed' || !r.path) return false
    reveal(r.path)
    return true
  }
  return { accept, list, cancel, show, prepare }
}
