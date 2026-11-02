import { t } from '../i18n'
import { bad, count, createCall, cut, jsonBody as json, moreWhen, pathId, publishedCard, publishedText, publishedTitle, query, shortened, text } from './shared'

// tessel_apps: Notion, on the pages the person picked on Notion's page. One fixed host. The app's
// capabilities are to read and to insert content: nothing here changes or deletes a page.
const API = 'https://api.notion.com/v1'
const HEADERS = { 'notion-version': '2026-03-11' }
const MAX_PAGES_OF_BLOCKS = 5
const MAX_BLOCK_TEXT = 2000 // what Notion takes in one piece of text
const MAX_NEW_BLOCKS = 100 // what Notion takes in one request

const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r?.plain_text ?? r?.text?.content ?? '').join('') : '')
const titleOf = (item) => {
  if (Array.isArray(item?.title)) return plain(item.title) || '(no title)'
  for (const p of Object.values(item?.properties || {})) if (p?.type === 'title') return plain(p.title) || '(no title)'
  return '(no title)'
}
const MARKS = { heading_1: '# ', heading_2: '## ', heading_3: '### ', bulleted_list_item: '- ', numbered_list_item: '1. ', to_do: '[ ] ', quote: '> ' }
function blockText(b) {
  const type = String(b?.type || '')
  if (type === 'child_page') return `[page: ${b.child_page?.title || ''}, id ${b.id}]`
  if (type === 'child_database') return `[database: ${b.child_database?.title || ''}, id ${b.id}]`
  const inside = b?.[type]
  const words = plain(inside?.rich_text)
  if (!words && !Array.isArray(inside?.rich_text)) return `[${type || 'block'}, id ${b?.id}]`
  const mark = type === 'to_do' && inside?.checked ? '[x] ' : Object.hasOwn(MARKS, type) ? MARKS[type] : ''
  return `${mark}${words}${b.has_children ? ` [has more inside: read id ${b.id}]` : ''}`
}
// A page's words as the pieces Notion takes: split on lines first, and never beyond what it takes.
function blocksOf(content) {
  const pieces = []
  for (const line of content.split(/\r?\n/)) {
    for (let at = 0; at < line.length || at === 0; at += MAX_BLOCK_TEXT) pieces.push(line.slice(at, at + MAX_BLOCK_TEXT))
  }
  if (pieces.length > MAX_NEW_BLOCKS) throw bad(`"content" is too long for one page: at most ${MAX_NEW_BLOCKS} lines of ${MAX_BLOCK_TEXT} characters.`)
  return pieces.map((words) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: words ? [{ type: 'text', text: { content: words } }] : [] } }))
}

export function createNotionTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'notion', name: 'Notion', hosts: ['api.notion.com'], fetchFn, headers: HEADERS })
  return {
    notion_search: {
      service: 'notion',
      async run(args) {
        const words = text(args.query, 'query', { max: 500 })
        const found = await call(args.account, `${API}/search`, json('POST', { ...(words ? { query: words } : {}), page_size: count(args.max, 20, 100) }))
        const items = found.results || []
        return items.length ? `${items.map((p) => `id: ${p.id}\n${titleOf(p)} (${p.object}${p.last_edited_time ? `, changed ${p.last_edited_time}` : ''})\n${p.url || ''}\n`).join('\n')}${moreWhen(found.has_more || found.request_status?.type === 'incomplete')}` : 'Nothing found. The user chooses which pages Tessel can see, on Notion\'s page or in Notion.'
      }
    },
    notion_read_page: {
      service: 'notion',
      async run(args) {
        const id = pathId(args.id, 'id')
        // A block inside a page has no title of its own; its words are what was asked for.
        const page = await call(args.account, `${API}/pages/${id}`).catch((err) => {
          if (err.code === 'not_found' || err.code === 'failed') return null
          throw err
        })
        const lines = []
        let start_cursor
        for (let round = 0; round < MAX_PAGES_OF_BLOCKS; round++) {
          const got = await call(args.account, `${API}/blocks/${id}/children?${query({ page_size: 100, start_cursor })}`)
          for (const b of got.results || []) lines.push(blockText(b))
          if (!got.has_more || !got.next_cursor) {
            start_cursor = null
            break
          }
          start_cursor = got.next_cursor
        }
        return `${page ? `${titleOf(page)}\n${page.url || ''}\n\n` : ''}${cut(lines.join('\n'))}${start_cursor ? '\n[the rest of the page is cut]' : ''}`
      }
    },
    notion_create_page: {
      service: 'notion',
      writes: true,
      describe: async (args) => {
        const id = shortened(args.parent, 60)
        let under = t('main.apps.card.notRead', '{{id}} (could not be read)', { id })
        let who = t('main.apps.card.couldNotTell', 'Tessel could not tell who can read this.')
        try {
          const page = await call(args.account, `${API}/pages/${pathId(args.parent, 'parent')}`)
          under = shortened(titleOf(page))
          who = page.public_url ? t('main.apps.card.publishedWeb', 'That page is published to the web: anyone can read this.') : t('main.apps.card.othersRead', 'Others with access can read this.')
        } catch {
          // the values above
        }
        return publishedCard({ before: [t('main.apps.card.underPage', 'Under the page: {{value}}', { value: under }), who], title: args.title, body: args.content })
      },
      // A workspace is shared: whoever can see the page above sees this one.
      eachTime: () => true,
      async run(args) {
        const title = publishedTitle(args.title, 'title', { max: MAX_BLOCK_TEXT })
        const content = publishedText(args.content, 'content')
        const made = await call(args.account, `${API}/pages`, json('POST', { parent: { page_id: text(args.parent, 'parent', { required: true, max: 100 }) }, properties: { title: { title: [{ text: { content: title } }] } }, ...(content ? { children: blocksOf(content) } : {}) }))
        return `Page created (id ${made.id}): ${made.url || ''}`
      }
    }
  }
}
