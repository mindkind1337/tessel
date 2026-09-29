// src/shared/activity.js's formatters, in the interface's language.
import { formatDuration as sharedDuration, formatWhen as sharedWhen } from '../../shared/activity'
import { t, intlLocale } from './i18n'

export const formatDuration = (ms) => sharedDuration(ms, t)
export const formatWhen = (at, now = Date.now()) => sharedWhen(at, now, intlLocale())
