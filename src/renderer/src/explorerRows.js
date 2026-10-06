// The rows of the Files tree (ExplorerPanel.vue), after VS Code's explorer
// (src/vs/workbench/contrib/files/browser/views/explorerViewer.ts, MIT,
// Copyright (c) Microsoft Corporation):
//
// - Compact folders (VS Code's explorer.compactFolders): a folder holding a
//   single folder shares its row with it, "a / b / c". The row stands for its
//   last folder: it is open when that one is, and its children follow it.
//   Only folders already read are joined; nothing is read to build a row.
// - The geometry: 22 px rows, 8 px of indentation per level, a 16 px twistie,
//   and thin indent guides under each open folder's twistie.

export const ROW_HEIGHT = 22
export const INDENT = 8 // per level (VS Code's workbench.tree.indent)
export const BASE_INDENT = 8 // before the first level's twistie
export const TWISTIE = 16

// Left padding of a row at this depth (0 = the root's children).
export const rowPadding = (depth) => BASE_INDENT + depth * INDENT
// The x of the guide drawn for an open folder at this depth: under the
// middle of its twistie.
export const guideX = (depth) => BASE_INDENT + depth * INDENT + TWISTIE / 2

// nodes: dir path -> { entries } (folders read so far); open: dir path -> true.
// hidden(entry): left out of the tree (git-ignored files when hidden).
// noJoin: paths that never share a row (an entry being renamed, a folder
//   getting a new child: each stands on its own row while edited).
// Returns { rows, index } where index maps every shown path (each folder of a
// compact row too) to its row number.
export function buildRows({ root, nodes, open, compact = true, hidden = null, noJoin = null }) {
  const rows = []
  const index = new Map()
  if (!root) return { rows, index }
  const visible = (dir) => {
    const n = nodes[dir]
    if (!n || !n.entries) return null
    return hidden ? n.entries.filter((e) => !hidden(e)) : n.entries
  }
  const alone = (p) => !!(noJoin && noJoin.has(p))
  const walk = (dir, depth) => {
    const entries = visible(dir)
    if (!entries) return
    for (const e of entries) {
      const chain = [e]
      if (compact && e.dir && !alone(e.path)) {
        let cur = e
        for (let guard = 0; guard < 256; guard++) {
          const kids = visible(cur.path)
          if (!kids || kids.length !== 1 || !kids[0].dir || alone(kids[0].path)) break
          cur = kids[0]
          chain.push(cur)
        }
      }
      const last = chain[chain.length - 1]
      const row = { path: last.path, name: last.name, dir: !!last.dir, depth, entry: last, chain, parent: dir, open: !!(last.dir && open[last.path]) }
      const n = rows.push(row) - 1
      for (const c of chain) index.set(c.path, n)
      if (row.open) walk(last.path, depth + 1)
    }
  }
  walk(root, 0)
  return { rows, index }
}

// The folders a click on a compact row opens or closes: all of them, so the
// tree looks the same with compact folders turned off.
export function toggledPaths(row) {
  return row.dir ? row.chain.map((e) => e.path) : []
}

// After a folder opens, its sole sub-folder opens too (VS Code's
// autoExpandCompressedChildren), and so on: the next folder to open, or null.
export function soleSubfolder(nodes, dir, hidden = null) {
  const n = nodes[dir]
  if (!n || !n.entries) return null
  const kids = hidden ? n.entries.filter((e) => !hidden(e)) : n.entries
  return kids.length === 1 && kids[0].dir ? kids[0] : null
}

// The guide shown brighter (VS Code's active indent guide): the one under the
// selected open folder, or else under its parent folder. Returns
// { depth, from, to }: rows from..to-1 draw it at guideX(depth), or null.
export function activeGuide(rows, index, selected) {
  if (!selected || !index.has(selected)) return null
  const i = index.get(selected)
  const row = rows[i]
  let owner = -1
  if (row.dir && row.open && i + 1 < rows.length && rows[i + 1].depth > row.depth) owner = i
  else
    for (let j = i - 1; j >= 0; j--)
      if (rows[j].depth < row.depth) {
        owner = j
        break
      }
  if (owner < 0) return null
  const depth = rows[owner].depth
  let to = owner + 1
  while (to < rows.length && rows[to].depth > depth) to++
  return to > owner + 1 ? { depth, from: owner + 1, to } : null
}

// The segment of a row a path is (its last one when it is not in the row).
export function segmentOf(row, path) {
  const i = row.chain.findIndex((e) => e.path === path)
  return i < 0 ? row.chain.length - 1 : i
}
