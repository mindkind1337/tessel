// Paths an agent names in the chat (links, inline code): what Tessel may open
// and how. Shared by the renderer (the click, before any dialog) and the main
// process (chatFileOpen.js re-checks everything before it touches the disk).
//
// Never opened, whatever the folder: programs, scripts and anything Windows
// would run or follow (shortcuts, installers, script hosts, macro documents).
// Network, UNC and device paths are never even looked at (a stat of
// \\server\share would reach that server).

export const BLOCKED_EXTENSIONS = new Set(
  (
    'exe com bat cmd msi msp mst msix msixbundle appx appxbundle appinstaller app ps1 psm1 psd1 ps1xml psc1 pssc ' +
    'sh bash zsh ksh csh fish command vbs vbe wsf wsh wsc ws sct jse hta lnk scr pif cpl dll ocx sys drv ' +
    'reg inf url website application appref-ms gadget msc scf jar jnlp ahk au3 ' +
    'settingcontent-ms library-ms searchconnector-ms diagcab chm hlp xll xlam ppam docm dotm xlsm xltm xlsb pptm potm ppsm ' +
    'iso img vhd vhdx'
  ).split(' ')
)

// Scripts that are also code: shown as text in Tessel's editor when inside or
// confirmed, never handed to the system (where Windows Script Host or an
// interpreter would run them).
export const TEXT_ONLY_SCRIPT_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'py', 'pyw', 'rb', 'pl', 'php', 'lua'])

// Media and documents: opened with the system's default app.
export const SYSTEM_OPEN_EXTENSIONS = new Set(
  (
    'mp4 m4v webm mov avi mkv wmv mpg mpeg 3gp ogv ' +
    'gif png jpg jpeg webp bmp ico svg tif tiff heic avif ' +
    'mp3 wav ogg oga flac m4a aac wma opus mid midi ' +
    'pdf docx xlsx pptx odt ods odp epub ' +
    'zip 7z rar tar gz tgz bz2 xz ' +
    'ttf otf woff woff2 psd'
  ).split(' ')
)

const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i

export function chatPathExt(p) {
  const base = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function baseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

// -> null when the path may be looked at, else why not:
//   'invalid' (empty, relative, too long, a stream or a trailing dot/space),
//   'control' (control characters), 'network' (UNC, \\?\, \\.\, a device
//   name), 'executable' (a program or a script the system would run).
export function chatPathProblem(p, { requireAbsolute = true } = {}) {
  if (typeof p !== 'string' || !p || p.length > 1024) return 'invalid'
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'control'
  if (/^[\\/]{2}/.test(p) || /^\\\?\?\\/.test(p)) return 'network'
  if (requireAbsolute && !/^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/.test(p)) return 'invalid'
  // A colon anywhere but after the drive letter: an alternate data stream.
  if (p.slice(/^[A-Za-z]:/.test(p) ? 2 : 0).includes(':')) return 'invalid'
  const base = baseName(p)
  // Windows drops trailing dots and spaces: "run.exe." is run.exe.
  if (/[. ]$/.test(base) && base !== '.' && base !== '..') return 'invalid'
  if (DEVICE_NAME.test(base.replace(/\..*$/, ''))) return 'network'
  if (BLOCKED_EXTENSIONS.has(chatPathExt(p))) return 'executable'
  return null
}

// A file the system's default app opens (media, documents, archives).
export const isSystemOpenFile = (p) => SYSTEM_OPEN_EXTENSIONS.has(chatPathExt(p))
