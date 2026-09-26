// Folders where installers put commands without adding them to PATH, so an
// agent installed from Tessel (or by hand) is found and runs in its panes
// even when Windows cannot find it in a new console:
//   pip with the Microsoft Store Python  ...\Packages\PythonSoftwareFoundation.Python.*\LocalCache\local-packages\Python*\Scripts
//   pip --user with python.org Python    %APPDATA%\Python\Python*\Scripts
//   uv tool / pipx                       ~\.local\bin
//   npm global, Bun, Ollama, the OpenCode and Kimi Code installers
// Only folders that exist are added, after PATH's own (PATH always wins).
import fs from 'fs'
import os from 'os'
import { join, delimiter } from 'path'

function subdirs(dir, re) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && re.test(d.name))
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

// pythonDirs: Python's own user scripts folders (asked once, see index.js),
// kept even before they exist: pip creates them during an install, after
// the pane started.
export function extraToolDirs(env = process.env, home = os.homedir(), pythonDirs = []) {
  if (process.platform !== 'win32' && !env.TESSEL_TOOLDIRS_TEST) return [join(home, '.local', 'bin')]
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
  // The agents' own install folders first: a newer agent must win over an
  // old pip copy with the same name (kimi-cli's "kimi" vs Kimi Code's).
  const dirs = [
    join(home, '.kimi-code', 'bin'),
    join(home, '.opencode', 'bin'),
    join(local, 'Programs', 'Ollama'),
    join(home, '.local', 'bin'),
    join(roaming, 'npm'),
    join(home, '.bun', 'bin')
  ]
  for (const pkg of subdirs(join(local, 'Packages'), /^PythonSoftwareFoundation\.Python\./i)) {
    for (const py of subdirs(join(pkg, 'LocalCache', 'local-packages'), /^Python\d+$/i)) dirs.push(join(py, 'Scripts'))
  }
  for (const py of subdirs(join(roaming, 'Python'), /^Python\d+$/i)) dirs.push(join(py, 'Scripts'))
  const found = dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory()
    } catch {
      return false
    }
  })
  return [...found, ...(pythonDirs || []).filter((d) => typeof d === 'string' && /^[A-Za-z]:\\/.test(d))]
}

// PATH with those folders added at the end (each once, whatever its case).
export function withToolDirs(pathValue, dirs) {
  const parts = String(pathValue || '')
    .split(delimiter)
    .filter(Boolean)
  const seen = new Set(parts.map((p) => p.replace(/[\\/]+$/, '').toLowerCase()))
  for (const d of dirs || []) {
    const k = d.replace(/[\\/]+$/, '').toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      parts.push(d)
    }
  }
  return parts.join(delimiter)
}
