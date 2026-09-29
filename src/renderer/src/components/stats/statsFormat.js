// Numbers, money, dates and durations of the usage statistics, in the
// interface's language.
import { t, intlLocale } from '../../i18n'

const na = () => t('stats.format.na', 'n/a')
const number = (value, digits) =>
  new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)

export function tokens(value) {
  if (!Number.isFinite(value)) return na()
  if (value >= 1e6) return t('stats.format.millions', '{{n}}M', { n: number(value / 1e6, 1) })
  if (value >= 1e3) return t('stats.format.thousands', '{{n}}k', { n: number(value / 1e3, 1) })
  return value.toLocaleString(intlLocale())
}
export const money = (value) =>
  Number.isFinite(value)
    ? new Intl.NumberFormat(intlLocale(), {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: value < 0.01 ? 4 : 2,
        maximumFractionDigits: value < 0.01 ? 4 : 2
      }).format(value)
    : na()
export const percent = (value) =>
  Number.isFinite(value) ? new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(value) : na()
export function time(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString(intlLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : t('stats.format.unknown', 'Unknown')
}
export function duration(value) {
  if (!Number.isFinite(value)) return na()
  const minutes = Math.floor(Math.max(0, value) / 60000)
  if (minutes >= 1440)
    return t('stats.format.days', '{{d}}d {{h}}h', { d: Math.floor(minutes / 1440), h: Math.floor(minutes / 60) % 24 })
  if (minutes >= 60) return t('stats.format.hours', '{{h}}h {{m}}m', { h: Math.floor(minutes / 60), m: minutes % 60 })
  return t('stats.format.minutes', '{{m}}m', { m: minutes })
}
