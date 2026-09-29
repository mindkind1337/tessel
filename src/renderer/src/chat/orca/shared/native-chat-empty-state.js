// After Orca's src/shared/native-chat-empty-state.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Canonical English copy for the native-chat empty/loading/error states (the
// i18n fallback strings, each line marked i18n-ignore: t() translates them).
// `{{value0}}` is the agent label; each caller
// substitutes it (t() in the renderer, formatNativeChatEmptyStateCopy elsewhere).
export const NATIVE_CHAT_EMPTY_STATE_COPY = {
  loading: {
    title: 'Loading conversation…', // i18n-ignore
    subtitle: 'Reading the agent transcript.' // i18n-ignore
  },
  empty: {
    title: 'Start a chat with {{value0}}', // i18n-ignore
    subtitle: 'Ask {{value0}} to inspect code, explain output, or make a change.' // i18n-ignore
  },
  error: {
    title: 'Could not load conversation', // i18n-ignore
    subtitle: 'The transcript could not be read. Toggle back to the terminal to keep working.' // i18n-ignore
  },
  notAgent: {
    title: 'No conversation here', // i18n-ignore
    subtitle: 'This terminal is not running a recognized coding agent.' // i18n-ignore
  }
}

// The copy with the agent label substituted for `{{value0}}`, for callers
// without an i18n layer.
export function formatNativeChatEmptyStateCopy(kind, agentLabel) {
  const copy = NATIVE_CHAT_EMPTY_STATE_COPY[kind]
  return {
    title: copy.title.replaceAll('{{value0}}', agentLabel),
    subtitle: copy.subtitle.replaceAll('{{value0}}', agentLabel)
  }
}
