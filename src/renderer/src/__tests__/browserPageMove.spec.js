// A web page moved between the pane grid and the side panel
// (browser/pageMove.js, App.vue's pane drag): where it lands, what it keeps,
// what is saved, and what the agents' browser tools see afterwards.
import { describe, it, expect } from 'vitest'
import {
  paneDropZone,
  placeLeaf,
  sidePageFromLeaf,
  leafFromSidePage,
  saveSideBrowsers,
  restoreSideBrowsers,
  newSidePageId,
  SIDE_BROWSER_ID
} from '../browser/pageMove'
import { restoredSideTab } from '../sideTabs'
import { createAgentBrowserTargets } from '../browser/agentBrowserTargets'

const leaf = (id, kind = 'shell', extra = {}) => ({ type: 'leaf', id, kind, ...extra })
const split = (dir, ...children) => ({ type: 'split', id: 's-' + children.map((c) => c.id).join('-'), dir, sizes: children.map(() => 100 / children.length), children })
const makeSplit = (dir, children, sizes) => ({ type: 'split', id: 'new', dir, sizes, children })
const ids = (node) => (node.type === 'leaf' ? node.id : node.children.map(ids))
function forEachLeaf(node, fn) {
  if (!node) return
  if (node.type === 'leaf') fn(node)
  else node.children.forEach((c) => forEachLeaf(c, fn))
}
function removeLeaf(node, id) {
  if (node.type === 'leaf') return node.id === id ? null : node
  const children = node.children.map((c) => removeLeaf(c, id)).filter(Boolean)
  if (!children.length) return null
  return children.length === 1 ? children[0] : { ...node, children }
}
// App's makeBrowserLeaf, without its URL checks.
let seq = 0
const makeBrowserLeaf = (url = 'about:blank') => leaf(`pane-${++seq}`, 'browser', { title: 'Browser', url, zoom: 0, focusAddress: 0 })

describe('the drop zone on a pane', () => {
  it('its middle swaps; near a side, that side', () => {
    expect(paneDropZone(0.5, 0.5)).toBe('center')
    expect(paneDropZone(0.1, 0.5)).toBe('left')
    expect(paneDropZone(0.95, 0.4)).toBe('right')
    expect(paneDropZone(0.5, 0.05)).toBe('top')
    expect(paneDropZone(0.4, 0.9)).toBe('bottom')
  })
  it('a page from the side panel (nothing to swap with): always the nearest side', () => {
    expect(paneDropZone(0.5, 0.45, { center: false })).toBe('top')
    expect(paneDropZone(0.6, 0.5, { center: false })).toBe('right')
    expect(paneDropZone(0.1, 0.5, { center: false })).toBe('left')
  })
})

describe('placing a pane in a grid', () => {
  const grid = () => split('row', leaf('a'), split('col', leaf('b'), leaf('c')))

  it('beside a pane: left / right / top / bottom, half of its room', () => {
    const p = leaf('p')
    const right = placeLeaf(grid(), { kind: 'pane', id: 'b', zone: 'right' }, p, { makeSplit })
    expect(ids(right)).toEqual(['a', [['b', 'p'], 'c']])
    expect(right.children[1].children[0]).toMatchObject({ dir: 'row', sizes: [50, 50] })
    const top = placeLeaf(grid(), { kind: 'pane', id: 'c', zone: 'top' }, p, { makeSplit })
    expect(ids(top)).toEqual(['a', ['b', ['p', 'c']]])
    expect(top.children[1].children[1].dir).toBe('col')
    expect(ids(placeLeaf(grid(), { kind: 'pane', id: 'a', zone: 'left' }, p, { makeSplit }))).toEqual([['p', 'a'], ['b', 'c']])
    expect(ids(placeLeaf(grid(), { kind: 'pane', id: 'a', zone: 'bottom' }, p, { makeSplit }))).toEqual([['a', 'p'], ['b', 'c']])
  })

  it('leaves the original tree and the untouched branches as they were', () => {
    const g = grid()
    const next = placeLeaf(g, { kind: 'pane', id: 'a', zone: 'right' }, leaf('p'), { makeSplit })
    expect(ids(g)).toEqual(['a', ['b', 'c']])
    expect(next.children[1]).toBe(g.children[1])
  })

  it('along a side of the whole grid, a third of it', () => {
    const p = leaf('p')
    const left = placeLeaf(grid(), { kind: 'edge', id: 'ws', zone: 'left' }, p, { makeSplit })
    expect(ids(left)).toEqual(['p', ['a', ['b', 'c']]])
    expect(left).toMatchObject({ dir: 'row', sizes: [35, 65] })
    const bottom = placeLeaf(grid(), { kind: 'edge', id: 'ws', zone: 'bottom' }, p, { makeSplit })
    expect(bottom).toMatchObject({ dir: 'col', sizes: [65, 35] })
    expect(bottom.children[1]).toBe(p)
  })

  it('in a workspace of the sidebar: right of its active pane; alone in an empty grid', () => {
    const p = leaf('p')
    expect(ids(placeLeaf(grid(), { kind: 'ws', id: 'ws' }, p, { anchorId: 'c', makeSplit }))).toEqual(['a', ['b', ['c', 'p']]])
    expect(placeLeaf(null, { kind: 'pane', id: 'x', zone: 'left' }, p, { makeSplit })).toBe(p)
  })

  it('a pane that is gone: nothing placed', () => {
    expect(placeLeaf(grid(), { kind: 'pane', id: 'gone', zone: 'left' }, leaf('p'), { makeSplit })).toBe(null)
  })
})

