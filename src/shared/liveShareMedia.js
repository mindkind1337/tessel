// Live Share: the videos and sounds of a host's page, followed on the guest's
// own copy of it (liveShareLink.js: the guest opens the same address in its
// own browser). The host's Tessel reads, never changes, the page's media
// elements a few times a second (probeMedia, run in an isolated world of the
// page: the page's own scripts can't see or change it); what goes to the
// guest is only, for the first 16 <video> and <audio> elements, their kind,
// their place among those of that kind, whether they play, where they are
// (seconds) and at what speed. Never their address (a signed CDN address is
// a key), never anything else of the page: no content, form values, cookies
// or keys.
//
// The guest's Tessel plays them the same way on its copy (applyMedia, run in
// its own page while that tab follows the host): play or pause, the speed,
// and the place only when it drifted more than DRIFT_S (a small difference
// is the network's, not worth a jump).
//
// Pure: no DOM of its own (the two page functions get the document), no
// Electron. probeMedia and applyMedia are written to run as they are inside a
// page (no outer name used): mediaProbeScript / mediaApplyScript give them as
// code.

export const MEDIA_LIMITS = Object.freeze({ elements: 16, maxSeconds: 1e7, minRate: 0.0625, maxRate: 16 })
// The guest's place is set again only past this difference (seconds).
export const DRIFT_S = 1.5
// While something plays, its place goes out at least this often (ms).
export const RESYNC_MS = 5000

// In the host's page: [{ kind, i, paused, ended, t, rate }].
export function probeMedia(doc) {
  const out = []
  const seen = { video: 0, audio: 0 }
  const list = doc && typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('video, audio') : []
  for (const m of list) {
    if (out.length >= 16) break
    const kind = String(m.tagName || '').toLowerCase() === 'audio' ? 'audio' : 'video'
    const i = seen[kind]++
    const t = Number(m.currentTime)
    const rate = Number(m.playbackRate)
    out.push({ kind, i, paused: !!m.paused, ended: !!m.ended, t: Number.isFinite(t) ? t : 0, rate: Number.isFinite(rate) ? rate : 1 })
  }
  return out
}

// In the guest's page: each item's element (the i-th of its kind) made to
// match it. -> how many elements were changed.
export function applyMedia(doc, items, drift) {
  let changed = 0
  const list = doc && typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('video, audio')) : []
  const byKind = { video: [], audio: [] }
  for (const m of list) byKind[String(m.tagName || '').toLowerCase() === 'audio' ? 'audio' : 'video'].push(m)
  for (const it of Array.isArray(items) ? items : []) {
    const el = (byKind[it.kind] || [])[it.i]
    if (!el) continue
    let did = false
    if (Number(el.playbackRate) !== it.rate) {
      el.playbackRate = it.rate
      did = true
    }
    if (Math.abs(Number(el.currentTime) - it.t) > drift) {
      el.currentTime = it.t
      did = true
    }
    if (it.paused && !el.paused) {
      el.pause()
      did = true
    } else if (!it.paused && !it.ended && el.paused) {
      const p = el.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
      did = true
    }
    if (did) changed++
  }
  return changed
}

export const mediaProbeScript = () => `(${probeMedia.toString()})(document)`

// What the host's page said, checked (a host is not trusted with it): at
// most 16 items of the known shape, numbers in range. null: not that.
export function cleanMedia(list) {
  if (!Array.isArray(list) || list.length > MEDIA_LIMITS.elements) return null
  const out = []
  for (const m of list) {
    if (!m || typeof m !== 'object') return null
    if (m.kind !== 'video' && m.kind !== 'audio') return null
    if (!Number.isInteger(m.i) || m.i < 0 || m.i >= MEDIA_LIMITS.elements) return null
    const t = Number(m.t)
    const rate = Number(m.rate)
    if (!Number.isFinite(t) || t < 0 || t > MEDIA_LIMITS.maxSeconds) return null
    out.push({ kind: m.kind, i: m.i, paused: m.paused === true, ended: m.ended === true, t: Math.round(t * 100) / 100, rate: Number.isFinite(rate) && rate >= MEDIA_LIMITS.minRate && rate <= MEDIA_LIMITS.maxRate ? rate : 1 })
  }
  return out
}

// The guest's code for its own page: items as plain numbers and words only
// (cleaned first), so nothing but these values reaches the page. ageMs: how
// long ago the host read them (a playing element has moved on since).
export function mediaApplyScript(items, ageMs = 0) {
  const clean = cleanMedia(items) || []
  const age = Math.max(0, Math.min(10000, Number(ageMs) || 0)) / 1000
  const now = clean.map((m) => (m.paused || m.ended ? m : { ...m, t: Math.round((m.t + age * m.rate) * 100) / 100 }))
  return `(${applyMedia.toString()})(document, ${JSON.stringify(now)}, ${DRIFT_S})`
}

// The host's side: does a new reading say more than time passing? (a play,
// a pause, an end, a new speed, an element more or less, or a jump: where it
// is now is more than DRIFT_S from where it would be). elapsedMs: since the
// reading before.
export function mediaChanged(prev, next, elapsedMs) {
  const a = Array.isArray(prev) ? prev : []
  const b = Array.isArray(next) ? next : []
  if (a.length !== b.length) return true
  for (let k = 0; k < b.length; k++) {
    const x = a[k]
    const y = b[k]
    if (x.kind !== y.kind || x.i !== y.i || x.paused !== y.paused || x.ended !== y.ended || x.rate !== y.rate) return true
    const expected = x.paused || x.ended ? x.t : x.t + (Math.max(0, elapsedMs) / 1000) * x.rate
    if (Math.abs(y.t - expected) > DRIFT_S) return true
  }
  return false
}
export const anyPlaying = (list) => Array.isArray(list) && list.some((m) => !m.paused && !m.ended)
