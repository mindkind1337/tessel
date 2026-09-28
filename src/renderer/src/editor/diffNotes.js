// i18n-pending: text here does not go through t() yet
// Review notes on the lines of a diff (the modified side), after Orca's
// useDiffCommentDecorator.tsx, diff-comment-add-button-overlay.ts,
// diff-comment-add-note-shortcut.ts and diff-comment-view-zone-entry.ts
// (MIT, Copyright (c) 2026 Lovecast Inc.), without React:
//   - a "+" follows the line under the mouse in the gutter; a click opens the
//     composer under that line;
//   - Ctrl+Shift+A (Orca's Add Review Note) opens it for the selected lines;
//   - each saved note is a card in a view zone under its line.
// The cards are Vue components mounted by the caller (mount(dom, kind, props)
// -> { update(props), unmount() }).

const BUTTON_SIZE = 18
const ZONE_MIN_PX = 64

function lineHeightOf(editor, monaco) {
  const h = editor.getOption(monaco.editor.EditorOption.lineHeight)
  return typeof h === 'number' && h > 0 ? h : 19
}

// The Add Review Note chord: Ctrl+Shift+A (Mod+Shift+A in Orca).
export function isAddReviewNoteChord(e) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.code === 'KeyA' || String(e.key).toLowerCase() === 'a')
}

// A selection -> { lineNumber (its last line), startLine } (Orca's
// resolveDiffCommentShortcutTarget, every line commentable).
export function selectionTarget(sel) {
  if (!sel) return null
  let start = sel.startLineNumber
  let end = sel.endLineNumber
  // A selection ending at column 1 of the next line does not include it.
  if (end > start && sel.endColumn === 1) end--
  if (end < start) [start, end] = [end, start]
  return end > start ? { lineNumber: end, startLine: start } : { lineNumber: end }
}

