// Provider catalog metadata only: never execute or infer a command locally.
export const COMMAND_LIMITS = { entries: 512, name: 128, text: 512 }
export function commandName(value) {
  if (typeof value !== 'string') return null
  const name = value.replace(/^\//, '')
  return name.length <= COMMAND_LIMITS.name && /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(name)
    ? name
    : null
}
const text = (value) =>
  typeof value === 'string' && value
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, COMMAND_LIMITS.text)
    : undefined
export function normalizeCommands(values) {
  const commands = new Map()
  for (const value of Array.isArray(values) ? values.slice(0, COMMAND_LIMITS.entries * 2) : []) {
    const row = typeof value === 'string' ? { name: value } : value
    const name = commandName(row?.name)
    if (!name || commands.has(name)) continue
    const kind = row.kind === 'skill' ? 'skill' : 'command'
    const description = text(row.description),
      argumentHint = text(row.argumentHint)
    commands.set(name, {
      name,
      kind,
      ...(kind === 'command' && (row.kind !== 'command' || row.kindUnspecified === true)
        ? { kindUnspecified: true }
        : {}),
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {})
    })
    if (commands.size >= COMMAND_LIMITS.entries) break
  }
  return [...commands.values()]
}
export function claudeCommands(frame, previous = []) {
  const known = new Map(previous.map((row) => [row.name, row]))
  const declared = Array.isArray(frame.commands)
    ? frame.commands
    : Array.isArray(frame.slash_commands)
      ? frame.slash_commands
      : previous
  const rows = normalizeCommands(declared).map((row) => ({ ...known.get(row.name), ...row }))
  const skills = normalizeCommands(frame.skills)
  for (const skill of skills) {
    const found = rows.findIndex((row) => row.name === skill.name)
    const row = { ...(found >= 0 ? rows[found] : {}), ...skill, kind: 'skill' }
    delete row.kindUnspecified
    if (found >= 0) rows[found] = row
    else rows.push(row)
  }
  const terminal = new Set(normalizeCommands(frame.terminal_slash_commands).map((row) => row.name))
  return normalizeCommands(rows.filter((row) => !terminal.has(row.name)))
}
