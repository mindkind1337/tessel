export function tokens(value) {
  if (!Number.isFinite(value)) return 'n/a'
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return value.toLocaleString()
}
export const money = (value) =>
  Number.isFinite(value) ? `$${value.toFixed(value < 0.01 ? 4 : 2)}` : 'n/a'
export const percent = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a')
export function time(value) {
  const date = new Date(value)
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'Unknown'
}
export function duration(value) {
  if (!Number.isFinite(value)) return 'n/a'
  const minutes = Math.floor(Math.max(0, value) / 60000)
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}m`
}
