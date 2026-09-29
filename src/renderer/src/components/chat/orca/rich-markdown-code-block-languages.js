// After Orca's components/editor/rich-markdown-code-block-languages.ts (MIT,
// Copyright (c) 2026 Lovecast Inc.): the label a code fence's language shows.
// Only the chat uses it here (NativeChatCodeBlock); the names are proper nouns,
// the same in every language, except "Plain text".
import { t } from '../../../i18n'

const LANGUAGE_ENTRIES = [
  ['', 'chat.orca.codeBlock.plainText', 'Plain text'],
  ['bash', null, 'Bash'],
  ['c', null, 'C'],
  ['cpp', null, 'C++'],
  ['css', null, 'CSS'],
  ['diff', null, 'Diff'],
  ['go', null, 'Go'],
  ['graphql', null, 'GraphQL'],
  ['html', null, 'HTML'],
  ['java', null, 'Java'],
  ['javascript', null, 'JavaScript'],
  ['json', null, 'JSON'],
  ['kotlin', null, 'Kotlin'],
  ['markdown', null, 'Markdown'],
  ['mermaid', null, 'Mermaid'],
  ['python', null, 'Python'],
  ['ruby', null, 'Ruby'],
  ['rust', null, 'Rust'],
  ['scss', null, 'SCSS'],
  ['shell', null, 'Shell'],
  ['sql', null, 'SQL'],
  ['swift', null, 'Swift'],
  ['typescript', null, 'TypeScript'],
  ['xml', null, 'XML'],
  ['yaml', null, 'YAML']
]

export function getCodeBlockLanguages() {
  return LANGUAGE_ENTRIES.map(([value, key, label]) => ({
    value,
    label: key === null ? label : t(key, label)
  }))
}

export function getCodeBlockLanguageLabel(value) {
  const entry = LANGUAGE_ENTRIES.find(([entryValue]) => entryValue === value)
  if (!entry) return value
  return entry[1] === null ? entry[2] : t(entry[1], entry[2])
}

export function isKnownCodeBlockLanguage(value) {
  return LANGUAGE_ENTRIES.some(([entryValue]) => entryValue === value)
}
