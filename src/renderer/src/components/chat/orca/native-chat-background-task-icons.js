// After Orca's NativeChatBackgroundTasksStatus.tsx, KIND_ICONS (MIT, Copyright (c) 2026 Lovecast Inc.)
// Shared with the transcript row so a task reads as the same thing in the
// strip above the composer and in the row that outlives it.
import { Activity, Bot, CircleHelp, SquareTerminal, Workflow } from 'lucide-vue-next'

export const KIND_ICONS = {
  agent: Bot,
  command: SquareTerminal,
  monitor: Activity,
  workflow: Workflow,
  unknown: CircleHelp
}

/** Monitoring is a STATE the app colours the same on every surface (the amber
 *  heartbeat of AgentStateDot), so the strip matches it; the other kinds are
 *  plain markers and stay neutral. `dimmed` is the running-turn treatment.
 *  Returns a class of the strip's stylesheet. */
export function kindIconTone(kind, dimmed) {
  const tone = kind === 'monitor' ? 'nc-kind-tone--monitor' : 'nc-kind-tone--muted'
  return dimmed ? `${tone} nc-kind-tone--dimmed` : tone // i18n-ignore
}
