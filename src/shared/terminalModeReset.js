// Reset Terminal: the bytes that put a terminal back on its "no program owns
// it" baseline, after Orca's src/shared/terminal-mode-reset-profiles.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.).
//
// Why shared: the pane (xterm.js) and the terminal host's invisible screen
// (ptyHost.js) must clear the same modes, or the next re-attach replays a mode
// the pane just cleared. These bytes go into the terminal emulators only,
// never to the program, so whatever runs in the terminal keeps running.

const RELEASE_SYNCHRONIZED_OUTPUT = '\x1b[?2026l'
const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
// DECSC first: xterm's ?1049l restores the cursor even on the normal buffer.
const SAVE_GROUNDED_CURSOR = '\x1b7'
const LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR = `${SAVE_GROUNDED_CURSOR}\x1b[?1049l`
// Mouse protocols 9/1000/1002/1003 and encodings 1006/1016, then UTF-8/urxvt.
const RESET_MOUSE_REPORTING = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'
const RESET_LEGACY_MOUSE_ENCODINGS = '\x1b[?1005l\x1b[?1015l'
const RESET_FOCUS_REPORTING = '\x1b[?1004l'
const RESET_BRACKETED_PASTE = '\x1b[?2004l'
const RESET_APPLICATION_CURSOR_AND_KEYPAD = '\x1b[?1l\x1b[?66l'
const SHOW_CURSOR = '\x1b[?25h'
const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
const RESET_GRAPHIC_RENDITION = '\x1b[0m'

/**
 * Clears the input modes a program left on (synchronized output, Kitty
 * keyboard, alternate screen, mouse, focus, bracketed paste, application
 * cursor/keypad, hidden cursor, cursor style, colours). Kitty is reset on both
 * sides of ?1049l because its flags are kept per screen. `keepFocusReporting`:
 * a local ConPTY turns focus reporting on for the terminal's whole life.
 */
export function buildInputModeReset({ keepFocusReporting = false } = {}) {
  const focus = keepFocusReporting ? '' : RESET_FOCUS_REPORTING
  return `${RELEASE_SYNCHRONIZED_OUTPUT}${RESET_KITTY_KEYBOARD_PROTOCOL}${LEAVE_ALTERNATE_SCREEN_KEEPING_NORMAL_CURSOR}${RESET_MOUSE_REPORTING}${RESET_LEGACY_MOUSE_ENCODINGS}${focus}${RESET_BRACKETED_PASTE}${RESET_APPLICATION_CURSOR_AND_KEYPAD}${SHOW_CURSOR}${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}${RESET_GRAPHIC_RENDITION}${SAVE_GROUNDED_CURSOR}`
}
