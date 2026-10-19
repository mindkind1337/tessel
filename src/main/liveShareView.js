// Live Share, as a guest: the browser session the host's pages open in. A
// host's page is a link the guest's Tessel opens in its own browser
// (src/renderer/src/liveShareWindowFeeds.js), never in the guest's own
// signed-in session: in a session of its own, in memory only, one per Live
// Share session (liveshare-view-<session>), gone when Tessel quits.
//
// A host could point that tab at the guest's own network (a redirect to
// 192.168.1.1, a name that resolves to 127.0.0.1): every request of that
// session is checked first, its host by name (localhost, a private range, a
// .local name: livePageUrl.js localOnlyHost) and by what it resolves to
// (DNS: any loopback, private or link-local address refuses it), cached for
// a minute. A name that does not resolve is let through (it fails on its
// own).
import dns from 'dns'
import { localOnlyHost } from '../shared/livePageUrl.js'

export const VIEW_PARTITION = /^liveshare-view-[\w-]{1,40}$/
export const isViewPartition = (p) => typeof p === 'string' && VIEW_PARTITION.test(p)

const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')

// -> (hostname) => Promise<boolean>: whether it reaches the guest's own
// computer or network.
export function createHostCheck({ lookup = (host) => dns.promises.lookup(host, { all: true }), ttlMs = 60000, clock = Date.now } = {}) {
  const cache = new Map() // host -> { at, bad }
  return async function localHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    if (!host || localOnlyHost(host)) return true
    if (isIp(host)) return false
    const hit = cache.get(host)
    if (hit && clock() - hit.at < ttlMs) return hit.bad
    let bad = false
    try {
      const all = await lookup(host)
      bad = (Array.isArray(all) ? all : [all]).some((a) => a && typeof a.address === 'string' && localOnlyHost(a.address.includes(':') ? `[${a.address}]` : a.address))
    } catch {
      bad = false
    }
    cache.set(host, { at: clock(), bad })
    if (cache.size > 500) cache.delete(cache.keys().next().value)
    return bad
  }
}

// Every request of a guest's view session checked (its page, its redirects,
// its frames and what they load): one to the guest's own computer or
// network is cancelled.
export function guardViewSession(ses, { check = createHostCheck(), log = null } = {}) {
  if (!ses || !ses.webRequest || typeof ses.webRequest.onBeforeRequest !== 'function') return false
  ses.webRequest.onBeforeRequest((details, callback) => {
    let url
    try {
      url = new URL(details.url)
    } catch {
      return callback({ cancel: true })
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return callback({})
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return callback({ cancel: true })
    Promise.resolve(check(url.hostname))
      .catch(() => true)
      .then((bad) => {
        if (bad) log?.warn?.('browser', `live share view: refused ${url.protocol}//${url.host}`) // i18n-ignore
        callback(bad ? { cancel: true } : {})
      })
  })
  return true
}
