// A link or image in a file, resolved from that file's folder (Windows
// paths): "../docs/a.md#part" next to C:\p\README.md -> C:\docs\a.md.
// null for what is not a local file (a web address, an empty link).
// A file of a Live Share host's project (lshare://) or a remote one
// (ssh://): only a relative path, inside the same virtual root (read from
// there, never this computer's file or a share named by the host).
import { isLsharePath, parseLsharePath, lsharePath } from './liveSharePath.js'
import { isRemotePath, parseRemotePath, remoteRoot } from './remotePath.js'

// Passive previews must not contact a Windows network share (including a
// device/UNC path) just because a document names an image. Explicit clicks
// keep using resolveFrom; SSH/Live Share relative assets use their own session.
export function resolvePreviewImage(file, href) {
  const target = resolveFrom(file, href)
  if (!target) return null
  if (/^[\\/]{2}/.test(target)) {
    const share = (p) => {
      const m = /^\\\\([^\\/.?][^\\/]*)[\\/]([^\\/]+)/.exec(String(p))
      return m ? `${m[1]}/${m[2]}`.toLowerCase() : null
    }
    const sourceShare = share(file)
    // A document explicitly opened on a share may load that same share's
    // images, but never initiate contact with a different host/share.
    if (!sourceShare || sourceShare !== share(target)) return null
  }
  return target
}

function resolveVirtual(file, h) {
  // Absolute, a drive, a share, a scheme: never.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h) || /^[\\/]/.test(h)) return null
  const steps = h.split(/[\\/]+/).filter(Boolean)
  const walk = (segs) => {
    const out = segs.slice()
    for (const part of steps) {
      if (part === '.') continue
      if (part === '..') {
        if (!out.length) return null
        out.pop()
      } else out.push(part)
    }
    return out
  }
  if (isLsharePath(file)) {
    const p = parseLsharePath(file)
    if (!p || !p.rel) return null
    const segs = walk(p.rel.split('/').slice(0, -1))
    return segs ? lsharePath(p.project, segs.join('/')) : null
  }
  const r = parseRemotePath(file)
  if (!r) return null
  const home = r.path === '~' || r.path.startsWith('~/')
  const dir = r.path.replace(/^~/, '').split('/').filter(Boolean).slice(0, -1)
  const segs = walk(dir)
  return segs ? remoteRoot(r.hostId, `${home ? '~' : ''}/${segs.join('/')}`) : null
}

export function resolveFrom(file, href) {
  let h = String(href || '').trim()
  if (!h || /^(https?|mailto|data|javascript):/i.test(h)) return null
  if (/^file:/i.test(h)) {
    if (isLsharePath(file) || isRemotePath(file)) return null
    h = h.replace(/^file:\/*/i, '')
    if (/^[A-Za-z]:/.test(h)) h = h.replace(/\//g, '\\')
    else return null
  }
  h = h.replace(/[?#].*$/, '')
  try {
    h = decodeURI(h)
  } catch {
    // keep it as written
  }
  if (!h) return null
  if (isLsharePath(file) || isRemotePath(file)) return resolveVirtual(file, h)
  const abs = /^[A-Za-z]:[\\/]/.test(h) || /^\\\\/.test(h)
  const dir = String(file || '').replace(/[\\/][^\\/]*$/, '')
  const joined = abs ? h : `${dir}\\${h}`
  const m = /^([A-Za-z]:|\\\\[^\\/]+[\\/][^\\/]+)(.*)$/.exec(joined.replace(/\//g, '\\'))
  if (!m) return null
  const out = []
  for (const part of m[2].split('\\')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `${m[1]}\\${out.join('\\')}`
}
