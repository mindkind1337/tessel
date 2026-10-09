// Text a PowerShell child process printed, made readable before Tessel shows
// it. A PowerShell started with its output redirected writes its progress
// ("Preparing modules for first use.") and errors to stderr as CLIXML:
//   #< CLIXML
//   <Objs Version="1.1.0.1" xmlns="..."><Obj S="progress" ...>...</Obj><S S="Error">text_x000D__x000A_</S></Objs>
// The progress records are dropped; error and warning texts are kept, decoded.

// powershell.exe -EncodedCommand writes its stderr as CLIXML whatever
// -OutputFormat says (checked on Windows PowerShell 5.1), so the text is
// cleaned here. This script line silences progress records at the source.
export const PS_QUIET_PRELUDE = "$ProgressPreference = 'SilentlyContinue'"

function decodeClixmlText(s) {
  return String(s)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
}

// The readable messages (errors, warnings, plain strings) of one <Objs> block.
function clixmlMessages(block) {
  const out = []
  const re = /<S S="(Error|Warning|Verbose|Information|Debug)">([\s\S]*?)<\/S>/g
  let m
  while ((m = re.exec(block))) {
    if (m[1] === 'Error' || m[1] === 'Warning') out.push(decodeClixmlText(m[2]))
  }
  return out.join('').replace(/\r\n/g, '\n').trim()
}

export function cleanPsOutput(text) {
  let s = String(text || '')
  if (!/#< CLIXML|<Objs\b/.test(s)) return s
  s = s.replace(/^[ \t]*#< CLIXML[ \t]*\r?\n?/gm, '')
  // Complete blocks: their error texts stay, the rest goes.
  s = s.replace(/<Objs\b[\s\S]*?<\/Objs>/g, (block) => {
    const msg = clixmlMessages(block)
    return msg ? `\n${msg}\n` : '\n'
  })
  // A block cut off at the end (output truncated): dropped.
  s = s.replace(/<Objs\b[\s\S]*$/, '')
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l, i, all) => l || (i > 0 && all[i - 1]))
    .join('\n')
    .trim()
}
