// The command line that continues an Antigravity IDE conversation in a new
// Antigravity CLI (agy) conversation: agy's own first-prompt flag with fixed
// words and the path of the prompt file Tessel wrote for it
// (src/main/antigravityIdeHistory.js), never the history itself. The path
// follows the automations' rule (automations.js): only characters no shell
// reads as special between double quotes, anything else refused.
// After Orca's antigravityTranscriptReferencePrompt and IDE-reference startup
// (agy --prompt-interactive), MIT, Copyright (c) 2026 Lovecast Inc.
import { WIN_PATH, WSL_PATH, wslPath } from './automations'

export function agyContinuePrompt(file) {
  // Sent to the agent: stays English.
  return `Tessel: continue an earlier Antigravity IDE conversation. Read the file ${file}, follow the note at its top, then continue from where that conversation left off.` // i18n-ignore
}

// ' --prompt-interactive "..."' for the pane's shell ('wsl' reads
// /mnt/<drive>/ paths), or '' when it cannot be given safely.
export function agyContinueLaunchArgs(promptFile, shellId = null) {
  let file = typeof promptFile === 'string' ? promptFile : ''
  if (shellId === 'wsl') {
    file = wslPath(file)
    if (!file || !WSL_PATH.test(file)) return ''
  } else if (!WIN_PATH.test(file)) return ''
  return ` --prompt-interactive "${agyContinuePrompt(file)}"`
}
