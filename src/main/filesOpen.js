// "Open outside Tessel" on a file (files:open): Shift+click on a terminal
// file link, the chat's file chips, the editor's and the Files panel's
// "open externally". VS Code at the line when installed; else the file's own
// program, but only for media and documents (the same allowlist as the
// chat's links, chatFileLinks.js). Never a program, a script, a shortcut or
// anything Windows would run or follow; never a folder (folders go to the
// Files panel). A file Tessel won't hand to the system comes back as
// reason 'editor': the window opens it in Tessel's own editor instead.
// No Electron import: shell, fs and the VS Code launcher are passed in, so
// this stays testable in Node.
import fsDefault from 'fs'
import { dirname, join, isAbsolute } from 'path'
import { chatPathProblem, chatPathExt, isSystemOpenFile, BLOCKED_TEXT_EXTENSIONS, TEXT_ONLY_SCRIPT_EXTENSIONS } from '../shared/chatFileLinks'
import { t } from './i18n'

// Characters cmd.exe reads as commands or variables: a path with one of them
// never goes through code.cmd (VS Code then starts without cmd, below).
export const CMD_SPECIAL = /[&|<>^%"!]/

function refused(reason) {
  const error =
    reason === 'executable'
      ? t('main.filesOpen.executable', 'Tessel never opens programs, scripts or shortcuts.')
      : reason === 'folder'
        ? t('main.filesOpen.folder', 'Folders open in the Files panel, not with another program.')
        : reason === 'network'
          ? t('main.filesOpen.network', 'Network and device paths are never opened.')
          : reason === 'missing'
            ? t('main.error.fileNotFound', 'The file was not found.')
            : reason === 'editor'
              ? t('main.filesOpen.editor', 'Tessel only hands documents and media to another program: open this file in Tessel’s editor instead.')
              : t('main.filesOpen.invalid', 'This path is not valid.')
  return { ok: false, reason, error }
}

// The program code.cmd starts and its arguments, read from code.cmd itself
// ("%~dp0..\Code.exe" "%~dp0..\<commit>\resources\app\out\cli.js" %*), so
// VS Code can start without cmd.exe. -> { exe, cli } | null
export function parseCodeCmd(text, cmdPath) {
  const dir = dirname(cmdPath)
  const quoted = [...String(text || '').matchAll(/"%~dp0([^"%]+)"/g)].map((m) => m[1])
  const exe = quoted.find((q) => /\.exe$/i.test(q))
  const cli = quoted.find((q) => /cli\.js$/i.test(q))
  if (!exe || !cli) return null
  return { exe: join(dir, exe), cli: join(dir, cli) }
}

// How to start VS Code at file:line:col. A plain path: code.cmd through cmd
// as before. A path cmd would misread: Code.exe with its CLI script, no shell
// at all (arguments are passed as they are). -> { file, args, env } | null
export function codeLaunch(gotoArg, { codeCmd, readFile = (p) => fsDefault.readFileSync(p, 'utf8'), env = process.env } = {}) {
  if (!CMD_SPECIAL.test(gotoArg)) return { file: 'cmd.exe', args: ['/d', '/c', 'code', '-g', gotoArg], env }
  if (!codeCmd || !isAbsolute(codeCmd)) return null
  let parsed = null
  try {
    parsed = parseCodeCmd(readFile(codeCmd), codeCmd)
  } catch {
    parsed = null
  }
  if (!parsed) return null
  return { file: parsed.exe, args: [parsed.cli, '-g', gotoArg], env: { ...env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } }
}

// code -> code.cmd next to it (where.exe lists the extensionless shell
// script first).
export function codeCmdFor(found) {
  if (typeof found !== 'string' || !found) return null
  return /\.cmd$/i.test(found) ? found : join(dirname(found), 'code.cmd')
}

async function statOf(p, fsp) {
  try {
    return await fsp.stat(p)
  } catch {
    return null
  }
}

// { file, line, col } -> { ok, with: 'code' | 'default' } | { ok: false, reason, error }.
// openInCode(file, line, col) -> true when VS Code took it (false: not
// installed, or it failed).
export async function openFileOutside(q, { shell, openInCode = async () => false, fsp = fsDefault.promises } = {}) {
  const file = q && typeof q.file === 'string' ? q.file : ''
  const problem = chatPathProblem(file)
  const ext = chatPathExt(file)
  // A script that is plain text may still go to an editor; any other program is refused.
  const textScript = problem === 'executable' && BLOCKED_TEXT_EXTENSIONS.has(ext)
  if (problem && !textScript) return refused(problem === 'control' ? 'invalid' : problem)
  const st = await statOf(file, fsp)
  if (!st) return refused('missing')
  if (st.isDirectory()) return refused('folder')
  if (!st.isFile()) return refused('missing')
  // A link to something else: judged by what it points at as well.
  let real = file
  try {
    real = await fsp.realpath(file)
  } catch {
    real = file
  }
  const realProblem = real !== file ? chatPathProblem(real) : null
  const realText = realProblem === 'executable' && BLOCKED_TEXT_EXTENSIONS.has(chatPathExt(real))
  if (realProblem && !realText) return refused(realProblem === 'control' ? 'invalid' : realProblem)
  const line = Number.isInteger(q.line) && q.line > 0 ? q.line : null
  const col = Number.isInteger(q.col) && q.col > 0 ? q.col : null
  if (await openInCode(file, line, col)) return { ok: true, with: 'code' }
  // The system's default program: media and documents only (an allowlist).
  const systemOk = !textScript && !realText && isSystemOpenFile(file) && isSystemOpenFile(real) && !TEXT_ONLY_SCRIPT_EXTENSIONS.has(ext)
  if (!systemOk) return refused('editor')
  const err = await shell.openPath(file)
  return err ? { ok: false, reason: 'failed', error: err } : { ok: true, with: 'default' }
}
