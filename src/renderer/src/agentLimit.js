// Spot an agent that has hit its usage limit, from the last lines on its
// screen. Each CLI words it differently:
//   Codex:       "You've hit your usage limit. ... try again at 8:47 PM."
//   Claude Code: "Claude usage limit reached. Your limit will reset at 5pm",
//                "5-hour limit reached ∙ resets 3pm (America/Toronto)"
//   Gemini:      "Quota exceeded ...", "You have exhausted your daily quota"
// Only these exact phrasings count, so an agent that merely talks about
// limits is not flagged.

const LIMIT_PATTERNS = [
  /you['’]ve hit your usage limit/i,
  /\busage limit reached\b/i,
  /\b(?:5-hour|five-hour|weekly|session|opus|sonnet) limit reached\b/i,
  /you['’]ve reached your (?:usage|weekly|session|5-hour) limit/i,
  /\bquota exceeded\b/i,
  /you have exhausted your (?:daily )?quota/i,
  /\bRESOURCE_EXHAUSTED\b/
]

const RESET_PATTERNS = [
  // "try again at 8:47 PM", "reset at 5pm", "resets 3pm (America/Toronto)"
  /(?:try again at|resets? at|resets|reset at)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:[ap]m|[ap]\.m\.))/i,
  // "try again in 2 days 3 hours", "resets in 45 minutes"
  /(?:try again|resets?) in\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?)\s*,?\s*(?:and\s*)?)+)/i,
  // "resets Oct 3, 9am", "try again on Oct 3"
  /(?:try again on|resets? on|resets)\s+([A-Z][a-z]{2,8}\.? \d{1,2}(?:,? \d{1,2}(?::\d{2})?\s*[ap]m)?)/
]

// -> null, or { reset: '8:47 PM' | 'in 2 days 3 hours' | '' }
export function detectLimit(text) {
  const s = String(text || '')
  if (!LIMIT_PATTERNS.some((re) => re.test(s))) return null
  for (const re of RESET_PATTERNS) {
    const m = re.exec(s)
    if (m) {
      const when = m[1].replace(/\s+/g, ' ').replace(/[\s,]+$/, '').trim()
      // Preserve the CLI's English reset phrase in the shared agent-state protocol.
      return { reset: re === RESET_PATTERNS[1] ? `in ${when}` : when } // i18n-ignore
    }
  }
  return { reset: '' }
}

// What agent CLIs show while they wait for the user to approve something
// (Codex, Claude Code, Gemini; Cursor's input line: "Waiting for decision
// (y/n/p)..."; Antigravity's titles: "Run this command?", "Allow access to
// this URL?", "Allow calling this tool?", "Approve this action?"). Typing into
// such a prompt could answer it.
const APPROVAL_PATTERNS =
  /Would you like to (run|make|apply)|Press enter to confirm|Do you want to (proceed|make|create|allow|run)|Do you trust (the files|the contents|this)|Allow execution|Apply this change|\(y\/n\)|\(y\/n\/p\)|\[y\/N\]|Run this command\?|Allow access to this URL\?|Allow calling this tool\?|Approve this action\?/i

// Codex's menu after a Plan-mode turn ("Implement this plan?", then "1. Yes,
// implement this plan", ..., "3. No, stay in Plan mode" and its key row
// "enter select · esc back"). It owns the keyboard although Codex's Stop hook
// has already fired, so a message typed into it would pick a choice. Codex
// leaves the menu's text on screen once answered, so it counts only while its
// key row is the last line. After Orca's plan_implement_menu anchor in
// src/main/runtime/agent-state-rules/codex.json (MIT, Copyright (c) 2026
// Lovecast Inc.).
function codexPlanMenu(text) {
  const at = text.search(/implement\s*this\s*plan\?/i)
  if (at < 0) return false
  const after = text.slice(at)
  if (!/no,\s*stay\s*in\s*plan\s*mode/i.test(after)) return false
  const lines = after.split(/\r?\n/).filter((line) => line.trim())
  return /enter\s*(?:to\s*)?select\s*·\s*esc\s*(?:to\s*)?back\s*$/i.test(lines[lines.length - 1] || '')
}

export function detectApproval(text) {
  const s = String(text || '')
  return APPROVAL_PATTERNS.test(s) || codexPlanMenu(s)
}

// An agent working on a task says it is finished with a line that holds
// only the word TASK_COMPLETE (an agent's bullet before it, a period after
// it). The task's instructions spell it in two parts, and a sentence that
// merely mentions it ("I will print TASK_COMPLETE when done") does not count.
export function detectTaskDone(text) {
  return String(text || '')
    .split(/\r?\n/)
    .some((line) => /^\s*(?:[●⏺•*>-]\s*)?TASK_COMPLETE\.?\s*$/.test(line))
}
