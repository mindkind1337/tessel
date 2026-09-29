// The Changes tab's folder tree, ported from Orca's source control (MIT,
// Copyright (c) 2026 Lovecast Inc.): source-control-tree.ts,
// source-control-status-sort.ts, shared/file-name-sort.ts and
// listing/directory-action-paths.ts. Pure: ChangesPanel.vue renders it.
//
// A tree node: { type: 'file', key, name, path, entry, area, depth }
//            | { type: 'directory', key, name, path, area, depth, fileCount, children }
import { getDiscardAllPaths, getUnstageAllPaths, isStageableStatusEntry } from './sourceControl'

// numeric: "99 - a" before "100 - b", like the File Explorer; pinned to 'en'
// so every process sorts the same way.
const fileNameCollator = new Intl.Collator('en', { numeric: true })
export function compareFileNames(a, b) {
  const primary = fileNameCollator.compare(a, b)
  if (primary !== 0) return primary
  return a < b ? -1 : a > b ? 1 : 0
}

function conflictRank(entry) {
  if (entry.conflictStatus === 'unresolved') return 0
  if (entry.conflictStatus === 'resolved_locally') return 1
  return 2
}
export function compareGitStatusEntries(a, b) {
  return conflictRank(a) - conflictRank(b) || compareFileNames(a.path, b.path)
}

const splitPathSegments = (path) => String(path || '').split(/[\\/]+/).filter(Boolean)

function makeDirectoryNode(area, path, name, depth) {
  return { type: 'directory', key: `dir::${area}::${path}`, name, path, area, depth, fileCount: 0, children: [], directoryChildren: new Map() }
}

function finalizeDirectoryNode(node, compareEntries) {
  const directories = []
  const files = []
  for (const child of node.children) {
    if (child.type === 'directory') directories.push(finalizeDirectoryNode(child, compareEntries))
    else files.push(child)
  }
  directories.sort((a, b) => compareFileNames(a.name, b.name))
  files.sort((a, b) => compareEntries(a.entry, b.entry))
  const fileCount = files.length + directories.reduce((n, d) => n + d.fileCount, 0)
  return {
    type: 'directory',
    key: node.key,
    name: node.name,
    path: node.path,
    area: node.area,
    depth: node.depth,
    fileCount,
    children: [...directories, ...files]
  }
}

// entries: [{ path, ... }] -> the root's children (folders first, then files).
export function buildSourceControlTree(area, entries, compareEntries = compareGitStatusEntries) {
  const root = makeDirectoryNode(area, '', '', -1)
  for (const entry of entries || []) {
    const segments = splitPathSegments(entry.path)
    if (!segments.length) continue
    let parent = root
    let ancestorPath = ''
    for (let i = 0; i < segments.length - 1; i++) {
      const name = segments[i]
      ancestorPath = ancestorPath ? `${ancestorPath}/${name}` : name
      let dir = parent.directoryChildren.get(name)
      if (!dir) {
        dir = makeDirectoryNode(area, ancestorPath, name, i)
        parent.directoryChildren.set(name, dir)
        parent.children.push(dir)
      }
      parent = dir
    }
    parent.children.push({
      type: 'file',
      key: `${entry.area || area}::${entry.path}`,
      name: segments[segments.length - 1],
      path: segments.join('/'),
      entry,
      area: entry.area || area,
      depth: segments.length - 1
    })
  }
  return finalizeDirectoryNode(root, compareEntries).children
}

// Folder chains with one folder each ("src/renderer/src") become one row,
// like VS Code; depths follow the compacted rows.
export function compactSourceControlTree(nodes) {
  const compactNode = (node, depth) => {
    if (node.type === 'file') return { ...node, depth }
    const names = [node.name]
    let compacted = node
    while (compacted.children.length === 1 && compacted.children[0].type === 'directory') {
      compacted = compacted.children[0]
      names.push(compacted.name)
    }
    return { ...compacted, name: names.join('/'), depth, children: compacted.children.map((c) => compactNode(c, depth + 1)) }
  }
  return (nodes || []).map((n) => compactNode(n, 0))
}

// Collapse state is per section: the pinned Conflicts section gets its own keys.
export function namespaceSourceControlTreeDirectoryKeys(nodes, namespace) {
  const ns = (node) => (node.type === 'file' ? node : { ...node, key: `dir::${namespace}::${node.path}`, children: node.children.map(ns) })
  return (nodes || []).map(ns)
}

// The rows shown: a collapsed folder hides what it holds.
export function flattenSourceControlTree(nodes, collapsedKeys = new Set()) {
  const out = []
  const visit = (node) => {
    out.push(node)
    if (node.type === 'directory' && !collapsedKeys.has(node.key)) for (const c of node.children) visit(c)
  }
  for (const n of nodes || []) visit(n)
  return out
}

export function collectSourceControlTreeFileEntries(node) {
  if (node.type === 'file') return [node.entry]
  const out = []
  const collect = (c) => {
    if (c.type === 'file') out.push(c.entry)
    else c.children.forEach(collect)
  }
  node.children.forEach(collect)
  return out
}

// What a folder row's stage / unstage / discard act on.
export function getSourceControlDirectoryActionPaths(node) {
  const entries = collectSourceControlTreeFileEntries(node)
  return {
    stagePaths: entries.filter(isStageableStatusEntry).map((e) => e.path),
    unstagePaths: getUnstageAllPaths(entries),
    discardPaths: node.area === 'unstaged' || node.area === 'untracked' ? getDiscardAllPaths(entries, node.area) : []
  }
}

// A section's tree rows: compacted, conflicts namespaced, collapsed folders hidden.
export function sectionTreeRows(section, collapsedKeys) {
  let roots = compactSourceControlTree(buildSourceControlTree(section.area, section.items))
  if (section.id === 'conflicts') roots = namespaceSourceControlTreeDirectoryKeys(roots, 'conflicts')
  return flattenSourceControlTree(roots, collapsedKeys)
}

// A section's rows as a flat list (Orca's list view).
export function sectionListRows(section) {
  return section.items.map((entry) => ({ type: 'file', key: `${entry.area}::${entry.path}`, name: entry.path.split('/').pop(), path: entry.path, entry, area: entry.area, depth: 0 }))
}
