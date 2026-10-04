// The Node.js that runs Tessel's hooks, plugins and team tools, as an absolute
// path found at install time.
//
// Never "node" by bare name: on Windows, a command run by bare name from the
// project folder (a hook's working directory) runs a node.exe, node.bat or
// node.cmd sitting in that folder, so any cloned repository could plant one.
// Only PATH entries are searched, never the current directory: relative
// entries (".", "bin") and one naming the current directory are skipped, as
// are UNC paths (\\server\share: a hook command could not quote them for every
// shell). On Windows only a real node.exe is taken (a .cmd or .bat is run
// through cmd.exe, and a spawn without a shell cannot run it at all).
import fs from 'fs'
import path from 'path'
import { t } from './i18n'

// Characters no quoting used in hook commands carries safely in every shell
// that runs them (cmd.exe expands % and !, PowerShell and bash expand $ and `,
// and " would end the quoted path). Control characters (CR, LF...) too.
export const UNSAFE_PATH_CHARS = /["`$%!\x00-\x1f]/
export const unsafePath = (p) => typeof p !== 'string' || !p || UNSAFE_PATH_CHARS.test(p)

const winAbsolute = (p) => /^[A-Za-z]:[\\/]/.test(p)

function defaultIsFile(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

// The same folder, as Windows or POSIX compares them.
function sameDir(a, b, win) {
  if (!a || !b) return false
  const p = win ? path.win32 : path.posix
  const norm = (d) => {
    const r = p.resolve(d).replace(/[\\/]+$/, '')
    return win ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

// -> the absolute path of node (node.exe on Windows) on PATH, or null.
export function findNode({ env = process.env, platform = process.platform, cwd = process.cwd(), isFile } = {}) {
  const win = platform === 'win32'
  const p = win ? path.win32 : path.posix
  const exists = isFile || ((file) => defaultIsFile(file, platform))
  const key = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH')
  const entries = String((key && env[key]) || '').split(win ? ';' : ':')
  for (const raw of entries) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim()
    if (!dir) continue
    if (win ? !winAbsolute(dir) : !dir.startsWith('/')) continue
    if (sameDir(dir, cwd, win)) continue
    const file = p.join(dir, win ? 'node.exe' : 'node')
    if (unsafePath(file)) continue
    if (exists(file)) return file
  }
  return null
}

export const noNodeError = () =>
  t('main.hooks.noNode', 'Node.js (node.exe) was not found in a folder on PATH, so Tessel did not install its agent hooks. Install Node.js, then restart Tessel.')
export const unsafePathError = () =>
  t('main.hooks.statusPath', 'The hook script path cannot be safely quoted for this agent.')

// Before any hook is written: the script and node paths checked, node found
// (`node` given: that one, else PATH's). -> { node } or { error }
export function hookNode(scriptPath, node, env = process.env) {
  if (unsafePath(scriptPath)) return { error: unsafePathError() }
  const exe = node === undefined ? findNode({ env }) : node
  if (!exe) return { error: noNodeError() }
  if (unsafePath(exe) || !(winAbsolute(exe) || exe.startsWith('/'))) return { error: unsafePathError() }
  return { node: exe }
}

// A path as the first word of a command that cmd.exe, PowerShell and bash all
// run as a program: C:\Program Files\nodejs\node.exe -> C:/"Program
// Files/nodejs/node.exe". A command starting with a quote is an expression
// in PowerShell (Gemini CLI runs its hooks there), and bash eats unquoted
// backslashes: the drive stays outside the quotes and / separates the folders.
export function commandWord(file) {
  const m = /^([A-Za-z]:)[\\/](.*)$/.exec(file)
  return m ? `${m[1]}/"${m[2].replace(/\\/g, '/')}"` : `"${file}"`
}

// Tessel's hook command: node, the script, its arguments.
export const hookCommand = (node, scriptPath, args) => `${commandWord(node)} "${scriptPath}"${args ? ` ${args}` : ''}`

// For an agent that runs a hook as Go's exec.Command("cmd", "/c", command)
// on Windows (Antigravity CLI): Go quotes that argument with the C runtime's
// rules, so every " in the command reaches cmd.exe as \" and the usual forms
// above fail ("'C:/\"Program Files/nodejs/node.exe\"' is not recognized";
// its localized message is not even UTF-8 and stops the agent's turn).
// cmd.exe, Go-quoted or not, and PowerShell all run C:\"Program
// Files\nodejs"\node.exe: the quotes only around its folder. The file name
// and every argument then go without quotes, so none may hold a space.
// -> the word, or null when it cannot be written so.
export function cmdCommandWord(file) {
  const path = String(file || '').replace(/\//g, '\\')
  if (!/\s/.test(path)) return path
  const m = /^([A-Za-z]:)\\(.+)\\([^\\]+)$/.exec(path)
  if (!m || /\s/.test(m[3])) return null
  return `${m[1]}\\"${m[2]}"\\${m[3]}`
}
export function goCmdHookCommand(node, scriptPath, args) {
  const word = cmdCommandWord(node)
  if (!word || typeof scriptPath !== 'string' || !scriptPath || /\s/.test(scriptPath)) return null
  return `${word} ${scriptPath}${args ? ` ${args}` : ''}`
}

// The code of a plugin (OpenCode, Amp, Pi) that picks the node to run: the
// one running the plugin when it is node itself (not Bun or an agent's own
// binary), else the one found at install time.
export function pluginNodeSource(node) {
  return `(() => {
  const exe = String(process.execPath || '')
  const name = (exe.split(/[\\\\/]/).pop() || '').toLowerCase()
  return (name === 'node' || name === 'node.exe') && (exe.startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(exe)) ? exe : ${JSON.stringify(node)}
})()`
}
