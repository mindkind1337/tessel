// i18n-pending: text here does not go through t() yet
// Settings > Orchestration: ways to have agents work together through
// Tessel's team tools (after Orca's usage examples). Each is a prompt you give
// the agent that leads a team.
export const ORCHESTRATION_EXAMPLES = [
  {
    id: 'handoff',
    title: 'Hand off a task',
    prompt:
      'Hand this task to the idle teammate (team_members shows who is idle): put a card for them with team_task_add, and send them the goal, what is done and what is left with team_send.'
  },
  {
    id: 'phases',
    title: 'Work in phases',
    prompt:
      'Split this work into phases (plan, backend, UI, tests) as cards with team_task_add, each "after" the one before, and give them to the teammates best suited. Each card starts once the one before it is done.'
  },
  {
    id: 'parallel',
    title: 'Work in parallel',
    prompt:
      'Split this into independent parts and give one to each idle teammate as a card (team_task_add). Ask each to finish with team_task_done and a short report, then check the reports and put the pieces together.'
  },
  {
    id: 'question',
    title: 'Ask and wait for the answer',
    prompt:
      'Before changing the shared code, ask #1 with team_ask whether they are editing it, and wait for their answer.'
  },
  {
    id: 'decision',
    title: 'Let me decide',
    prompt:
      'When a choice is mine to make (a design, a risky change), ask me on the card with team_task_gate and your options, and go on with other work until I answer.'
  }
]

// What each team tool is for, in one line.
export const ORCHESTRATION_TOOLS = [
  ['team_task_add', 'A card for a teammate; "after" makes it wait for other cards'],
  ['team_task_done', 'Finish a card with a report: succeeded or failed, what was done, the files'],
  ['team_ask', 'Ask one teammate and wait for the answer'],
  ['team_task_gate', 'Ask you to decide, on the card'],
  ['team_send', 'A message to "#3", "team", or a group: "@claude", "@codex", "@idle", "@all"'],
  ['team_members', 'Who is in the team: agent, model, working or idle, open cards']
]