describe('grid -> side panel -> grid', () => {
  it('a browser pane becomes a side page with its address, title and zoom', () => {
    const pane = leaf('pane-7', 'browser', { url: 'https://example.com/a?b=1', title: 'Example A', zoom: 1.5, openedBy: 'agent-1', viewPath: 'C:\\wt' })
    const page = sidePageFromLeaf(pane, 'web-abc', { blankUrl: 'about:blank', defaultTitle: 'Browser' })
    expect(page).toEqual({ id: 'web-abc', url: 'https://example.com/a?b=1', title: 'Example A', zoom: 1.5 })
  })

  it('a blank pane and its default name: a blank page with no title; an odd zoom clamped', () => {
    const pane = leaf('pane-8', 'browser', { url: 'about:blank', title: 'Browser', zoom: 42 })
    expect(sidePageFromLeaf(pane, 'web-x', { blankUrl: 'about:blank', defaultTitle: 'Browser' })).toEqual({ id: 'web-x', url: '', title: '', zoom: 5 })
  })

  it('a side page becomes a browser pane: a new pane id, its address, title and zoom, opened by no agent', () => {
    const made = leafFromSidePage({ id: 'web-abc', url: 'https://example.com/', title: 'Example', zoom: -1 }, (url) => makeBrowserLeaf(url))
    expect(made.id).toMatch(/^pane-/)
    expect(made).toMatchObject({ kind: 'browser', url: 'https://example.com/', title: 'Example', zoom: -1 })
    expect(made.openedBy).toBeUndefined()
    // A blank page: the pane's own blank page and name.
    const blank = leafFromSidePage({ id: 'web-b', url: '', title: '' }, (url) => makeBrowserLeaf(url))
    expect(blank).toMatchObject({ url: 'about:blank', title: 'Browser', zoom: 0 })
  })

  it('there and back: the same address, title and zoom', () => {
    const pane = leaf('pane-9', 'browser', { url: 'http://localhost:5173/settings', title: 'Settings', zoom: 0.5 })
    const page = sidePageFromLeaf(pane, newSidePageId([]), { blankUrl: 'about:blank', defaultTitle: 'Browser' })
    const back = leafFromSidePage(page, (url) => makeBrowserLeaf(url))
    expect(back).toMatchObject({ url: pane.url, title: pane.title, zoom: pane.zoom })
    expect(back.id).not.toBe(pane.id)
  })

  it('a new side page id: unlike the others, a valid one', () => {
    let n = 0
    const rolls = [0.123456789, 0.123456789, 0.987654321]
    const id = newSidePageId([{ id: 'web-' + (0.123456789).toString(36).slice(2, 10) }], () => rolls[n++])
    expect(n).toBe(3)
    expect(id).toBe('web-' + (0.987654321).toString(36).slice(2, 10))
    expect(SIDE_BROWSER_ID.test(newSidePageId(['web-a']))).toBe(true)
  })
})

