// The sidebar's hover cards, ported from Orca's HoverCard / WorktreeCardDetailsHover:
// workspace cards and agent rows show their details in a styled card after
// a delay, instead of native title tooltips.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import WorkspaceSidebar from '../components/WorkspaceSidebar.vue'
import { settings, resetSettings } from '../settings'
import { _resetFeedsForTest } from '../agentChildrenFeed'

const NOW = Date.now()
const pane = (id, extra = {}) => ({ id, num: 1, kind: 'agent', title: id, agentId: 'codex', state: 'ready', ...extra })

function projects() {
  return [
    {
      id: 'ws1',
      name: 'Shop',
      cwd: 'C:\\repo',
      branch: 'main',
      panes: [
        pane('a', { num: 1, title: 'Codex', task: 'Fix the cart', state: 'working', since: NOW - 120000, team: 'tm1', lead: true }),
        pane('c', {
          num: 3,
          title: 'Claude',
          agentId: 'claude',
          state: 'approval',
          copyPath: 'C:\\repo.worktrees\\fix-login',
          copyBranch: 'tessel/fix-login'
        })
      ],
      copies: [{ path: 'C:\\repo.worktrees\\fix-login', branch: 'tessel/fix-login', title: 'Fix the login', taskId: 'T1' }]
    }
  ]
}

const PORTS = {
  'ws1::': [{ id: '0.0.0.0:5173:4242', port: 5173, pid: 4242, processName: 'node.exe', connectHost: 'localhost', protocol: 'http', kind: 'workspace' }]
}

let mounted = []
function mountSidebar() {
  const w = mount(WorkspaceSidebar, {
    props: { projects: projects(), currentId: 'ws1', ports: PORTS, now: NOW, teams: [{ id: 'tm1', name: 'Team 2' }] },
    attachTo: document.body
  })
  mounted.push(w)
  return w
}

async function wait(ms) {
  vi.advanceTimersByTime(ms)
  await nextTick()
  await nextTick()
}
const cards = (sel = '.hover-card') => [...document.querySelectorAll(sel)]
const agentRow = (w, id) => w.find(`.compact-agent-row[data-pane-id="${id}"]`)
const cardFor = (w, title) => w.findAll('.wtc-row').find((c) => c.find('.wtc-title').text().includes(title))

beforeEach(() => {
  vi.useFakeTimers()
  resetSettings()
  settings.sidebarSortBy = 'manual'
  window.shellApi = {}
})
afterEach(() => {
  for (const w of mounted) {
    try {
      w.unmount()
    } catch {
      // already unmounted
    }
  }
  mounted = []
  document.body.innerHTML = ''
  _resetFeedsForTest()
  vi.useRealTimers()
})

describe('sidebar hover cards', () => {
  it('workspace cards and agent rows carry no native title tooltip, but keep their accessible text', () => {
    const w = mountSidebar()
    for (const row of w.findAll('.wtc-row')) expect(row.findAll('[title]').map((e) => e.attributes('title'))).toEqual([])
    const row = agentRow(w, 'a')
    expect(row.attributes('aria-label')).toBe('Codex - Fix the cart, Working, Team: Team 2 (lead), Pane 1')
    const copy = cardFor(w, 'Fix the login')
    const desc = document.getElementById(copy.attributes('aria-describedby'))
    expect(desc.textContent).toBe('tessel/fix-login, C:\\repo.worktrees\\fix-login')
  })

  it("an agent row's card opens after Orca's 250 ms, shows its details and closes 120 ms after the pointer leaves", async () => {
    const w = mountSidebar()
    const row = agentRow(w, 'a')
    await row.trigger('pointerover')
    await wait(200)
    expect(cards()).toHaveLength(0)
    await wait(60)
    const [card] = cards('.agent-hover-card')
    expect(card).toBeTruthy()
    const text = card.textContent
    expect(text).toContain('Fix the cart')
    expect(text).toContain('Codex')
    expect(text).toContain('Working · 2m')
    expect(text).toContain('Team 2 (lead)')
    expect(text).toContain('Pane 1')
    // Beside the row, like Radix side="right".
    expect(card.dataset.side).toBe('right')
    expect(card.style.left).toMatch(/px$/)

    // The pointer can travel onto the card: it stays open.
    row.element.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: card }))
    card.dispatchEvent(new Event('pointerenter'))
    await wait(300)
    expect(cards('.agent-hover-card')).toHaveLength(1)

    card.dispatchEvent(new Event('pointerleave'))
    await wait(100)
    expect(cards('.agent-hover-card')).toHaveLength(1)
    await wait(30)
    expect(cards()).toHaveLength(0)
  })

  it('Esc closes the card; it stays closed until the pointer comes back', async () => {
    const w = mountSidebar()
    const row = agentRow(w, 'a')
    await row.trigger('pointerover')
    await wait(260)
    expect(cards()).toHaveLength(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(cards()).toHaveLength(0)
    await row.trigger('pointerover')
    await wait(300)
    expect(cards()).toHaveLength(0)
    await row.trigger('pointerleave')
    await row.trigger('pointerover')
    await wait(260)
    expect(cards()).toHaveLength(1)
  })

  it('opens on keyboard focus too, and a scroll closes it', async () => {
    const w = mountSidebar()
    await agentRow(w, 'c').trigger('focusin')
    await wait(260)
    expect(cards('.agent-hover-card')[0].textContent).toContain('Waiting for input')
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(cards()).toHaveLength(0)
  })

  it("the workspace's details card (Orca's WorktreeCardDetailsHover) shows title, branch, status, folder and live ports", async () => {
    const w = mountSidebar()
    const copy = cardFor(w, 'Fix the login')
    await copy.find('.wtc-parent').trigger('pointerover')
    await wait(110)
    const [card] = cards('.worktree-hover-card')
    const text = card.textContent
    expect(card.querySelector('.hc-title').textContent).toBe('Fix the login')
    expect(card.querySelector('.hc-branch').textContent).toBe('tessel/fix-login')
    expect(card.querySelector('.hc-status').textContent).toMatch(/^Needs permission/)
    expect(text).toContain('C:\\repo.worktrees\\fix-login')

    const main = cardFor(w, 'repo')
    await copy.find('.wtc-parent').trigger('pointerleave')
    await main.find('.wtc-parent').trigger('pointerover')
    await wait(130)
    // One hover card at a time.
    expect(cards()).toHaveLength(1)
    const mainCard = cards('.worktree-hover-card')[0]
    expect(mainCard.textContent).toContain('Live Ports (1)')
    expect(mainCard.textContent).toContain('localhost:5173')
    expect(mainCard.textContent).toContain('Primary worktree (original clone directory)')
    mainCard.querySelector('[aria-label="Open in Browser"]').click()
    expect(w.emitted('port-open')[0][0].port).toBe(5173)
  })

  it('resting on an agent row inside the workspace does not open the workspace card', async () => {
    const w = mountSidebar()
    const main = cardFor(w, 'repo')
    await main.find('.compact-agent-row').trigger('pointerover')
    await wait(300)
    expect(cards('.worktree-hover-card')).toHaveLength(0)
    expect(cards('.agent-hover-card')).toHaveLength(1)
  })
})
