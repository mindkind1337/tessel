// Settings > Orchestration: ways to have agents work together through
// Tessel's team tools (after Orca's usage examples). Each is a prompt you give
// the agent that leads a team. The prompts are text for the agents: they stay
// English (i18n-ignore); titles and tool lines are for the person (t()).
import { t } from './i18n'

export const ORCHESTRATION_EXAMPLES = [
  {
    id: 'handoff',
    get title() {
      return t('tasks.orchestration.handoff', 'Hand off a task')
    },
    prompt:
      'Hand this task to the idle teammate (team_members shows who is idle): put a card for them with team_task_add, and send them the goal, what is done and what is left with team_send.' // i18n-ignore
  },
  {
    id: 'phases',
    get title() {
      return t('tasks.orchestration.phases', 'Work in phases')
    },
    prompt:
      'Split this work into phases (plan, backend, UI, tests) as cards with team_task_add, each "after" the one before, and give them to the teammates best suited. Each card starts once the one before it is done.' // i18n-ignore
  },
  {
    id: 'parallel',
    get title() {
      return t('tasks.orchestration.parallel', 'Work in parallel')
    },
    prompt:
      'Split this into independent parts and give one to each idle teammate as a card (team_task_add). Ask each to finish with team_task_done and a short report, then check the reports and put the pieces together.' // i18n-ignore
  },
  {
    id: 'question',
    get title() {
      return t('tasks.orchestration.question', 'Ask and wait for the answer')
    },
    prompt:
      'Before changing the shared code, ask #1 with team_ask whether they are editing it, and wait for their answer.' // i18n-ignore
  },
  {
    id: 'decision',
    get title() {
      return t('tasks.orchestration.decision', 'Let me decide')
    },
    prompt:
      'When a choice is mine to make (a design, a risky change), ask me on the card with team_task_gate and your options, and go on with other work until I answer.' // i18n-ignore
  },
  {
    id: 'workers',
    get title() {
      return t('tasks.orchestration.workers', 'Coordinate workers')
    },
    prompt:
      'Coordinate this as the lead: split it into independent tasks, start one worker per task with team_worker_start (each in its own copy), follow them with team_worker_list and team_worker_read, and when each reports with team_worker_done, review its branch and tell me what is ready to merge.' // i18n-ignore
  }
]

// What each team tool is for, in one line: [name, what] (what in the
// interface's language, read when shown).
function tool(name, what) {
  const row = [name, '']
  Object.defineProperty(row, 1, { get: what, enumerable: true })
  return row
}
export const ORCHESTRATION_TOOLS = [
  tool('team_task_add', () => t('tasks.orchestration.tool.add', 'A card for a teammate; "after" makes it wait for other cards')),
  tool('team_task_done', () => t('tasks.orchestration.tool.done', 'Finish a card with a report: succeeded or failed, what was done, the files')),
  tool('team_ask', () => t('tasks.orchestration.tool.ask', 'Ask one teammate and wait for the answer')),
  tool('team_task_gate', () => t('tasks.orchestration.tool.gate', 'Ask you to decide, on the card')),
  tool('team_send', () => t('tasks.orchestration.tool.send', 'A message to "Ada", "team", or a group: "@claude", "@codex", "@idle", "@all"')),
  tool('team_members', () => t('tasks.orchestration.tool.members', 'Who is in the team: agent, model, working or idle, open cards')),
  tool('team_worker_start', () => t('tasks.orchestration.tool.workerStart', 'The lead starts a worker: a new agent in a new pane, with its card and brief')),
  tool('team_worker_list', () => t('tasks.orchestration.tool.workerList', 'The workers: state, card, own copy, last heartbeat; the limits')),
  tool('team_worker_read', () => t('tasks.orchestration.tool.workerRead', "A worker's recent output, read without disturbing it")),
  tool('team_worker_stop', () => t('tasks.orchestration.tool.workerStop', 'Stop a worker (its pane closes) or cancel one still waiting')),
  tool('team_worker_release', () => t('tasks.orchestration.tool.workerRelease', 'A worker becomes an ordinary teammate; its slot is freed')),
  tool('team_worker_done', () => t('tasks.orchestration.tool.workerDone', 'A worker reports its outcome, once; its coordinator is told')),
  tool('team_heartbeat', () => t('tasks.orchestration.tool.heartbeat', 'A worker says it is still at work, every 5 minutes')),
  tool('team_gates', () => t('tasks.orchestration.tool.gates', 'The decisions asked on the cards, pending or answered'))
]
