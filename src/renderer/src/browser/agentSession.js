// The agents' separate browser session (Settings > Browser): which pages are
// in it, and when it is turned on for the user.

// A new pane opened from a page (a link in a new pane, a popup, Ctrl+Enter)
// keeps the session of the page it came from: a page of the agents' session
// never opens into the user's, with its imported logins.
export function inheritsAgentSession(fromLeaf) {
  return !!(fromLeaf && fromLeaf.kind === 'browser' && fromLeaf.agentSession === true)
}

// After a successful cookie import. The first one turns the separate agent
// session on (imported cookies are the user's logins), unless it is on
// already; later imports leave the user's choice alone. -> true when it was
// turned on now (the import result says so).
export function afterCookieImport(settings) {
  if (settings.cookiesImportedOnce) return false
  settings.cookiesImportedOnce = true
  if (settings.browserAgentSeparateSession) return false
  settings.browserAgentSeparateSession = true
  return true
}
