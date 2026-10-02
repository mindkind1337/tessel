// The props of NativeChatComposer (and of the pane it keys on paneKey), after
// Orca's native-chat-composer-types.ts NativeChatComposerProps (MIT,
// Copyright (c) 2026 Lovecast Inc.), for Tessel's structured chat: no PTY,
// no launch seed, no mobile lease; the session's actions come as callbacks.
export const nativeChatComposerProps = {
  // Stable pane identity: the draft (and its skill pills) is kept per pane.
  paneKey: { type: String, required: true },
  // 'claude' | 'codex': the agent's slash commands and skill prefix.
  agent: { type: String, default: 'claude' },
  // Shown in the placeholder ("Message Claude…").
  agentName: { type: String, default: 'Claude' }, // i18n-ignore product name
  // Tessel: the next message the agent suggests (Claude Code's greyed prompt
  // suggestion): the placeholder while the draft is empty; Tab takes it.
  promptSuggestion: { type: String, default: '' },
  // v-model: the draft (undefined = not bound).
  modelValue: { type: String, default: undefined },
  // A turn runs: the Send button becomes Stop, Escape interrupts, and a
  // message sent now goes at once (Claude, Codex) or waits for the end of
  // the turn (OpenCode).
  isWorking: { type: Boolean, default: false },
  // Why nothing can be typed or sent now ('' = it can).
  disabledReason: { type: String, default: '' },
  // Why Send waits for now ('' = it does not); typing still works.
  sendBlockedReason: { type: String, default: '' },
  // (text) => { ok: true } | { ok: false, error } (or a promise of it). The
  // draft is cleared only on ok: true; anything else keeps it.
  send: { type: Function, default: undefined },
  // Typed "/model x", "/effort x", "/permissionMode x": ({ [optionId]: value })
  // => { ok: true } before anything is shown as changed.
  setOption: { type: Function, default: undefined },
  // A bare "/model", "/effort", "/permissionMode" (typed or picked): (name) =>
  // { ok: true } once a picker opened; without it the draft stays.
  onOptionCommand: { type: Function, default: undefined },
  // Permission rules for a typed "/permissionMode" (the main process decides too).
  chatLaunchYolo: { type: Boolean, default: false },
  maxPermissions: { type: String, default: undefined },
  // The session's "/" surface [{ name, kind: 'command' | 'skill', description?,
  // argumentHint? }]; undefined = the agent's text-driven commands only.
  commands: { type: Array, default: undefined },
  // Host conversation actions ('clear', 'compact') offered in the picker.
  conversationCommands: { type: Array, default: () => [] },
  // { discover({ agent, pane, refresh, signal }) => { skills, sources } }.
  skillsOptions: { type: Object, default: undefined },
  // Images (paste, drop, the + button): chips sent with the message as ids
  // (send(text, { images })). false hides chips and Attach, and a pasted
  // image is refused with a notice.
  allowImages: { type: Boolean, default: false },
  // The session's context usage (StructuredAgentContextUsage) or null.
  contextUsage: { type: Object, default: null },
  // The session option pickers (lot 6): the reference's surface/snapshot/
  // request, plus any props of Tessel's pickers.
  sessionOptionsSurface: { type: Object, default: null },
  sessionOptionsSnapshot: { type: Array, default: () => [] },
  sessionOptionsPickerRequest: { type: Object, default: null },
  sessionOptionsProps: { type: Object, default: () => ({}) },
  // Tessel: the mic starts Windows voice typing into the composer (focused
  // first); undefined hides it. dictationTitle: its words (the language).
  dictate: { type: Function, default: undefined },
  dictationTitle: { type: String, default: undefined },
  // Tessel: the "@" menu's files, (query) => [relative paths] (best first);
  // undefined keeps the plain "Referencing file:" hint.
  mentionSuggest: { type: Function, default: undefined },
  // Clipboard text for pasteFromClipboard() (default: shellApi.readClipboard).
  readClipboardText: { type: Function, default: undefined },
  // A dropped OS file -> its path (default: shellApi.pathForFile).
  pathForFile: { type: Function, default: undefined }
}

export const nativeChatComposerEmits = ['update:modelValue', 'interrupt', 'error', 'attach', 'slashCommand', 'sent']
