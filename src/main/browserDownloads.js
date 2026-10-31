import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Chromium writes the original response in its existing session. Never fetch
// the URL again, persist download history, or log a URL/header/file name.
export function createBrowserDownloads({ directory, send, reveal = () => {} }) {
  const records = new Map()
  const active = new Map()
  function list(page) {
    return [...records.values()].filter((r) => r.webContentsId === page).map((r) => ({ ...r }))
  }
  function accept(item, page) {
    if (active.size >= 8) throw new Error('Too many active downloads')
    const raw = String(item.getFilename() || 'download')
    // eslint-disable-next-line no-control-regex -- strip forbidden filename bytes
    const name = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download'
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let target = path.join(directory(), name)
    let n = 1
    const reserved = new Set([...active.values()].map((a) => a.target))
    while (fs.existsSync(target) || reserved.has(target)) target = path.join(directory(), `${stem} (${n++})${ext}`)
    item.setSaveDialogOptions({ defaultPath: target, properties: ['showOverwriteConfirmation', 'createDirectory'] })
    const id = crypto.randomUUID()
    const r = { id, webContentsId: page, name, state: 'choosing', receivedBytes: 0, totalBytes: item.getTotalBytes(), path: null, error: null }
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
  return { accept, list, cancel, show }
}
