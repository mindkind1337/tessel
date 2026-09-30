// Bearer tokens, key=value secrets, long hex or base64-like runs. Always
// before a text is cut: a cut secret would leave its start visible.
// Shared by the chat (tool rows, transcripts) and the session search (the
// main process masks a passage before it goes to the window).
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/\b(bearer|basic|token)\s+[^\s"']+/gi, '$1 ***')
    .replace(
      /\b([\w.-]*(?:key|token|secret|password|passwd|pwd|auth|credential|signature)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;|,]+)/gi,
      (all, name, sep, value) => (/^\*+$/.test(value) ? all : `${name}${sep}***`)
    )
    .replace(/\b[a-f0-9]{24,}\b/gi, '***')
    .replace(/(?<![\w/\\.-])(?=[\w+=-]*\d)(?=[\w+=-]*[A-Za-z])[\w+=-]{32,}/g, '***')
}
