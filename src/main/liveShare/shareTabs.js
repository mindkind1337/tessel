// Live Share: the host's editor tabs of a shared project, for its guests (the
// 'tabs' topic). The host's window gives each shared project's open files
// (absolute paths, host-only) and the one on screen; guests get only the
// ones inside the project's folder, as paths from it ("src/app.js"), and
// never one its Files tab hides (shareScope.js: .git and .tessel always,
// secret names and what git ignores while "Hide ignored and secret files
// from guests" is on). A guest opens such a tab through its usual access to
// the project's files (lshare:// paths, read-only without "Edit files").
import { cleanRel } from '../../shared/liveSharePath'
import { relFrom, hiddenByName } from './shareScope.js'

export const TAB_LIMITS = Object.freeze({ tabs: 64, path: 4096 })

// The window's word for one project: { files: [absolute path], active }.
export function cleanHostTabs(raw) {
  if (!raw || typeof raw !== 'object') return { files: [], active: null }
  const ok = (p) => typeof p === 'string' && p.length > 0 && p.length <= TAB_LIMITS.path
  const files = []
  for (const p of Array.isArray(raw.files) ? raw.files : []) {
    if (files.length >= TAB_LIMITS.tabs) break
    if (ok(p) && !files.includes(p)) files.push(p)
  }
  return { files, active: ok(raw.active) && files.includes(raw.active) ? raw.active : null }
}

// The tabs inside the project's folder (info: shareScope's root, { root,
// real }), as paths from it, without what is hidden by its name alone. ->
// { rels, active } (active: the tab on screen's path, or null).
export function tabRels(tabs, info, settings) {
  const rels = []
  let active = null
  if (!info) return { rels, active }
  for (const p of tabs.files) {
    let rel = relFrom(info.root, p)
    if (rel === null) rel = relFrom(info.real, p)
    if (!rel || cleanRel(rel) !== rel || hiddenByName(rel, settings) || rels.includes(rel)) continue
    rels.push(rel)
    if (p === tabs.active) active = rel
  }
  return { rels, active }
}

// rels without the hidden ones (hidden: a Set of them). -> { tabs, active }.
export function guestTabs({ rels, active }, hidden) {
  const tabs = rels.filter((r) => !hidden.has(r))
  return { tabs, active: active && tabs.includes(active) ? active : null }
}

// The guest's side: the host's tabs, checked (a host is not trusted with what
// it sends): paths from the project's folder only, of the known shape.
export function checkTabs(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tabs) || data.tabs.length > TAB_LIMITS.tabs) return null
  const tabs = []
  for (const r of data.tabs) if (typeof r === 'string' && r && cleanRel(r) === r && !tabs.includes(r)) tabs.push(r)
  return { tabs, active: typeof data.active === 'string' && tabs.includes(data.active) ? data.active : null }
}
