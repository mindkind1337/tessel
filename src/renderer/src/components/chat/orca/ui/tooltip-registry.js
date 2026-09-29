// One open tooltip at a time (Radix's TOOLTIP_OPEN document event), after
// Orca's components/ui/tooltip.tsx (shadcn/ui, MIT, Copyright (c) 2026
// Lovecast Inc.).
let current = null

export function closeOtherTooltips(self) {
  if (current && current !== self) {
    const close = current
    current = null
    close()
  }
}

export function registerOpenTooltip(close) {
  current = close
}

export function unregisterOpenTooltip(close) {
  if (current === close) current = null
}
