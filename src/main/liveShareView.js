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
// (any loopback, private or link-local address refuses it). The name is
// resolved by the session's own resolver (Chromium's, whose cache the
// request then uses), cached here a few seconds only. A name that does not
// resolve is let through (it fails on its own).
//
// A name can still change its answer between that check and the connection
// (DNS rebinding: a first answer public, the next one 127.0.0.1). So the
// address the request actually reached is checked again when its answer
// comes (onHeadersReceived's ip): one of the guest's own network is
// cancelled there, before the page reads a byte of it.
import dns from 'dns'
import { localOnlyHost } from '../shared/livePageUrl.js'

export const VIEW_PARTITION = /^liveshare-view-[\w-]{1,40}$/
export const isViewPartition = (p) => typeof p === 'string' && VIEW_PARTITION.test(p)

const isIp = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')

// An address a connection reached (1.2.3.4, ::1, fe80::1%eth0): whether it
// is the guest's own computer or network. No address known: false (the
// check by name already ran).
export function localAddress(ip) {
  const a = typeof ip === 'string' ? ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '') : ''
  if (!a) return false
  return localOnlyHost(a.includes(':') ? `[${a.toLowerCase()}]` : a)
}

// The session's own resolver as a lookup ([{ address }]): the answer Chromium
// connects to. -> null without one (an older Electron, a test).
export function sessionLookup(ses) {
  if (!ses || typeof ses.resolveHost !== 'function') return null
  return async (host) => {
    const res = await ses.resolveHost(host)
    return ((res && res.endpoints) || []).map((e) => ({ address: e.address }))
  }
}

// -> (hostname) => Promise<boolean>: whether it reaches the guest's own
// computer or network.
export function createHostCheck({ lookup = (host) => dns.promises.lookup(host, { all: true }), ttlMs = 5000, clock = Date.now } = {}) {
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
      bad = (Array.isArray(all) ? all : [all]).some((a) => a && localAddress(a.address))
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
// network is cancelled, before it goes (by name and resolved address) and
// again when its answer comes (the address it really reached).
export function guardViewSession(ses, { check = null, log = null } = {}) {
  if (!ses || !ses.webRequest || typeof ses.webRequest.onBeforeRequest !== 'function') return false
  const lookup = sessionLookup(ses)
  const hostCheck = check || createHostCheck(lookup ? { lookup } : {})
  const refuse = (url, why) => log?.warn?.('browser', `live share view: refused ${why} ${url}`) // i18n-ignore
  ses.webRequest.onBeforeRequest((details, callback) => {
    let url
    try {
      url = new URL(details.url)
    } catch {
      return callback({ cancel: true })
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return callback({})
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return callback({ cancel: true })
    Promise.resolve(hostCheck(url.hostname))
      .catch(() => true)
      .then((bad) => {
        if (bad) refuse(`${url.protocol}//${url.host}`, 'host')
        callback(bad ? { cancel: true } : {})
      })
  })
  if (typeof ses.webRequest.onHeadersReceived === 'function') {
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (localAddress(details && details.ip)) {
        let where = ''
        try {
          where = new URL(details.url).host
        } catch {
          where = ''
        }
        refuse(where, 'address')
        return callback({ cancel: true })
      }
      callback({})
    })
  }
  return true
}
