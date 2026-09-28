// Monaco options that follow Settings > Editor (like Orca's
// diff-editor-whitespace-options.ts and diff-editor-hide-unchanged-options.ts).
import { editorFontStack } from '../settings'

export function editorOptionsFor(s) {
  return {
    fontSize: s.fontSize,
    fontFamily: editorFontStack(s),
    wordWrap: s.editorWordWrap ? 'on' : 'off',
    minimap: { enabled: !!s.editorMinimap }
  }
}

// The diff view: its own word wrap, whitespace at the ends of lines shown or
// ignored, unchanged lines folded behind bands you can expand.
export function diffOptionsFor(s) {
  return {
    ...editorOptionsFor(s),
    minimap: { enabled: false },
    wordWrap: s.diffWordWrap ? 'on' : 'off',
    diffWordWrap: s.diffWordWrap ? 'on' : 'off',
    ignoreTrimWhitespace: s.diffShowWhitespace !== true,
    hideUnchangedRegions: { enabled: s.diffCollapseUnchanged === true }
  }
}
