// Injection keys of the compound ui/ primitives (one small context each,
// like Radix's createContext per primitive).
export const COLLAPSIBLE = Symbol('nc-ui-collapsible')
export const DIALOG = Symbol('nc-ui-dialog')
export const POPOVER = Symbol('nc-ui-popover')
export const TOOLTIP_PROVIDER = Symbol('nc-ui-tooltip-provider')
export const TOOLTIP = Symbol('nc-ui-tooltip')
export const MENU = Symbol('nc-ui-menu')
export const MENU_CONTENT = Symbol('nc-ui-menu-content')
export const MENU_SUB = Symbol('nc-ui-menu-sub')
export const MENU_RADIO_GROUP = Symbol('nc-ui-menu-radio-group')

export function required(value, component, parent) {
  if (!value) throw new Error(`<${component}> must be used within <${parent}>`)
  return value
}
