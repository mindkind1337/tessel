// Node-only (tests): finds interface text that does not go through t(), and
// t() keys that have no French translation. See __tests__/i18n.spec.js.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse as parseSfc, babelParse } from '@vue/compiler-sfc'

// Words that are the same in every language (names, symbols, units).
const SAME_EVERYWHERE = new Set(
  [
    'Tessel', 'Orca', 'Git', 'GitHub', 'Linear', 'Codex', 'Claude', 'Gemini', 'MCP', 'PR', 'OK', 'ID',
    'URL', 'JSON', 'CSV', 'PID', 'CPU', 'RAM', 'MB', 'GB', 'KB', 'ms', 'px', 'pt', 'min', 'max', 'Esc',
    'Ctrl', 'Shift', 'Alt', 'Enter', 'Tab', 'Yolo', 'WSL', 'PowerShell', 'Bash', 'Monaco', 'Markdown',
    'Mermaid', 'Windows', 'macOS', 'Linux', 'Node', 'npm', 'Electron', 'xterm', 'WebGL', 'API', 'HEAD'
  ].map((w) => w.toLowerCase())
)

function listFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'locales' || name === 'assets') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) listFiles(p, exts, out)
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

function meaningful(text) {
  const words = String(text).match(/[A-Za-zÀ-ÿ]{2,}/g)
  if (!words) return false
  return words.some((w) => !SAME_EVERYWHERE.has(w.toLowerCase()))
}

const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'aria-description'])

function walkTemplate(node, found) {
  if (!node) return
  // 2 = text, 1 = element
  if (node.type === 2 && meaningful(node.content)) found.push({ line: node.loc.start.line, text: node.content.trim() })
  if (node.type === 5 && node.content.type === 4)
    scanTemplates(`(${node.content.content})`, node.content.loc.start.line - 1, found)
  if (node.type === 1) {
    for (const p of node.props || []) {
      // 6 = static attribute
      if (p.type === 6 && TEXT_ATTRS.has(p.name) && p.value && meaningful(p.value.content))
        found.push({ line: p.loc.start.line, text: `${p.name}="${p.value.content}"` })
      if (p.type === 7 && p.name === 'bind' && TEXT_ATTRS.has(p.arg?.content) && p.exp)
        scanTemplates(`(${p.exp.content})`, p.exp.loc.start.line - 1, found)
    }
  }
  for (const c of node.children || []) walkTemplate(c, found)
  if (node.branches) for (const b of node.branches) walkTemplate(b, found)
}

// Script text: a quoted literal that reads like a sentence for a person
// (starts with a capital, has a space) and is not t()'s fallback. A line
// ending in "// i18n-ignore" is skipped (log lines, commands, ids).
const SENTENCE = /^[A-ZÀ-Ý][a-zà-ÿ']*[ ,:…][^\n]*[a-zà-ÿ]/
function scanScript(code, lineOffset, found) {
  scanTemplates(code, lineOffset, found)
  const lines = code.split('\n')
  let inBlockComment = false
  lines.forEach((raw, i) => {
    let line = raw
    if (inBlockComment) {
      const end = line.indexOf('*/')
      if (end < 0) return
      line = line.slice(end + 2)
      inBlockComment = false
    }
    const start = line.indexOf('/*')
    if (start >= 0 && line.indexOf('*/', start) < 0) {
      inBlockComment = true
      line = line.slice(0, start)
    }
    if (/\/\/\s*i18n-ignore\s*$/.test(line)) return
    if (/^\s*(\/\/|\*)/.test(line)) return
    if (/^\s*import\s/.test(line)) return
    if (/console\.(log|warn|error|info|debug)\(|shellApi\.log\(|new Error\(/.test(line)) return
    const re = /(['"`])((?:\\.|(?!\1).)*)\1/g
    let m
    while ((m = re.exec(line))) {
      const text = m[2]
      if (m[1] === '`' || !SENTENCE.test(text) || !meaningful(text)) continue
      // t('key', 'fallback'): the fallback is the English, fine.
      const before = line.slice(0, m.index)
      if (/\bt\(\s*(['"`])[^'"`]+\1\s*,\s*$/.test(before)) continue
      if (/\bt\(\s*[\w.[\]]+\s*,\s*$/.test(before)) continue
      found.push({ line: lineOffset + i + 1, text })
    }
  })
}

// Parse quasis rather than stripping ${...} with a regexp: expressions can
// contain nested braces, strings and other template literals.
function scanTemplates(code, lineOffset, found) {
  const ast = babelParse(code, { sourceType: 'module' })
  // A block comment also works inside a Vue interpolation or bound title.
  const ignoredLines = new Set((ast.comments || [])
    .filter((comment) => comment.value.trim() === 'i18n-ignore')
    .map((comment) => comment.loc.start.line))
  function visit(node, parent, ignored = false) {
    if (!node || typeof node !== 'object') return
    const start = node.loc?.start.line
    const end = node.loc?.end.line
    const suppressed = ignored || (node.type === 'TemplateLiteral' && ignoredLines.has(end))
    const callee = node.callee
    const logging = node.type === 'CallExpression' && callee?.type === 'MemberExpression' &&
      ((callee.object.name === 'console' && ['log', 'warn', 'error', 'info', 'debug'].includes(callee.property.name)) ||
        ((callee.object.name === 'shellApi' || callee.object.property?.name === 'shellApi') && callee.property.name === 'log'))
    const error = node.type === 'NewExpression' && callee?.name === 'Error'
    if (node.type === 'TemplateLiteral' && !suppressed) {
      const fallback = parent?.type === 'CallExpression' && parent.callee.name === 't' &&
        (parent.arguments[0] === node || parent.arguments[1] === node)
      const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' ')
      if (!fallback && meaningful(text)) found.push({ line: lineOffset + start, text: code.slice(node.start, node.end) })
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach((child) => visit(child, node, suppressed || logging || error))
      else if (value && typeof value === 'object') visit(value, node, suppressed || logging || error)
    }
  }
  visit(ast, null)
}

export function untranslatedIn(file) {
  const src = readFileSync(file, 'utf8')
  const found = []
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(src, { filename: file })
    if (descriptor.template) walkTemplate(descriptor.template.ast, found)
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (block) scanScript(block.content, block.loc.start.line - 1, found)
    }
  } else scanScript(src, 0, found)
  return found
}

export function rendererFiles(root) {
  return listFiles(root, ['.vue', '.js']).filter((f) => !f.includes(`${sep}i18n${sep}`))
}

export function relPath(root, file) {
  return relative(root, file).split(sep).join('/')
}

// Every t('literal.key', …) used in the code.
export function usedKeys(files) {
  const keys = new Map()
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const re = /\bt\(\s*(['"])([a-zA-Z][\w-]*(?:\.[\w-]+)+)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3/g
    let m
    while ((m = re.exec(src))) {
      if (!keys.has(m[2])) keys.set(m[2], { english: m[4], file: f })
    }
  }
  return keys
}
