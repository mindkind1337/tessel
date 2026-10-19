// Muse Code's own model catalog, as Muse keeps it on this computer:
// <XDG_DATA_HOME or ~/.local/share>/muse/model-catalog/<provider>__<profile>.json
// { schema_version: 2, provider_id, rows: [{ model_id, display_label,
// visibility, context_limit, output_limit, reasoning_effort_variants: [{ tier
// }], is_default }] } (Muse Code 1.4.10). The context window of each model is
// taken from it, never guessed: the chat view's context ring divides the
// tokens Muse reported for its latest call by it.
//
// Read without blocking the main process (fs.promises), at most once a
// minute; museContextWindow() answers from what was read last (null until the
// first read is done, which it starts).
import fsp from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { museDataDir, museModelId } from './museSessions'

const STALE_MS = 60 * 1000
const MAX_FILES = 20
const MAX_BYTES = 1024 * 1024
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const limit = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9 ? v : null)

// One catalog file's text -> Map(model id -> { contextLimit, outputLimit, label, hidden }).
export function parseMuseCatalog(text, into = new Map()) {
  let o
  try {
    o = JSON.parse(text)
  } catch {
    return into
  }
  for (const r of object(o) && Array.isArray(o.rows) ? o.rows.slice(0, 300) : []) {
    const id = object(r) ? museModelId(r.model_id) : ''
    if (!id || into.has(id)) continue
    const label = typeof r.display_label === 'string' && r.display_label.trim() ? r.display_label.trim().slice(0, 120) : null
    into.set(id, { contextLimit: limit(r.context_limit), outputLimit: limit(r.output_limit), label, hidden: r.visibility === 'hidden' })
  }
  return into
}

export function createMuseCatalog({ home = os.homedir(), env = process.env, clock = Date.now } = {}) {
  let models = new Map()
  let readAt = 0
  let loading = null
  async function load() {
    const dir = join(museDataDir(home, env), 'model-catalog')
    const next = new Map()
    let names = []
    try {
      names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /\.json$/i.test(e.name)).map((e) => e.name).sort().slice(0, MAX_FILES)
    } catch {
      names = []
    }
    for (const name of names) {
      try {
        const file = join(dir, name)
        const st = await fsp.stat(file)
        if (st.size > MAX_BYTES) continue
        parseMuseCatalog(await fsp.readFile(file, 'utf8'), next)
      } catch {
        // being rewritten: the next read has it
      }
    }
    models = next
    readAt = clock()
  }
  function refresh() {
    if (loading || (readAt && clock() - readAt < STALE_MS)) return loading || Promise.resolve()
    loading = load()
      .catch(() => {})
      .finally(() => {
        loading = null
      })
    return loading
  }
  return {
    refresh,
    // -> the model's context window in tokens, or null (not read yet, unknown model).
    contextWindow(model) {
      refresh()
      const row = typeof model === 'string' ? models.get(model.trim()) : null
      return (row && row.contextLimit) || null
    },
    models: () => models
  }
}

// The models Muse's catalog offers, in the shape of its `muse serve`
// model/list answer ({ models: [{ modelId, displayLabel, isDefault, variants,
// reasoningEffortVariants }] }, parseMuseModelList reads it), from its files:
// Settings > Agents > Refresh models never starts its 480 MB binary when they
// are there. Hidden rows (contributor and image models) are left out.
// -> that answer, or null (no catalog yet).
export async function museCatalogModelList({ home = os.homedir(), env = process.env } = {}) {
  const dir = join(museDataDir(home, env), 'model-catalog')
  let names = []
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && /\.json$/i.test(e.name)).map((e) => e.name).sort().slice(0, MAX_FILES)
  } catch {
    return null
  }
  const models = []
  const seen = new Set()
  for (const name of names) {
    let o
    try {
      const file = join(dir, name)
      if ((await fsp.stat(file)).size > MAX_BYTES) continue
      o = JSON.parse(await fsp.readFile(file, 'utf8'))
    } catch {
      continue
    }
    for (const r of object(o) && Array.isArray(o.rows) ? o.rows.slice(0, 300) : []) {
      const id = object(r) ? museModelId(r.model_id) : ''
      if (!id || seen.has(id) || r.visibility === 'hidden') continue
      seen.add(id)
      const tiers = (Array.isArray(r.reasoning_effort_variants) ? r.reasoning_effort_variants : []).map((v) => (object(v) && typeof v.tier === 'string' ? v.tier : null)).filter(Boolean)
      models.push({
        modelId: id,
        displayLabel: typeof r.display_label === 'string' ? r.display_label : id,
        description: typeof r.description === 'string' ? r.description : null,
        isDefault: r.is_default === true,
        variants: tiers,
        ...(typeof r.default_reasoning_effort === 'string' ? { defaultReasoningEffort: r.default_reasoning_effort } : {})
      })
    }
  }
  return models.length ? { models } : null
}

let shared = null
export function museContextWindow(model) {
  shared = shared || createMuseCatalog()
  return shared.contextWindow(model)
}
