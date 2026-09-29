// The browser pane's pure logic (BrowserPane.vue): its zoom levels, what a
// failed load shows, the page's title, the notices for what the page asked
// for, and the keys the pane answers. After Orca's
// src/renderer/src/components/browser-pane/navigate/browser-notices.ts,
// navigate/browser-load-failure-overlay.tsx, assemble-chrome/
// browser-page-zoom-indicator.tsx and src/shared/browser-url.ts
// (toHttpsRecoveryUrl) (MIT, Copyright (c) 2026 Lovecast Inc.), ported to
// plain JS.
import { t } from '../i18n'
import { BLANK_URL, isLocalUrl, hostOf } from '../../../shared/browserUrl'

// --- Zoom (Chromium zoom levels: factor = 1.2 ^ level) ------------------------------------
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5
export const ZOOM_STEP = 0.5

export function clampZoom(level) {
  const n = Number(level)
  if (!Number.isFinite(n)) return 0
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(n / ZOOM_STEP) * ZOOM_STEP))
}

// dir: 1 (in), -1 (out), 0 (reset).
export function nextZoom(level, dir) {
  if (!dir) return 0
  return clampZoom(clampZoom(level) + dir * ZOOM_STEP)
}

export function zoomPercent(level) {
  return Math.round(Math.pow(1.2, clampZoom(level)) * 100)
}

// --- Load failures ------------------------------------------------------------------------
// -3 is ERR_ABORTED: a navigation replaced by another one (or a download),
// not a failure to show.
export const ERR_ABORTED = -3

export function isShownLoadFailure(ev) {
  if (!ev) return false
  if (ev.isMainFrame === false) return false
  return Number(ev.errorCode) !== ERR_ABORTED
}

// Chromium's certificate error codes (Orca's browser-certificate-errors.ts).
const CERTIFICATE_ERROR_CODES = new Set([-200, -201, -202, -203, -204, -205, -206, -207, -208, -210, -211, -212, -213, -214, -217, -219])
export function isCertificateError(code) {
  return CERTIFICATE_ERROR_CODES.has(Number(code))
}

// "Try HTTPS": a local page asked over http may only be served over https.
export function httpsRecoveryUrl(raw) {
  try {
    const u = new URL(String(raw))
    if (u.protocol !== 'http:' || !isLocalUrl(u.toString())) return null
    u.protocol = 'https:'
    return u.toString()
  } catch {
    return null
  }
}

function hostIn(url) {
  try {
    return new URL(String(url)).host || null
  } catch {
    return null
  }
}

// What the failure overlay shows for { code, description, url }:
// { kind, title, description, hints[], httpsUrl }.
export function loadFailureView(failure) {
  const f = failure || {}
  if (f.kind === 'crash') {
    return {
      kind: 'crash',
      title: t('browser.failure.crashTitle', 'Browser page stopped'),
      description: t('browser.failure.crashText', 'The browser page stopped unexpectedly. Retry to restore it.'),
      hints: [],
      httpsUrl: null
    }
  }
  const host = hostIn(f.url)
  const local = isLocalUrl(f.url)
  if (isCertificateError(f.code)) {
    const where = host || t('browser.failure.thisAddress', 'this address')
    let description
    if (Number(f.code) === -200) description = t('browser.failure.certNameMismatch', "The certificate doesn't match {{host}}.", { host: where })
    else if (Number(f.code) === -201)
      description = t('browser.failure.certDateInvalid', "The certificate for {{host}} isn't valid at the current date and time.", { host: where })
    else if (Number(f.code) === -202)
      description = t('browser.failure.certAuthorityInvalid', "Tessel doesn't trust the authority that issued the certificate for {{host}}.", { host: where })
    else description = t('browser.failure.certFailed', "Tessel couldn't verify the certificate for {{host}}.", { host: where })
    return {
      kind: 'certificate',
      title: t('browser.failure.notSecure', "Connection isn't secure"),
      description,
      hints: local ? [t('browser.failure.trustedCertificate', 'For local development, use a trusted local certificate when possible.')] : [],
      httpsUrl: null
    }
  }
  let description
  if (local) description = t('browser.failure.localServer', "We couldn't connect to your local server.")
  else if (Number(f.code) === 0 && f.description) description = String(f.description)
  else description = t('browser.failure.page', "We couldn't connect to this page.")
  return {
    kind: 'load',
    title: host ? t('browser.failure.cantReach', "Can't reach {{host}}", { host }) : t('browser.failure.cantLoad', "Can't load this page"),
    description,
    hints: local
      ? [t('browser.failure.localHint', 'If this should be a local app, make sure the server is running and listening on the expected port.')]
      : [],
    httpsUrl: httpsRecoveryUrl(f.url)
  }
}