describe('the side panel pages saved with the layout', () => {
  it('keeps the address, title and zoom across a reload (JSON)', () => {
    const pages = [
      { id: 'web-a1', url: 'https://example.com/', title: 'Example', zoom: 1 },
      { id: 'web-b2', url: '', title: '' }
    ]
    const saved = JSON.parse(JSON.stringify(saveSideBrowsers(pages)))
    expect(saved).toEqual([
      { id: 'web-a1', url: 'https://example.com/', title: 'Example', zoom: 1 },
      { id: 'web-b2', url: '', title: '', zoom: 0 }
    ])
    expect(restoreSideBrowsers(saved)).toEqual(saved)
  })

  it('drops what it cannot trust; an older layout (no zoom) opens at 100%', () => {
    const restored = restoreSideBrowsers([
      { id: 'web-a1', url: 'https://example.com/', title: 'Example' },
      { id: 'web-a1', url: 'https://dup.example/' },
      { id: 'pane-1', url: 'https://grid.example/' },
      { id: 'web-z9', url: 7, title: null, zoom: 'big' },
      null
    ])
    expect(restored).toEqual([
      { id: 'web-a1', url: 'https://example.com/', title: 'Example', zoom: 0 },
      { id: 'web-z9', url: '', title: '', zoom: 0 }
    ])
    expect(restoreSideBrowsers('nope')).toEqual([])
  })

  it('a page moved to the grid: its saved tab opens the Dashboard; one moved in opens again', () => {
    expect(restoredSideTab('web-gone', restoreSideBrowsers([{ id: 'web-a1', url: '' }]))).toBe('dashboard')
    expect(restoredSideTab('web-a1', restoreSideBrowsers([{ id: 'web-a1', url: '' }]))).toBe('web-a1')
  })
})

describe('an agent driving a page that moves', () => {
  function setup() {
    const ws = {
      id: 'A',
      cwd: 'C:\\a',
      activeId: 'agent-a',
      tree: split('row', leaf('agent-a', 'agent'), leaf('pane-page', 'browser', { url: 'http://localhost:3000/', title: 'App', openedBy: 'agent-a' }))
    }
    const guests = { 'pane-page': 101 }
    const targets = createAgentBrowserTargets({
      enabled: () => true,
      workspaces: () => [ws],
      forEachLeaf,
      sameView: () => true,
      guestOf: (id) => (id in guests ? guests[id] : null),
      paneLabel: (l) => l.id,
      openPage: () => null,
      sleep: () => Promise.resolve()
    })
    return { ws, guests, targets }
  }

  it('moved to the side panel: released, the agent no longer finds it', async () => {
    const { ws, guests, targets } = setup()
    expect((await targets.handle({ agent: 'agent-a', op: 'resolve', page: 'pane-page' })).guestId).toBe(101)
    // The move: a side page made from it, the pane out of the grid (its view
    // is destroyed with it).
    const pane = ws.tree.children[1]
    const sidePages = [sidePageFromLeaf(pane, newSidePageId([]), { blankUrl: 'about:blank', defaultTitle: 'Browser' })]
    ws.tree = removeLeaf(ws.tree, 'pane-page')
    delete guests['pane-page']
    // Neither its old id nor its side panel id reaches it.
    await expect(targets.handle({ agent: 'agent-a', op: 'resolve', page: 'pane-page' })).rejects.toMatchObject({ code: 'page_not_found' })
    await expect(targets.handle({ agent: 'agent-a', op: 'resolve', page: sidePages[0].id })).rejects.toMatchObject({ code: 'page_not_found' })
    await expect(targets.handle({ agent: 'agent-a', op: 'resolve', last: 'pane-page' })).rejects.toMatchObject({ code: 'no_page' })
    expect((await targets.handle({ agent: 'agent-a', op: 'list' })).pages).toEqual([])
  })

  it('back in the grid: a new page the agent may drive, not one it opened', async () => {
    const { ws, guests, targets } = setup()
    const page = sidePageFromLeaf(ws.tree.children[1], 'web-back', { blankUrl: 'about:blank', defaultTitle: 'Browser' })
    ws.tree = removeLeaf(ws.tree, 'pane-page')
    const back = leafFromSidePage(page, (url) => makeBrowserLeaf(url))
    ws.tree = placeLeaf(ws.tree, { kind: 'pane', id: 'agent-a', zone: 'right' }, back, { makeSplit })
    guests[back.id] = 202
    const list = await targets.handle({ agent: 'agent-a', op: 'list' })
    expect(list.pages).toEqual([{ page: back.id, url: 'http://localhost:3000/', title: 'App', ready: true, current: true }])
    expect((await targets.handle({ agent: 'agent-a', op: 'resolve', page: back.id })).guestId).toBe(202)
    // Not counted with the pages the agent opened.
    let mine = 0
    forEachLeaf(ws.tree, (l) => l.openedBy === 'agent-a' && mine++)
    expect(mine).toBe(0)
  })
})
