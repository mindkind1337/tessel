// What a person connects through Tessel replaces the same service from another vendor's connector, in
// Tessel's panes: agents then use Tessel's, with its cards. Only that service: every other tool of
// theirs stays. Each name in its own option, so no comma or quote has to survive whichever shell the
// line is typed in, and with = so that no later word of the line can be taken for one more name.
//
// Claude Code names a connector's tools mcp__claude_ai_<name>; a name it does not have is ignored.
// Codex turns one off by its id (apps.<id>.enabled in its config reference), read from its own app
// directory; a service with no id here keeps Codex's connector until its id is known.
const REPLACED = {
  google: {
    claude: ['Gmail', 'Google_Calendar', 'Google_Drive'],
    codex: ['connector_2128aebfecb84f64a069897515042a44', 'connector_947e0d954944416db111db556030eea6', 'connector_5f3c8c41a1e54ad7a76272c89e2554fa']
  },
  microsoft: {
    claude: ['Microsoft_365', 'Outlook'],
    codex: ['connector_4aaab2856305417b993eca9a216aaf6e', 'connector_e6a7394682e24467ac68c60696f275a4']
  },
  github: { claude: ['GitHub'], codex: ['connector_76869538009648d5b282a4bb21c3d157'] },
  dropbox: { claude: ['Dropbox'], codex: [] },
  notion: { claude: ['Notion'], codex: [] },
  linear: { claude: ['Linear'], codex: [] },
  atlassian: { claude: ['Atlassian', 'Atlassian_Rovo'], codex: ['connector_692de805e3ec8191834719067174a384'] },
  sentry: { claude: ['Sentry'], codex: [] },
  vercel: { claude: ['Vercel'], codex: ['connector_690a90ec05c881918afb6a55dc9bbaa1'] },
  stripe: { claude: ['Stripe'], codex: [] }
}

// agent: claude or codex. connected: the services connected through Tessel ('google', 'github'...).
// -> the command-line words that turn off those services' other connectors.
export function otherConnectorsOff(agent, connected = []) {
  const out = []
  for (const service of new Set(connected)) {
    const replaced = Object.hasOwn(REPLACED, service) ? REPLACED[service] : null
    if (!replaced) continue
    if (agent === 'claude') for (const name of replaced.claude) out.push(`--disallowedTools=mcp__claude_ai_${name}`)
    if (agent === 'codex') for (const id of replaced.codex) out.push('-c', `apps.${id}.enabled=false`)
  }
  return out
}
