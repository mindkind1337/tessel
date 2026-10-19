// An image a chat names by its path (the reference's
// components/editor/useLocalImageSrc), as a data: URL the page can show: a
// local file read by the main process (files:viewImage, size-capped), a file
// on the pane's SSH host read over its connection (remoteFs, through the same
// call with its ssh:// path). Never a file:// URL in the page.
//
// Where it may come from is the chat's file context (provided as
// 'nativeChatFileLinkContext' by the chat views): a pane on an SSH host
// reads its host's paths only; a conversation from elsewhere (a Live Share
// host's, 'nativeChatLocalFiles' false) reads nothing on this computer.
// A network path (\\server\share) is never touched: reading one could hand
// your Windows sign-in to that server.
//
// The images read are kept in one bounded cache for the window (not in any
// reactive state), so a thumbnail and its full view read the file once.
import { getCurrentInstance, inject, readonly, shallowRef, toValue, watch } from 'vue'
import { childPath, isRemotePath, parseRemotePath } from '../../../../../shared/remotePath.js'
import { routeNativeChatHref } from '../../../chat/orca/shared/native-chat-href-routing.js'

// An image shown inline in a chat: over this, its name shows instead.
export const LOCAL_IMAGE_MAX_BYTES = 12 * 1024 * 1024
const CACHE_ENTRIES = 48
const CACHE_CHARS = 96 * 1024 * 1024
const FAILED_MS = 30 * 1000
const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp)$/i
const CONTROL = /[\u0000-\u001f\u007f]/ // eslint-disable-line no-control-regex

const cache = new Map() // target -> dataUrl (oldest first)
let cacheChars = 0
const failed = new Map() // target -> when it failed
const inflight = new Map() // target -> Promise<dataUrl | null>

function remember(target, dataUrl) {
  if (cache.has(target)) {
    cacheChars -= cache.get(target).length
    cache.delete(target)
  }
  cache.set(target, dataUrl)
  cacheChars += dataUrl.length
  while (cache.size > CACHE_ENTRIES || cacheChars > CACHE_CHARS) {
    const [oldest, old] = cache.entries().next().value
    cache.delete(oldest)
    cacheChars -= old.length
  }
}

export function clearLocalImageCacheForTests() {
  cache.clear()
  failed.clear()
  inflight.clear()
  cacheChars = 0
}

const hasDotSegment = (p) => p.split(/[\\/]+/).some((s) => s === '..')

// A path as a chat names it (a path, a file: URL, the chat's own file href)
// -> what files:viewImage reads (a local path or an ssh:// one), or null.
// context: the chat's file context ({ worktreePath, remote, remoteRoot }) or
// null; localFiles false: a conversation from another computer.
export function localImageTarget(raw, context, { localFiles = true } = {}) {
  if (!localFiles || typeof raw !== 'string') return null
  let p = raw.trim()
  if (!p || p.length > 4096 || CONTROL.test(p)) return null
  if (/^(?:#|file:)/i.test(p)) {
    const route = routeNativeChatHref(p)
    if (route.kind !== 'file' || !route.pathText) return null
    p = route.pathText
  }
  if (/^[\\/]{2}/.test(p) || !IMAGE_PATH.test(p)) return null
  // A web address (or any other scheme) is never read: only paths.
  if (/^[a-z][a-z0-9+.-]+:/i.test(p) && !isRemotePath(p)) return null
  const remoteRoot = context && context.remote ? context.remoteRoot : null
  if (isRemotePath(p)) return remoteRoot && parseRemotePath(p) ? p : null
  if (remoteRoot) {
    const host = parseRemotePath(remoteRoot)
    if (!host) return null
    // The host's own paths: absolute, or from its home folder.
    if (p.startsWith('/')) return parseRemotePath(`ssh://${host.hostId}${p}`) ? `ssh://${host.hostId}${p}` : null // i18n-ignore
    if (p.startsWith('~/')) return parseRemotePath(`ssh://${host.hostId}/${p}`) ? `ssh://${host.hostId}/${p}` : null // i18n-ignore
    if (/^[A-Za-z]:[\\/]/.test(p) || hasDotSegment(p)) return null
    const joined = childPath(remoteRoot, p.replace(/\\/g, '/').replace(/^\.\//, ''))
    return parseRemotePath(joined) ? joined : null
  }
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) return p
  // Relative: below the chat's folder.
  const base = context && typeof context.worktreePath === 'string' ? context.worktreePath : ''
  if (!base || isRemotePath(base) || hasDotSegment(p)) return null
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${sep}${p.replace(/^\.[\\/]/, '').replace(/[\\/]+/g, sep)}`
}

// target -> Promise<dataUrl | null> (read once, then from the cache).
export function readLocalImage(target) {
  if (!target) return Promise.resolve(null)
  if (cache.has(target)) {
    const hit = cache.get(target)
    remember(target, hit)
    return Promise.resolve(hit)
  }
  const at = failed.get(target)
  if (at && Date.now() - at < FAILED_MS) return Promise.resolve(null)
  if (inflight.has(target)) return inflight.get(target)
  const view = globalThis.window?.shellApi?.viewImage
  if (typeof view !== 'function') return Promise.resolve(null)
  const run = Promise.resolve()
    .then(() => view(target, { maxBytes: LOCAL_IMAGE_MAX_BYTES }))
    .then((res) => {
      const url = res && res.ok && typeof res.dataUrl === 'string' ? res.dataUrl : ''
      // The size cap again (a host's image is read whole there).
      if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,/.test(url) || url.length > Math.ceil(LOCAL_IMAGE_MAX_BYTES * 1.37) + 64) {
        failed.set(target, Date.now())
        return null
      }
      failed.delete(target)
      remember(target, url)
      return url
    })
    .catch(() => {
      failed.set(target, Date.now())
      return null
    })
    .finally(() => inflight.delete(target))
  inflight.set(target, run)
  return run
}

// src: a getter (or ref) of the path to show now (undefined: nothing to read
// yet, e.g. off screen); connectionId: kept for the reference's callers;
// runtimeContext: a file context to use instead of the provided one.
// -> a read-only ref of the data: URL (undefined until read, or when it
// cannot be).
// eslint-disable-next-line no-unused-vars
export function useLocalImageSrc(src, _path, _connectionId, runtimeContext) {
  const inSetup = !!getCurrentInstance()
  const provided = inSetup ? inject('nativeChatFileLinkContext', null) : null
  const localFiles = inSetup ? inject('nativeChatLocalFiles', true) : true
  const out = shallowRef(undefined)
  let run = 0
  watch(
    () => {
      const path = toValue(src)
      if (!path) return null
      const context = toValue(runtimeContext) ?? toValue(provided) ?? null
      return localImageTarget(path, context, { localFiles: toValue(localFiles) !== false })
    },
    (target) => {
      const mine = ++run
      if (!target) {
        out.value = undefined
        return
      }
      if (cache.has(target)) {
        out.value = cache.get(target)
        return
      }
      readLocalImage(target).then((url) => {
        if (mine === run) out.value = url || undefined
      })
    },
    { immediate: true }
  )
  return readonly(out)
}
