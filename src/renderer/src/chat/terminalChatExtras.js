// More of the chat view over a terminal agent (terminalChatBridge.js): its
// slash commands shown as "Ran /command" rows, its background-task dock, the
// context window of a Claude model.
// Pure: every input is given.

// ---- Slash commands ------------------------------------------------------------

// A user line that is one slash command ("/compact", "/model haiku"): what the
// agent's file shows for a command run in it (Claude Code writes it once as
// typed and once more as its <command-name> echo, which the reader turns into
// the same text).
const COMMAND = /^\/[A-Za-z][\w:.-]*(?:[ \t][^\r\n]*)?$/
// The same command shown again this soon is the same run (/compact's echo
// comes once the compaction ended, minutes later).
const SAME_RUN_MS = 5 * 60 * 1000
// A command sent from the chat (its local "Ran" row) is the one the file shows
// this close to it.
const MATCH_MS = 2 * 60 * 1000

const commandOf = (e) => (e && e.type === 'user' && e.origin !== 'team' && typeof e.text === 'string' && COMMAND.test(e.text.trim()) ? e.text.trim() : null)

// events -> { events: without the commands' user lines, commands: [{ id,
// command, sentAt }] (one per run, as command markers) }.
export function splitCommandTurns(events) {
  const list = Array.isArray(events) ? events : []
  const kept = []
  const commands = []
  for (const e of list) {
    const command = commandOf(e)
    if (!command) {
      kept.push(e)
      continue
    }
    const at = Number.isFinite(e.at) ? e.at : null
    const last = commands[commands.length - 1]
    if (last && last.command === command && (at === null || last.sentAt === null || Math.abs(at - last.sentAt) <= SAME_RUN_MS)) continue
    commands.push({ id: `file-${e.id}`, command, sentAt: at }) // i18n-ignore
  }
  return { events: commands.length ? kept : list, commands }
}

// The "Ran /command" rows: the file's (each run once; one with no time is
// not placed), and those sent from the chat the file does not show yet.
export function mergeCommandMarkers(local, fromFile) {
  const file = (Array.isArray(fromFile) ? fromFile : []).filter((m) => Number.isFinite(m.sentAt))
  const used = new Set()
  const own = []
  for (const m of Array.isArray(local) ? local : []) {
    const hit = file.find((f, i) => !used.has(i) && f.command === m.command && Math.abs(f.sentAt - m.sentAt) <= MATCH_MS)
    if (hit) used.add(file.indexOf(hit))
    else own.push(m)
  }
  return [...file, ...own].sort((a, b) => a.sentAt - b.sentAt)
}

// ---- Background tasks ------------------------------------------------------------

// A task its agent started this long before a listing is judged by it.
const LISTING_SLACK_MS = 2000

// The dock above the composer (NativeChatStructuredSessionStatus's
// backgroundTasks): the background work the file shows running (tasks: [{ id,
// kind, description, startedAt }]), less what the agent's last Stop no longer
// listed (its hook: ids, listedAt). Stop is not offered: a terminal agent has
// no safe way to stop one task from here (its /tasks panel is a dialog in its
// terminal). working: a turn runs (the dock then speaks quietly).
export function terminalBackgroundTasks(tasks, { ids = null, listedAt = null, working = false } = {}) {
  const listed = Array.isArray(ids) ? new Set(ids) : null
  const live = (Array.isArray(tasks) ? tasks : []).filter((task) => {
    if (!task || typeof task.id !== 'string') return false
    if (!listed || !Number.isFinite(listedAt)) return true
    // Started before the agent's last listing and not in it: over.
    return !(Number.isFinite(task.startedAt) && task.startedAt > 0 && task.startedAt < listedAt - LISTING_SLACK_MS && !listed.has(task.id))
  })
  return {
    show: live.length > 0,
    isMonitoring: !working,
    tasks: live.map((task) => ({
      id: task.id,
      kind: ['agent', 'command', 'monitor', 'workflow'].includes(task.kind) ? task.kind : 'unknown',
      ...(task.description ? { description: task.description } : {}),
      ...(Number.isFinite(task.startedAt) && task.startedAt > 0 ? { startedAt: task.startedAt } : {}),
      stoppable: false
    })),
    settledTasks: [],
    supportsStop: false,
    supportsStopAll: false
  }
}

// ---- Context window --------------------------------------------------------------

// Claude Code's file never says the context window: a model chosen with its
// 1M context ("…[1m]") has 1M, any other Claude model 200k (more used than
// that: it must be 1M). Other models (OpenClaude's other providers): unknown.
const CLAUDE_MODEL = /^(?:claude-|anthropic[/.])?(?:opus|sonnet|haiku|fable)\b|^claude-/i
export function claudeContextWindow(model, usedTokens = 0, agent = 'claude') {
  const name = String(model || '').trim()
  if (/\[1m\]\s*$/i.test(name)) return 1_000_000
  if (name ? !CLAUDE_MODEL.test(name) : agent !== 'claude') return null
  return usedTokens > 200_000 ? 1_000_000 : 200_000
}

// Claude Code's prompt suggestion: after a turn it shows a likely next message
// greyed in its empty prompt ("> ok push the release"), Tab takes it. rows:
// the bottom rows of the screen, [{ text, styled }] where styled[i] says the
// cell at i is drawn dim, in a set colour or inverted (typed text is the
// terminal's default colour). -> the suggestion, or ''.
// The bottom rows of a terminal buffer as promptSuggestionOnScreen reads them.
export function suggestionScreenRows(buf, termRows) {
  const rows = []
  const cell = buf.getNullCell()
  for (let y = buf.baseY + termRows - 1; y >= Math.max(0, buf.baseY + termRows - 12); y--) {
    const line = buf.getLine(y)
    if (!line) continue
    // Cell by cell: a wide character (CJK, emoji) takes two cells and one or
    // two string positions, so the text and its styles are built together.
    let text = ''
    const styled = []
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x, cell)
      if (!c || c.getWidth() === 0) continue // the second half of a wide character
      const chars = c.getChars() || ' '
      const on = !!c.isDim() || !!c.isInverse() || !c.isFgDefault()
      text += chars
      for (let i = 0; i < chars.length; i++) styled.push(on)
    }
    // Trimmed on the right, as translateToString(true) is.
    const end = text.replace(/\s+$/, '').length
    rows.unshift({ text: text.slice(0, end), styled: styled.slice(0, end) })
  }
  return rows
}
const PROMPT_ROW = /^(\s*(?:│\s*)?[>❯]\s+)(\S.*?)\s*(?:│\s*)?$/
// The prompt with nothing in it (rows are trimmed on the right): the search
// stops there, so an older greyed row above (the echo of the last message
// sent) is never taken for a suggestion and sent again by Tab.
const EMPTY_PROMPT_ROW = /^\s*(?:│\s*)?[>❯]\s*(?:│\s*)?$/
export function promptSuggestionOnScreen(rows) {
  for (let i = (Array.isArray(rows) ? rows.length : 0) - 1; i >= 0; i--) {
    const row = rows[i]
    if (row && typeof row.text === 'string' && EMPTY_PROMPT_ROW.test(row.text)) return ''
    const m = row && typeof row.text === 'string' ? PROMPT_ROW.exec(row.text) : null
    if (!m) continue
    const from = m[1].length
    const text = m[2]
    for (let x = 0; x < text.length; x++) {
      if (text[x] !== ' ' && !(row.styled && row.styled[from + x])) return ''
    }
    return text.length <= 500 ? text : ''
  }
  return ''
}
