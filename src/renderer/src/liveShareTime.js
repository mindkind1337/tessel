// Live Share's times in words, in the interface's language: how long ago
// (the relay's last publish: "2 minutes ago", "just now") and a time of day
// (when the share started: "14:02").
import { t, intlLocale } from './i18n'

export function agoText(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return t('liveShare.time.justNow', 'just now')
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' })
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour')
  return rtf.format(-Math.round(s / 86400), 'day')
}

export function clockText(at) {
  return Number.isFinite(at) && at > 0 ? new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit' }).format(at) : ''
}
