// The model an agent shows on its screen, for agents Tessel has no file for
// (Kimi, a custom agent...). Almost every agent prints its model in its
// status bar (the bottom lines) or its welcome banner (the first lines);
// only those are read, never the conversation in between, so a model named
// in a question or an answer is not taken for the one in use.

// Model names as agents print them; a "provider/" in front is kept.
const MODEL = new RegExp(
  '(?:^|[\\s(\\[|:·•,])' +
    '((?:[a-z0-9][\\w.-]*\\/)?' +
    '(?:' +
    [
      'claude-[a-z0-9][\\w.-]*',
      '(?:opus|sonnet|haiku|fable)[ -]?\\d+(?:[.-]\\d+)?(?:\\s?\\(1M\\))?',
      'gpt-\\d[\\w.-]*',
      'o[134](?:-mini|-pro)',
      'gemini-\\d[\\w.-]*',
      'kimi-[a-z0-9][\\w.-]*',
      'moonshot-v\\d[\\w.-]*',
      'qwen\\d[\\w.-]*',
      'qwen-(?:coder|max|plus|turbo)[\\w.-]*',
      'deepseek-[a-z0-9][\\w.-]*',
      'grok-\\d[\\w.-]*',
      'glm-\\d[\\w.-]*',
      '(?:mistral|devstral|codestral|magistral)-[a-z0-9][\\w.-]*',
      'llama-?\\d[\\w.-]*',
      'big-pickle',
      'mai-code-[\\w.-]+'
    ].join('|') +
    '))(?=$|[\\s)\\]|:·•,])',
  'i'
)

export function modelInLine(line) {
  const m = MODEL.exec(String(line || ''))
  return m ? m[1].replace(/[.-]+$/, '') : null
}

// bottom: the last non-empty lines on screen (the status bar), read from the
// bottom up; top: the first lines of the output (the welcome banner).
export function modelFromScreen({ bottom = [], top = [] } = {}) {
  const clean = (list) => (list || []).map((l) => String(l || '')).filter((l) => l.trim())
  for (const l of clean(bottom).reverse()) {
    const m = modelInLine(l)
    if (m) return m
  }
  for (const l of clean(top)) {
    const m = modelInLine(l)
    if (m) return m
  }
  return null
}

// The model Claude Code's /model printed: "Set model to opus (claude-opus-5-5)"
// -> "claude-opus-5-5" (the full id says the version; the alias before it
// does not), "Set model to Opus 5.5" -> "Opus 5.5", "Set model to opus" ->
// "opus". Backticks around it are its Markdown, not the name.
export function modelFromSwitchLine(text) {
  const m = /Set model to\s+(.+?)\s*$/.exec(String(text || ''))
  if (!m) return null
  const rest = m[1].replace(/`/g, ' ').replace(/\s+and saved as your default.*$/i, '').trim()
  return modelInLine(rest) || rest.split(/[\s(]/)[0].slice(0, 60) || null
}
