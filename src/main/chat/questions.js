// Provider question boundary. No permission rules or execution posture live here.
import { randomUUID } from 'crypto'

export const QUESTION_LIMITS = {
  questions: 8,
  options: 32,
  text: 2048,
  label: 512,
  other: 8192,
  pending: 8,
  requests: 4096
}
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v, max, empty = false) =>
  typeof v === 'string' &&
  (empty || !!v.trim()) &&
  v.length <= max &&
  Buffer.byteLength(v, 'utf8') <= max
const id = (v) => text(v, 120) && !['__proto__', 'constructor', 'prototype'].includes(v)

// Reject oversized questions rather than truncating a choice the user must see.
export function normalizeQuestions(input, provider) {
  if (!Array.isArray(input) || !input.length || input.length > QUESTION_LIMITS.questions)
    return null
  const result = [],
    ids = new Set(),
    prompts = new Set()
  for (const [i, q] of input.entries()) {
    if (
      !object(q) ||
      !text(q.question, QUESTION_LIMITS.text) ||
      (q.header != null && !text(q.header, QUESTION_LIMITS.text, true))
    )
      return null
    // No secret-entry UI or secret-safe journal yet; malformed flags also fail closed.
    if (q.isSecret != null && q.isSecret !== false) return null
    const qid = provider === 'claude' ? `q${i}` : q.id
    if (!id(qid) || ids.has(qid) || (provider === 'claude' && prompts.has(q.question))) return null
    ids.add(qid)
    prompts.add(q.question)
    const options = q.options == null && provider === 'codex' ? [] : q.options
    if (!Array.isArray(options) || options.length > QUESTION_LIMITS.options) return null
    if (q.multiSelect != null && typeof q.multiSelect !== 'boolean') return null
    if (provider === 'codex' && q.isOther != null && typeof q.isOther !== 'boolean') return null
    const allowOther =
      provider === 'claude' ||
      (provider === 'codex' ? !options.length || q.isOther === true : q.freeTextQuestionId != null)
    if (!options.length && !allowOther) return null
    const out = []
    const optionIds = new Set()
    for (const [j, opt] of options.entries()) {
      if (
        !object(opt) ||
        !text(opt.label, QUESTION_LIMITS.label) ||
        (opt.description != null && !text(opt.description, QUESTION_LIMITS.text, true))
      )
        return null
      const oid = provider === 'normalized' ? opt.id : `o${j}`
      if (!id(oid) || optionIds.has(oid)) return null
      optionIds.add(oid)
      out.push({
        id: oid,
        label: opt.label,
        ...(opt.description != null ? { description: opt.description } : {})
      })
    }
    if (provider === 'normalized' && allowOther && q.freeTextQuestionId !== qid) return null
    result.push({
      id: qid,
      question: q.question,
      ...(q.header != null ? { header: q.header } : {}),
      multiSelect: provider === 'codex' ? false : q.multiSelect === true,
      options: out,
      ...(allowOther ? { freeTextQuestionId: qid } : {})
    })
  }
  return result
}

// Every question needs an explicit answer. Cancellation has a separate flag
// and must never be mistaken for a selection or a partially completed form.
export function validateQuestionAnswers(questions, answers) {
  if (!Array.isArray(answers) || !answers.length || answers.length !== questions.length) return null
  const seen = new Set(),
    clean = []
  for (const answer of answers) {
    if (!object(answer) || !id(answer.questionId) || seen.has(answer.questionId)) return null
    const q = questions.find((q) => q.id === answer.questionId)
    if (!q || !Array.isArray(answer.optionIds) || answer.optionIds.length > q.options.length)
      return null
    seen.add(q.id)
    const selected = new Set()
    for (const oid of answer.optionIds) {
      if (!id(oid) || selected.has(oid) || !q.options.some((o) => o.id === oid)) return null
      selected.add(oid)
    }
    if (answer.other != null && !text(answer.other, QUESTION_LIMITS.other, true)) return null
    const other = answer.other?.trim() || ''
    if (other && !q.freeTextQuestionId) return null
    const count = selected.size + (other ? 1 : 0)
    if (!count || (!q.multiSelect && count !== 1)) return null
    clean.push({ questionId: q.id, optionIds: [...selected], ...(other ? { other } : {}) })
  }
  return clean
}

export function providerAnswers(questions, answers, provider) {
  return Object.fromEntries(
    answers.map((answer) => {
      const q = questions.find((q) => q.id === answer.questionId)
      const labels = answer.optionIds.map((oid) => q.options.find((o) => o.id === oid).label)
      if (answer.other) labels.push(answer.other)
      return provider === 'claude' ? [q.question, labels.join(', ')] : [q.id, { answers: labels }]
    })
  )
}

// Raw RPC/control ids stay inside the adapter. Opaque public ids include a UUID
// so a stale answer from an older process cannot resolve a newly opened question.
export function createQuestionRequests(emit) {
  const pending = new Map(),
    seen = new Set()
  const rawKey = (raw) => JSON.stringify(raw)
  const validRaw = (raw) => (typeof raw === 'number' && Number.isSafeInteger(raw)) || text(raw, 256)
  function add({ rawId, questions, turnId = '', reply }) {
    if (!validRaw(rawId)) {
      void reply(null)
      return
    }
    const key = rawKey(rawId)
    if (seen.has(key)) return
    if (seen.size >= QUESTION_LIMITS.requests) {
      void reply(null)
      return
    }
    seen.add(key)
    if (!questions || pending.size >= QUESTION_LIMITS.pending) {
      void reply(null)
      return
    }
    const requestId = `question_${randomUUID()}`
    pending.set(requestId, { rawId, questions, turnId, reply, sending: false })
    emit('question', { requestId, questions, status: 'pending' })
  }
  function cancel(filter = () => true, respond = false) {
    for (const [requestId, q] of pending) {
      if (!filter(q)) continue
      pending.delete(requestId)
      if (respond && !q.sending) void q.reply(null)
      emit('questionStatus', { requestId, status: 'cancelled' })
    }
  }
  async function answer(requestId, { answers, cancel: cancelled = false } = {}) {
    const q = pending.get(requestId)
    if (!q || q.sending) return { ok: false, code: 'unknown' }
    const clean = cancelled ? null : validateQuestionAnswers(q.questions, answers)
    if (!cancelled && !clean) return { ok: false, code: 'invalid' }
    q.sending = true
    let ok = false
    try {
      ok = await q.reply(clean)
    } catch {
      /* pipe closed */
    }
    if (pending.get(requestId) !== q) return { ok: false, code: 'unknown' }
    pending.delete(requestId)
    emit('questionStatus', {
      requestId,
      status: ok && !cancelled ? 'answered' : 'cancelled',
      ...(ok && !cancelled ? { answers: clean } : {})
    })
    return ok ? { ok: true } : { ok: false, code: 'failed' }
  }
  return {
    add,
    answer,
    cancel,
    cancelRaw: (raw) => cancel((q) => rawKey(q.rawId) === rawKey(raw)),
    size: () => pending.size
  }
}
