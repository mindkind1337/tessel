// After Orca's native-chat-prompt-editor.test-support.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Helpers for specs that drive the TipTap prompt editor through its element.
import { promptTextContent, promptTextMap } from '../native-chat-prompt-document.js'

export function promptEditor(element) {
  return element.editor
}

export function promptValue(element) {
  return promptTextMap(promptEditor(element).state.doc).text
}

// Like typing: a real content change (emits the editor's update → change).
export function changePrompt(element, value) {
  promptEditor(element).commands.setContent(promptTextContent(value))
}
