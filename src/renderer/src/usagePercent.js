// Settings > Appearance, "Usage percentages":
// quota bars and numbers show the part used, or the part left.
import { t } from './i18n'

// The number shown: used rounded first, then its complement for 'remaining',
// so a bar and its label always agree. Invalid data is never shown as 100 %
// left.
export function displayedUsagePercent(usedPct, display) {
  if (!Number.isFinite(usedPct)) return 0
  const used = Math.round(Math.min(100, Math.max(0, usedPct)))
  return display === 'remaining' ? 100 - used : used
}

export function usagePercentLabel(usedPct, display) {
  const n = displayedUsagePercent(usedPct, display)
  return display === 'remaining'
    ? t('usage.percent.left', '{{n}}% left', { n })
    : t('usage.percent.used', '{{n}}% used', { n })
}
