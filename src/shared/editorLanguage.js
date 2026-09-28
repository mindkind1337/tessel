// Which Monaco language colours a file in Tessel's editor, by its name.
// Ported from Orca's language-detect.ts (MIT, Copyright (c) 2026 Lovecast
// Inc.): exact file names first, then the extension, then .env files as INI,
// else plain text. Pure: no Monaco here (see pickLanguage for the fallback on
// the languages Monaco has registered).

const EXT_TO_LANGUAGE = {
  // Monaco has no separate 'typescriptreact' / 'javascriptreact' ids: .tsx,
  // .cts, .mts are 'typescript', .jsx, .mjs, .cjs are 'javascript' (Orca).
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.jsonl': 'jsonl',
  '.ipynb': 'notebook',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.mmd': 'mermaid',
  '.mermaid': 'mermaid',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.jsp': 'html',
  '.jspf': 'html',
  '.liquid': 'liquid',
  '.twig': 'twig',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.cls': 'apex',
  '.trigger': 'apex',
  '.apex': 'apex',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.proto': 'proto',
  '.lua': 'lua',
  '.r': 'r',
  '.scala': 'scala',
  '.dart': 'dart',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  // Monaco registers Solidity as 'sol' ('solidity' is only an alias).
  '.sol': 'sol',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.astro': 'astro',
  '.sv': 'systemverilog',
  '.svh': 'systemverilog',
  '.v': 'verilog',
  '.vh': 'verilog',
  '.nim': 'nim',
  '.nims': 'nim',
  '.nimble': 'nim',
  '.typ': 'typst',
  '.tf': 'hcl',
  '.hcl': 'hcl',
  '.abap': 'abap',
  '.prisma': 'graphql',
  '.csv': 'csv',
  '.tsv': 'tsv'
}

const FILENAME_TO_LANGUAGE = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.env.local': 'ini',
  '.env.development': 'ini',
  '.env.production': 'ini'
}

// Languages Orca registers itself that Tessel's Monaco does not have: the
// closest built-in one (Vue, Svelte and Astro files are mostly HTML).
const FALLBACK = { vue: 'html', svelte: 'html', astro: 'html', jsonl: 'json' }

export function baseName(filePath) {
  const parts = String(filePath || '').split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

// '.ts' for a.ts, '' for Makefile; like Orca's extname, a dot file's whole
// name is its extension ('.sh' for a file named .sh).
export function extName(fileName) {
  const name = String(fileName || '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : ''
}

// -> a Monaco language id ('plaintext' when nothing matches).
export function detectLanguage(filePath) {
  const name = baseName(filePath)
  if (Object.hasOwn(FILENAME_TO_LANGUAGE, name)) return FILENAME_TO_LANGUAGE[name]
  const ext = extName(name).toLowerCase()
  if (Object.hasOwn(EXT_TO_LANGUAGE, ext)) return EXT_TO_LANGUAGE[ext]
  const lower = name.toLowerCase()
  // Scoped dotenv names (.env.staging) fall back to INI only when no
  // extension above matched (Orca).
  if (lower === '.env' || lower.startsWith('.env.')) return 'ini'
  return 'plaintext'
}

// The language to give Monaco, among those it has registered
// (monaco.languages.getLanguages(): [{ id, extensions, filenames }]): the one
// detectLanguage names, its fallback, one Monaco itself claims for the name
// or extension (like Orca's detectMonacoFilenameLanguage), else plain text.
export function pickLanguage(filePath, registered = []) {
  const ids = new Set(registered.map((l) => l && l.id).filter(Boolean))
  const wanted = detectLanguage(filePath)
  if (wanted !== 'plaintext' && ids.has(wanted)) return wanted
  if (FALLBACK[wanted] && ids.has(FALLBACK[wanted])) return FALLBACK[wanted]
  const name = baseName(filePath)
  const lower = name.toLowerCase()
  for (const l of registered) {
    if (!l || !l.id) continue
    if ((l.filenames || []).some((f) => String(f).toLowerCase() === lower)) return l.id
  }
  const ext = extName(name).toLowerCase()
  if (ext) {
    for (const l of registered) {
      if (!l || !l.id) continue
      if ((l.extensions || []).some((e) => String(e).toLowerCase() === ext)) return l.id
    }
  }
  return 'plaintext'
}
