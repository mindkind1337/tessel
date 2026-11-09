// A file or folder copied on this computer, a file at a time (the explorer's
// drop from Windows and its "Download…"): links and junctions are left out
// (never followed), nothing already there is replaced, and one copy is
// bounded (files, bytes, folders) so a dropped home folder cannot fill the disk.
import fs from 'fs'
import { join, basename } from 'path'

export const LOCAL_LIMITS = Object.freeze({ files: 20000, bytes: 20 * 1024 * 1024 * 1024, folders: 5000 })

// What one copy (or several dropped items together) did so far.
export function copyState() {
  return { files: 0, bytes: 0, folders: 0, links: 0, skipped: 0, cut: false }
}

// src -> dest (dest must not exist). Throws only for the item itself (missing,
// the name taken, unreadable); what fails below a folder is counted as skipped.
export async function copyTree(src, dest, { fsp = fs.promises, limits = LOCAL_LIMITS, progress = () => {}, state = copyState() } = {}) {
  const st = await fsp.lstat(src)
  if (st.isSymbolicLink()) {
    state.links++
    return state
  }
  if (st.isDirectory()) {
    if (state.folders >= limits.folders) {
      state.cut = true
      return state
    }
    await fsp.mkdir(dest)
    state.folders++
    let names = []
    try {
      names = await fsp.readdir(src)
    } catch {
      state.skipped++
    }
    for (const name of names) {
      if (state.cut) break
      try {
        await copyTree(join(src, name), join(dest, name), { fsp, limits, progress, state })
      } catch {
        state.skipped++
      }
    }
    return state
  }
  if (!st.isFile()) {
    state.skipped++
    return state
  }
  if (state.files >= limits.files || state.bytes + st.size > limits.bytes) {
    state.cut = true
    return state
  }
  await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL)
  state.files++
  state.bytes += st.size
  progress({ done: state.files, name: basename(src) })
  return state
}
