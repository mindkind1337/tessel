// An editor tab's name, shared by the editor (EditorPane.vue) and the line of
// tabs above the panes (ViewTabs.vue): its file's name, with its folder when
// another open file has the same name, and what a diff shows ("name (diff)",
// "name (staged diff)", a commit, a branch, a version Local History kept).
// After Orca's editor-labels.ts.
import { t } from '../i18n'
import { fileName, docPathOf } from './editorTabs'
import { localDiffLabel } from '../explorer/timeline'

// files: the editor's open files (the name clashes are found among them).
export function baseLabel(f, files) {
  const name = fileName(docPathOf(f))
  const twins = (files || []).filter((o) => fileName(docPathOf(o)).toLowerCase() === name.toLowerCase() && !!o.diff === !!f.diff)
  if (twins.length < 2) return name
  const parts = docPathOf(f).split(/[\\/]/)
  return parts.length > 1 ? `${name} · ${parts[parts.length - 2]}` : name
}

export function tabLabel(f, files) {
  if (!f.diff) return baseLabel(f, files)
  if (f.diff.area === 'branch')
    return t('editor.tab.branchDiff', '{{name}} ({{base}}..{{commit}})', {
      name: baseLabel(f, files),
      base: String(f.diff.base || '').slice(0, 7),
      commit: String(f.diff.commit || '').slice(0, 7)
    })
  if (f.diff.area === 'commit')
    return t('editor.tab.commitDiff', '{{name}} ({{commit}})', { name: baseLabel(f, files), commit: String(f.diff.commit || '').slice(0, 7) })
  if (f.diff.area === 'local') return localDiffLabel(baseLabel(f, files), f.diff.localTime)
  if (f.diff.area === 'agent') return t('editor.tab.agentDiff', '{{name}} (agent edit)', { name: baseLabel(f, files) })
  return f.diff.area === 'staged'
    ? t('editor.tab.stagedDiff', '{{name}} (staged diff)', { name: baseLabel(f, files) })
    : t('editor.tab.diff', '{{name}} (diff)', { name: baseLabel(f, files) })
}
