// After Orca's locale-text-collators.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
let baseSensitivityCollator
let numericCollator

export function compareBaseSensitivityLocaleText(a, b) {
  // Why: stay lazy like localeCompare while resolving ICU options only once.
  baseSensitivityCollator ??= new Intl.Collator(undefined, { sensitivity: 'base' })
  return baseSensitivityCollator.compare(a, b)
}

export function compareNumericLocaleText(a, b) {
  numericCollator ??= new Intl.Collator(undefined, { numeric: true })
  return numericCollator.compare(a, b)
}
