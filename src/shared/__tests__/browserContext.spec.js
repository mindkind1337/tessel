import { describe, it, expect } from 'vitest'
import { formatElementContext, formatDesignFeedback, inlineText, stripControls, fence } from '../browserContext'

const payload = (over = {}) => ({
  url: 'https://example.com/settings?tab=1',
  title: 'Settings',
  viewport: { width: 1280, height: 800 },
  scroll: { x: 0, y: 0 },
  devicePixelRatio: 1,
  element: {
    tag: 'button',
    selector: 'button#save',
    path: 'main > #save',
    fullPath: 'main.page > button#save',
    classes: 'btn primary',
    role: 'button',
    accessibleName: 'Save changes',
    text: 'Save',
    selectedText: null,
    html: '<button id="save">Save</button>',
    attributes: { id: 'save' },
    rect: { x: 10.4, y: 20.6, width: 100.2, height: 30 },
    styles: {
      display: 'inline-block', position: 'static', width: '100px', height: 'auto', margin: '0px',
      padding: '4px', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', border: '', borderRadius: '4px',
      fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: 'normal', textAlign: 'center', zIndex: 'auto'
    },
    react: '<App> <SaveButton>',
    source: 'src/SaveButton.jsx:12:4',
    ancestors: ['main', 'body'],
    nearbyText: ['Cancel', 'Profile'],
    ...over
  }
})

describe('formatElementContext', () => {
  it('writes Orca-style grab text', () => {
    expect(formatElementContext(payload())).toBe([
      'Attached browser context from https://example.com/settings?tab=1',
      '',
      'Selected element:',
      'button',
      'Accessible name: "Save changes"',
      'Role: button',
      'Selector: button#save',
      'Source: src/SaveButton.jsx:12:4',
      'React: <App> <SaveButton>',
      'Dimensions: 100x30',
      '',
      'Text content:',
      'Save',
      '',
      'Nearby context:',
      '- Cancel',
      '- Profile',
      '',
      'Computed styles:',
      '  display: inline-block',
      '  font-size: 14px',
      '  color: rgb(0, 0, 0)',
      '',
      'HTML:',
      '<button id="save">Save</button>',
      '',
      'Ancestor path: main > body',
      'Full DOM path: main.page > button#save'
    ].join('\n'))
  })

  it('returns nothing for a non-payload', () => {
    expect(formatElementContext(null)).toBe('')
    expect(formatElementContext({ cancelled: true })).toBe('')
  })

  it('strips terminal control characters from page text', () => {
    const out = formatElementContext(payload({
      text: 'Hi\u001b[2J\u001b]0;pwned\u0007 there\r\nnext',
      accessibleName: 'A\u0000B\u009bC\u202eD',
      html: '<p>\u001b[31mred</p>\r\n<p>\ttab</p>',
      nearbyText: ['x\u001b[201~y']
    }))
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/)
    expect(out).toContain('Text content:\nHi[2J]0;pwned there next')
    expect(out).toContain('Accessible name: "ABCD"')
    expect(out).toContain('<p>[31mred</p>\n<p>\ttab</p>')
    expect(out).toContain('- x[201~y')
  })
})

describe('formatDesignFeedback', () => {
  it('writes Design Feedback markdown with intents and screenshots', () => {
    const out = formatDesignFeedback({
      url: 'https://example.com/settings?tab=1',
      title: 'Settings',
      viewport: { width: 1280, height: 800 },
      items: [
        { payload: payload(), comment: 'Make it\nblue', intent: 'change', screenshot: 'C:\\Temp\\pick-1.png' },
        { payload: payload({ accessibleName: null, react: null, text: 'Hello world', path: '', fullPath: '', html: '' }), comment: 'Why?', intent: 'question', screenshot: null },
        { payload: payload(), comment: 'x', intent: 'approve' }
      ]
    })
    const lines = out.split('\n')
    expect(lines.slice(0, 6)).toEqual([
      '## Design Feedback: /settings?tab=1',
      '',
      '**URL:** https://example.com/settings?tab=1',
      '**Title:** Settings',
      '**Viewport:** 1280x800',
      ''
    ])
    expect(out).toContain([
      '### 1. <App> <SaveButton> button "Save changes"',
      '**Intent:** change',
      '**Selector:** `button#save`',
      '**Location:** `main > #save`',
      '**Source:** src/SaveButton.jsx:12:4',
      '**React:** <App> <SaveButton>',
      '**Bounds:** x=10, y=21, 100x30',
      '**Classes:** `btn primary`',
      '**Text:** "Save"',
      '**Nearby text:**',
      '- Cancel',
      '- Profile',
      '**Computed styles:**',
      '- display: inline-block',
      '- width: 100px',
      '- margin: 0px',
      '- padding: 4px',
      '- color: rgb(0, 0, 0)',
      '- border-radius: 4px',
      '- font-family: Inter',
      '- font-size: 14px',
      '- font-weight: 400',
      '- text-align: center',
      '**Full DOM path:** `main.page > button#save`',
      '**HTML:**',
      '````html',
      '<button id="save">Save</button>',
      '````',
      '**Screenshot:** C:\\Temp\\pick-1.png',
      '**Feedback:** Make it blue'
    ].join('\n'))
    expect(out).toContain('### 2. button "Hello world"\n**Intent:** question')
    expect(out).not.toContain('Browser tab id')
    expect(out).not.toMatch(/### 2\.[^#]*Screenshot/)
    expect(out).toMatch(/### 3\.[^\n]*\n\*\*Intent:\*\* change/)
    expect(out.endsWith('**Feedback:** x')).toBe(true)
  })

  it('uses a fence longer than any backtick run in the HTML', () => {
    const out = formatDesignFeedback({
      items: [{ payload: payload({ html: '<pre>`````\n```js</pre>', selector: 'a`b' }), comment: 'c', intent: 'change' }]
    })
    expect(out).toContain('``````html\n<pre>`````\n```js</pre>\n``````')
    expect(out).toContain('**Selector:** ``a`b``')
    // Falls back to the payload's own url and viewport.
    expect(out).toContain('## Design Feedback: /settings?tab=1')
    expect(out).toContain('**Viewport:** 1280x800')
  })

  it('cleans control characters and collapses the comment', () => {
    const out = formatDesignFeedback({
      items: [{ payload: payload({ selector: 'a\u001b[0m' }), comment: 'line1\r\n\u001b]52;c;x\u0007line2', intent: 'change', screenshot: 'C:\\s.png\u001b' }]
    })
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(out).toContain('**Feedback:** line1 ]52;c;xline2')
    expect(out).toContain('**Screenshot:** C:\\s.png')
  })

  it('returns nothing without items', () => {
    expect(formatDesignFeedback({ items: [] })).toBe('')
    expect(formatDesignFeedback()).toBe('')
    expect(formatDesignFeedback({ items: [{ payload: { cancelled: true } }] })).toBe('')
  })
})

describe('helpers', () => {
  it('inlineText collapses whitespace and caps length', () => {
    expect(inlineText('  a \n\t b  ')).toBe('a b')
    expect(inlineText('x'.repeat(5000))).toHaveLength(2048)
    expect(inlineText(null)).toBe('')
  })

  it('stripControls keeps newlines and tabs', () => {
    expect(stripControls('a\r\nb\tc\u001bd\re')).toBe('a\nb\tcd\ne')
  })

  it('fence has at least four backticks', () => {
    expect(fence('html', 'x')).toEqual(['````html', 'x', '````'])
  })
})
