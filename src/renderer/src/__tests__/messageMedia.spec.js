// What a message shares (links/messageMedia.js): its links, images, videos,
// files, folders and code blocks, the type filter, the counts per type and
// the Media view's items.
import { describe, it, expect } from 'vitest'
import { filterByTypes, isVideoUrl, mediaItems, mediaOf, pathType, siteOf, typeCounts } from '../links/messageMedia'

const line = (key, text, extra = {}) => ({ key, t: 1000 + Number(key.replace(/\D/g, '') || 0), text, from: { kind: 'agent', label: 'Ada' }, to: { kind: 'you', label: 'You' }, ...extra })
const types = (text, extra) => mediaOf(line('x', text, extra)).types
const items = (text, extra) => mediaOf(line('x', text, extra)).items

describe('messageMedia', () => {
  it('web links: bare or Markdown (with their title and site), mail addresses; sentence punctuation left out', () => {
    const got = items('See https://docs.example.com/guide/intro. Also [the RFC](https://www.rfc-editor.org/rfc/rfc9110) and mailto:ada@example.com, (https://x.org/a_(b))')
    expect(got.map((x) => [x.type, x.url])).toEqual([
      ['link', 'https://www.rfc-editor.org/rfc/rfc9110'],
      ['link', 'https://docs.example.com/guide/intro'],
      ['link', 'mailto:ada@example.com'],
      ['link', 'https://x.org/a_(b)']
    ])
    expect(got[0]).toMatchObject({ title: 'the RFC', site: 'rfc-editor.org', label: 'the RFC' })
    expect(got[1]).toMatchObject({ title: '', site: 'docs.example.com', label: 'docs.example.com' })
    expect(siteOf('https://www.youtube.com/watch?v=1')).toBe('youtube.com')
    // javascript: and other schemes are never items.
    expect(items('[x](javascript:alert(1)) ftp://host/file')).toEqual([])
  })

  it('videos: YouTube, Vimeo and Twitch pages, video files and addresses', () => {
    expect(isVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true)
    expect(isVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
    expect(isVideoUrl('https://vimeo.com/123456')).toBe(true)
    expect(isVideoUrl('https://www.twitch.tv/somebody')).toBe(true)
    expect(isVideoUrl('https://cdn.example.com/clips/demo.mp4?x=1')).toBe(true)
    expect(isVideoUrl('https://example.com/watch')).toBe(false)
    expect(isVideoUrl('https://notyoutube.com/v')).toBe(false)
    expect(types('Recorded C:\\work\\demo\\capture.webm and https://vimeo.com/42')).toEqual(['video'])
    expect(pathType('/home/ada/out/screen.MOV')).toBe('video')
  })

  it('images: the line’s own (WP3), data: images, image files and addresses', () => {
    const held = items('Look', { images: [{ key: 'a'.repeat(24), name: 'shot.png', mime: 'image/png', bytes: 10, source: 'tool' }, { path: 'C:\\tmp\\gone.png', missing: true, source: 'user' }] })
    expect(held.map((x) => [x.type, x.label, x.held])).toEqual([
      ['image', 'shot.png', true],
      ['image', 'gone.png', true]
    ])
    expect(types('![chart](data:image/png;base64,iVBORw0KGgo=)')).toEqual(['image'])
    expect(items('![chart](data:image/png;base64,iVBORw0KGgo=)')[0]).toMatchObject({ type: 'image', src: 'data:image/png;base64,iVBORw0KGgo=' })
    expect(items('Saved to `C:\\Tessel\\out\\shot.png`')[0]).toMatchObject({ type: 'image', path: 'C:\\Tessel\\out\\shot.png', label: 'shot.png' })
    expect(items('https://example.com/a/logo.svg')[0]).toMatchObject({ type: 'image', site: 'example.com' })
  })

  it('files and folders: the paths the chat links, with their line; a rooted path without an extension or with a trailing separator is a folder', () => {
    const got = items('Changed src/renderer/src/App.vue:120 and C:\\Tessel-claude\\t2-wp7\\docs\\plan.pdf, the copy is C:\\Tessel-claude\\t2-wp7 and ~/work/app/ too')
    expect(got.map((x) => [x.type, x.path, x.line])).toEqual([
      ['file', 'src/renderer/src/App.vue', 120],
      ['file', 'C:\\Tessel-claude\\t2-wp7\\docs\\plan.pdf', null],
      ['folder', 'C:\\Tessel-claude\\t2-wp7', null],
      ['folder', '~/work/app/', null]
    ])
    expect(pathType('/etc/.env')).toBe('file')
    // A bare name links nowhere: not a file.
    expect(types('Open package.json please')).toEqual([])
    // A prompt's file.
    expect(items('', { files: [{ name: 'spec.pdf', path: 'C:\\docs\\spec.pdf', size: 10 }] })[0]).toMatchObject({ type: 'file', path: 'C:\\docs\\spec.pdf', held: true })
  })

  it('code: one item per fenced block (its language and first line); a block’s content is not read for links, unless it is one path', () => {
    const got = items('Run:\n```bash\nnpm test # see https://example.com/inside\nnpm run build\n```\nthen\n```\nC:\\proj\\out\\log.txt\n```')
    expect(got.map((x) => x.type)).toEqual(['code', 'code', 'file'])
    expect(got[0]).toMatchObject({ lang: 'bash', preview: 'npm test # see https://example.com/inside', lines: 2 })
    expect(got[2].path).toBe('C:\\proj\\out\\log.txt')
    expect(types('Inline `code` is not a block')).toEqual([])
  })

  it('is read once per text (memoized), whatever the line object', () => {
    const a = mediaOf(line('m1', 'See https://a.example.com'))
    const b = mediaOf(line('m2', 'See https://a.example.com'))
    expect(b.items).toBe(a.items)
  })

  it('filters threads by type (any of the chosen), counts messages per type, lists the Media items newest first', () => {
    const threads = [
      { key: 'you:p1', lines: [line('l1', 'plain'), line('l2', 'https://youtu.be/x'), line('l3', '```js\nx()\n```\nand https://a.org')] },
      { key: 'team:t', lines: [line('l4', 'C:\\proj\\src\\a.js'), line('l5', 'nothing')] }
    ]
    expect(filterByTypes(threads, [])).toBe(threads)
    const links = filterByTypes(threads, ['link'])
    expect(links.map((t) => t.lines.map((l) => l.key))).toEqual([['l3']])
    expect(links[0].count).toBe(1)
    const some = filterByTypes(threads, ['video', 'file'])
    expect(some.map((t) => t.lines.map((l) => l.key))).toEqual([['l2'], ['l4']])
    expect(filterByTypes(threads, ['folder'])).toEqual([])
    expect(typeCounts(threads)).toEqual({ link: 1, image: 0, video: 1, file: 1, folder: 0, code: 1 })
    const all = mediaItems(threads)
    expect(all.map((x) => `${x.line.key}:${x.type}`)).toEqual(['l4:file', 'l3:code', 'l3:link', 'l2:video'])
    expect(all[0].thread.key).toBe('team:t')
    expect(mediaItems(threads, ['code']).map((x) => x.type)).toEqual(['code'])
  })
})
