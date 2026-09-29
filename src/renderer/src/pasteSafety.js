// A multi-line text typed into a terminal whose program did not ask for
// bracketed paste arrives line by line: if the agent has returned to its
// shell, each line (page text, notes) would run as a command.
// pane: a TerminalPane's paneApi (paneRegistry), or nothing.
// -> true when the text must not be pasted there.
export function unsafeMultilinePaste(text, pane) {
  if (!/[\r\n]/.test(String(text == null ? '' : text))) return false
  const bracketed = pane && typeof pane.bracketedPaste === 'function' ? pane.bracketedPaste() : null
  // Unknown (no terminal yet): the delivery path decides, as before.
  return bracketed === false
}