// --- Title --------------------------------------------------------------------------------
// The page's title, or its host when it has none (Chromium reports the URL
// as the title of a page without one). The blank page has none.
export function pageTitleFor(title, url) {
  if (!url || url === BLANK_URL) return ''
  const s = String(title || '').trim()
  if (!s || s === url || s === BLANK_URL || s === String(url).replace(/^https?:\/\//, '')) return hostOf(url)
  return s
}

// --- Notices ------------------------------------------------------------------------------
// Unknown permissions keep their raw name instead of an invented phrase.
export function permissionLabel(permission) {
  switch (permission) {
    case 'media':
      return t('browser.permission.media', 'camera or microphone access')
    case 'geolocation':
      return t('browser.permission.geolocation', 'your location')
    case 'notifications':
      return t('browser.permission.notifications', 'notifications')
    case 'display-capture':
      return t('browser.permission.displayCapture', 'screen sharing')
    case 'clipboard-read':
      return t('browser.permission.clipboardRead', 'reading your clipboard')
    case 'midi':
    case 'midiSysex':
      return t('browser.permission.midi', 'access to your MIDI devices')
    case 'pointerLock':
      return t('browser.permission.pointerLock', 'pointer lock')
    default:
      return String(permission || t('browser.permission.unknown', 'a permission'))
  }
}

export function permissionNotice({ permission, origin } = {}) {
  const who = !origin || origin === 'unknown' || origin === 'null' ? t('browser.notice.thisPage', 'This page') : origin
  return t('browser.notice.permission', '{{origin}} asked for {{what}}; Tessel denied it.', { origin: who, what: permissionLabel(permission) })
}

export function downloadNotice({ name } = {}) {
  const file = name ? String(name) : t('browser.notice.thisFile', 'this file')
  return t('browser.notice.download', 'Tessel does not download files. Open {{name}} in your default browser?', { name: file })
}

// --- Keys ---------------------------------------------------------------------------------
// The keys the pane answers while the focus is in it but not in the page
// (the page's own keys come from the main process as the same actions).
export function shortcutAction(e) {
  if (!e) return null
  const ctrl = !!(e.ctrlKey || e.metaKey)
  const key = String(e.key || '')
  const lower = key.toLowerCase()
  if (key === 'F5') return ctrl ? 'hardReload' : 'reload'
  if (key === 'F12' && !ctrl && !e.altKey) return 'devTools'
  if (e.altKey && !ctrl && !e.shiftKey) {
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
    return null
  }
  if (!ctrl || e.altKey) return null
  if (lower === 'l' && !e.shiftKey) return 'focusAddress'
  if (lower === 'r') return e.shiftKey ? 'hardReload' : 'reload'
  if (e.shiftKey && key !== '+') return null
  if (key === '=' || key === '+') return 'zoomIn'
  if (key === '-') return 'zoomOut'
  if (key === '0') return 'zoomReset'
  return null
}

// --- Ports --------------------------------------------------------------------------------
// "localhost:5173" for a port row (its address without the scheme).
export function portAddress(port) {
  if (!port) return ''
  if (port.url) return String(port.url).replace(/^https?:\/\//, '').replace(/\/$/, '')
  return port.port ? `localhost:${port.port}` : '' // i18n-ignore
}