// opts: { monaco, getNotes() -> notes of this file, create({ lineNumber,
// startLine, body }) -> Promise<bool>, remove(id), save(id, body) -> bool,
// delivered(notes), mount }
export function installDiffNotes(editor, opts) {
  const { monaco, mount } = opts
  const root = editor.getDomNode()
  const zones = new Map() // note id -> { zoneId, dom, handle, delegate, sig }
  let draft = null // { zoneId, dom, handle, delegate, decorations, lineNumber, startLine }
  let hoverLine = null
  let disposed = false

  // --- The "+" button -------------------------------------------------------------
  const plus = document.createElement('button')
  plus.type = 'button'
  plus.className = 'orca-diff-comment-add-btn'
  plus.title = 'Add note for the AI'
  plus.setAttribute('aria-label', 'Add note for the AI')
  plus.setAttribute('data-test', 'diff-note-plus')
  plus.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'
  plus.style.display = 'none'
  if (root) root.appendChild(plus)
  let lastTop = null
  let lastDisplay = 'none'
  const setDisplay = (v) => {
    if (lastDisplay === v) return
    plus.style.display = v
    lastDisplay = v
  }
  const positionAt = (ln) => {
    const lineTop = editor.getTopForLineNumber(ln) - editor.getScrollTop()
    const top = Math.round(lineTop + (lineHeightOf(editor, monaco) - BUTTON_SIZE) / 2)
    if (top !== lastTop) {
      plus.style.top = `${top}px`
      lastTop = top
    }
    setDisplay('flex')
  }
  plus.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  })
  plus.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (hoverLine != null) openDraft({ lineNumber: hoverLine })
  })

  const subs = []
  subs.push(
    editor.onMouseMove((e) => {
      const src = e.event && e.event.browserEvent
      if (src && plus.contains(src.target)) return
      const ln = e.target && e.target.position ? e.target.position.lineNumber : null
      if (ln == null) {
        setDisplay('none')
        return
      }
      hoverLine = ln
      positionAt(ln)
    })
  )
  subs.push(editor.onMouseLeave(() => setDisplay('none')))
  subs.push(
    editor.onDidScrollChange(() => {
      if (hoverLine != null && lastDisplay !== 'none') positionAt(hoverLine)
    })
  )

  // --- The composer -----------------------------------------------------------------
  function closeDraft() {
    if (!draft) return
    const d = draft
    draft = null
    try {
      editor.changeViewZones((a) => a.removeZone(d.zoneId))
    } catch {
      /* the model changed */
    }
    if (d.decorations) d.decorations.clear()
    queueMicrotask(() => d.handle.unmount())
    if (!disposed) editor.focus()
  }

  function resizeZone(entry) {
    if (!entry || !entry.dom) return
    const card = entry.dom.firstElementChild
    const h = Math.max(ZONE_MIN_PX, Math.ceil((card ? card.getBoundingClientRect().height : 0) + 12))
    if (Math.abs(h - entry.delegate.heightInPx) < 2) return
    entry.delegate.heightInPx = h
    // Monaco may move the zone's node while laying it out: the text box being
    // typed in keeps the focus.
    const focused = entry.dom.contains(document.activeElement) ? document.activeElement : null
    try {
      editor.changeViewZones((a) => a.layoutZone(entry.zoneId))
    } catch {
      /* gone */
    }
    if (focused && document.activeElement !== focused && focused.isConnected) focused.focus()
  }

  function openDraft({ lineNumber, startLine }) {
    const model = editor.getModel()
    if (!model) return false
    const last = model.getLineCount()
    const ln = Math.min(Math.max(1, lineNumber), last)
    const st = startLine ? Math.min(Math.max(1, startLine), ln) : null
    if (draft && draft.lineNumber === ln && draft.startLine === st) {
      draft.handle.focus && draft.handle.focus()
      return true
    }
    closeDraft()
    const dom = document.createElement('div')
    dom.className = 'orca-diff-comment-inline'
    dom.addEventListener('mousedown', (e) => e.stopPropagation())
    const delegate = { afterLineNumber: ln, heightInPx: 150, domNode: dom, suppressMouseDown: false }
    let zoneId = null
    editor.changeViewZones((a) => {
      zoneId = a.addZone(delegate)
    })
    const entry = { zoneId, dom, delegate, lineNumber: ln, startLine: st }
    entry.decorations = editor.createDecorationsCollection([
      {
        range: new monaco.Range(st || ln, 1, ln, 1),
        options: { isWholeLine: true, className: 'orca-diff-comment-range-highlight', marginClassName: 'orca-diff-comment-range-margin' }
      }
    ])
    entry.handle = mount(dom, 'draft', {
      lineNumber: ln,
      startLine: st,
      onCancel: () => closeDraft(),
      onResize: () => resizeZone(entry),
      onSubmit: async (body) => {
        const ok = await opts.create({ lineNumber: ln, startLine: st || undefined, body })
        if (ok && draft === entry) closeDraft()
        return ok
      }
    })
    draft = entry
    editor.revealLineInCenterIfOutsideViewport(ln)
    return true
  }

  // Ctrl+Shift+A on the editor: the selected lines (or the cursor's line).
  const container = editor.getContainerDomNode()
  const onKey = (e) => {
    if (!isAddReviewNoteChord(e)) return
    if (e.repeat) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // An open composer owns the chord (its own textarea included).
    if (draft && draft.dom.contains(e.target)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    const t = selectionTarget(editor.getSelection())
    if (!t) return
    e.preventDefault()
    e.stopPropagation()
    openDraft(t)
  }
  container.addEventListener('keydown', onKey, true)

  // --- Saved notes ------------------------------------------------------------------
  const sigOf = (n) => JSON.stringify([n.body, n.lineNumber, n.startLine || null, n.sentAt || null])
  function sync() {
    if (disposed || !editor.getModel()) return
    const notes = opts.getNotes() || []
    const byId = new Map(notes.map((n) => [n.id, n]))
    const unmounts = []
    editor.changeViewZones((a) => {
      for (const [id, z] of zones) {
        if (!byId.has(id) || byId.get(id).lineNumber !== z.lineNumber) {
          a.removeZone(z.zoneId)
          unmounts.push(z.handle)
          zones.delete(id)
        }
      }
      for (const n of notes) {
        const z = zones.get(n.id)
        if (z) {
          if (z.sig !== sigOf(n)) {
            z.sig = sigOf(n)
            z.handle.update({ note: { ...n } })
          }
          continue
        }
        const dom = document.createElement('div')
        dom.className = 'orca-diff-comment-inline'
        dom.addEventListener('mousedown', (e) => e.stopPropagation())
        const lines = String(n.body).split('\n').length
        const delegate = { afterLineNumber: n.lineNumber, heightInPx: Math.max(ZONE_MIN_PX, 58 + lines * 20), domNode: dom, suppressMouseDown: false }
        const zoneId = a.addZone(delegate)
        const entry = { zoneId, dom, delegate, lineNumber: n.lineNumber, sig: sigOf(n) }
        entry.handle = mount(dom, 'card', {
          note: { ...n },
          onDelete: () => opts.remove(n.id),
          onSave: async (body) => opts.save(n.id, body),
          onDelivered: (sent) => opts.delivered && opts.delivered(sent),
          onResize: () => resizeZone(entry)
        })
        zones.set(n.id, entry)
      }
    })
    if (unmounts.length) queueMicrotask(() => unmounts.forEach((h) => h.unmount()))
  }

  // Monaco drops a model's view zones when the model changes.
  subs.push(
    editor.onDidChangeModel(() => {
      const unmounts = [...zones.values()].map((z) => z.handle)
      zones.clear()
      if (draft) {
        unmounts.push(draft.handle)
        if (draft.decorations) draft.decorations.clear()
        draft = null
      }
      queueMicrotask(() => unmounts.forEach((h) => h.unmount()))
      queueMicrotask(sync)
    })
  )

  // Scroll to a note (from the Notes list): its line centred.
  function reveal(line) {
    if (!line || !editor.getModel()) return
    const top = editor.getTopForLineNumber(Math.min(line, editor.getModel().getLineCount()), true)
    editor.setScrollTop(Math.max(0, top - editor.getLayoutInfo().height / 2))
  }

  sync()
  return {
    sync,
    openDraft,
    reveal,
    hasDraft: () => !!draft,
    dispose() {
      disposed = true
      container.removeEventListener('keydown', onKey, true)
      for (const s of subs) s.dispose()
      plus.remove()
      const handles = [...zones.values()].map((z) => z.handle)
      const ids = [...zones.values()].map((z) => z.zoneId)
      if (draft) {
        handles.push(draft.handle)
        ids.push(draft.zoneId)
        if (draft.decorations) draft.decorations.clear()
      }
      try {
        editor.changeViewZones((a) => ids.forEach((id) => a.removeZone(id)))
      } catch {
        /* the editor is gone */
      }
      zones.clear()
      draft = null
      queueMicrotask(() => handles.forEach((h) => h.unmount()))
    }
  }
}
