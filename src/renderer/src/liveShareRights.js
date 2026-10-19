// Live Share: the words for each right of the catalog
// (src/shared/liveShareRights.js), for every place that shows rights as
// checkboxes (an invitation, the accept prompt, a person, a trusted person,
// a project's people, the access grid) and for the guest's summary of what
// it may do. A right the window has no words for is never shown (no bare
// id, no box nobody can read), and a spec checks that every right of the
// catalog has its words. Adding a right: an entry in the catalog, its words
// here, its check in main.
import { RIGHT_IDS, cleanRights, sameRights } from '../../shared/liveShareRights'
import { t } from './i18n'

const WORDS = {
  type: () => ({
    label: t('liveShare.right.type', 'Type in terminals and agents (they can run any command as you)'),
    short: t('liveShare.right.typeShort', 'Type'),
    hint: t('liveShare.right.typeHint', 'Only for people you trust: typing in a terminal runs commands on this PC.'),
    part: t('liveShare.rights.typePart', 'type in its terminals and agents')
  }),
  open: () => ({
    label: t('liveShare.right.open2', 'Open terminals and agents on your computer (they can run commands)'),
    short: t('liveShare.right.openShort', 'Open'),
    hint: t('liveShare.right.openHint', 'Without it, each terminal or agent they ask for waits for your yes.'),
    part: t('liveShare.rights.openPart', 'open terminals and agents')
  }),
  close: () => ({
    label: t('liveShare.right.close', 'Ask to close panes'),
    short: t('liveShare.right.closeShort', 'Close'),
    hint: t('liveShare.right.closeHint', 'An agent, or a terminal where something runs, still waits for your yes.'),
    part: t('liveShare.rights.closePart', 'ask to close panes')
  }),
  usage: () => ({
    label: t('liveShare.right.usage', 'See my usage (plans, % used, reset times)'),
    short: t('liveShare.right.usageShort', 'Usage'),
    hint: t('liveShare.right.usageHint', 'Your plans, how much of each you used and when it resets. Never your accounts or emails.'),
    part: t('liveShare.rights.usagePart', 'see its usage')
  }),
  edit: () => ({
    label: t('liveShare.right.edit', 'Edit files (save, create, rename, move to the Recycle Bin)'),
    short: t('liveShare.right.editShort', 'Edit'),
    hint: t('liveShare.right.editHint2', 'In the projects they see. Agent and tool settings, agent instructions (CLAUDE.md, AGENTS.md, the notes), git hooks and their configs, and .gitignore stay read-only unless they can also type.'),
    part: t('liveShare.rights.editPart', 'edit its files')
  }),
  git: () => ({
    label: t('liveShare.right.git', 'Stage, commit and discard changes (git)'),
    short: t('liveShare.right.gitShort', 'Git'),
    hint: t('liveShare.right.gitHint2', 'In the projects they see, with your git name. Their commits run without your git hooks; push, pull and fetch stay yours.'),
    part: t('liveShare.rights.gitPart', 'stage and commit changes')
  }),
  tasks: () => ({
    label: t('liveShare.right.tasks2', 'Manage tasks (add, move, edit, answer questions, delete for good)'),
    short: t('liveShare.right.tasksShort', 'Tasks'),
    hint: t('liveShare.right.tasksHint2', 'The task board of the projects they see. A deleted card is gone for good; without Type, they answer an agent only with one of the choices it offered.'),
    part: t('liveShare.rights.tasksPart', 'manage its tasks')
  }),
  pagesView: () => ({
    label: t('liveShare.right.pagesView', 'See my browser pages'),
    short: t('liveShare.right.pagesViewShort', 'Pages'),
    hint: t('liveShare.right.pagesViewHint3', 'Guests see the address of your pages and open them on their side, in a browser session of their own (never with your sessions). The pages of the projects they see; a page of your side panel only if you share it. Hidden pages are never sent.'),
    part: t('liveShare.rights.pagesViewPart', 'see its browser pages')
  })
}

export const hasRightWords = (id) => typeof id === 'string' && Object.hasOwn(WORDS, id)

// One right's words ({ label, short, hint, part }), or null.
export const rightWords = (id) => (hasRightWords(id) ? WORDS[id]() : null)

// The rights that let a guest run commands as you (Type): every view that
// shows rights marks them (a red outline, the tag below), so they never look
// like the others.
const DANGER = new Set(['type'])
export const isDangerRight = (id) => DANGER.has(id)
export const dangerTag = () => t('liveShare.right.dangerTag', 'Runs commands as you')

// The rights shown, in the catalog's order (Type first):
// [{ id, label, short, hint, part, danger }].
export function shownRights() {
  return RIGHT_IDS.filter(hasRightWords).map((id) => ({ id, ...WORDS[id](), danger: DANGER.has(id) }))
}

// Which rights are on, in a few words ("Type, Open"; "Watch only").
export function rightsShort(rights) {
  const on = shownRights().filter((r) => rights && rights[r.id] === true)
  return on.length ? on.map((r) => r.short).join(', ') : t('liveShare.right.watchOnly', 'Watch only')
}

// An invitation's rights in one click (its editor's presets): View only
// (watch, nothing else), Collaborate (open, close, edit, commit, tasks and
// see pages; never type or see usage) and Full control (every
// right, typing included). 'custom': rights that are none of them.
export const RIGHTS_PRESETS = Object.freeze({
  view: Object.freeze([]),
  collaborate: Object.freeze(['open', 'close', 'edit', 'git', 'tasks', 'pagesView']),
  full: RIGHT_IDS
})
export function presetRights(id) {
  const on = RIGHTS_PRESETS[id] || []
  const out = {}
  for (const r of RIGHT_IDS) out[r] = on.includes(r)
  return cleanRights(out)
}
export function rightsPreset(rights) {
  for (const id of Object.keys(RIGHTS_PRESETS)) if (sameRights(presetRights(id), rights)) return id
  return 'custom'
}

// A preset's name and what it means, for the presets control (RightsGrid)
// and every summary of someone's rights.
export function presetLabel(id) {
  if (id === 'view') return t('liveShare.invite.presetView', 'View only')
  if (id === 'collaborate') return t('liveShare.invite.presetCollaborate', 'Collaborate')
  if (id === 'full') return t('liveShare.invite.presetFull', 'Full control')
  return t('liveShare.preset.custom', 'Custom')
}
export function presetHint(id, rights) {
  if (id === 'view') return t('liveShare.invite.presetViewHint', 'They watch the shared panes and files, nothing else.')
  if (id === 'collaborate') return t('liveShare.invite.presetCollaborateHint', 'They open terminals and agents, edit files, commit and manage tasks. They never type in your terminals.')
  if (id === 'full') return t('liveShare.invite.presetFullHint', 'Every right, typing included: they can run any command on this PC as you. Only for people you trust.')
  return t('liveShare.invite.presetCustomHint', 'Custom: {{rights}}', { rights: rightsShort(rights) })
}

// Someone's rights in one chip: the preset's name, or "Custom · 4" (how many
// rights are on); danger when they can type. -> { preset, text, title, danger }.
export function rightsSummary(rights) {
  const preset = rightsPreset(rights)
  const count = shownRights().filter((r) => rights && rights[r.id] === true).length
  const text = preset === 'custom' ? t('liveShare.preset.customCount', 'Custom · {{n}}', { n: count }) : presetLabel(preset)
  return { preset, text, title: rightsShort(rights), danger: shownRights().some((r) => r.danger && rights && rights[r.id] === true) }
}
