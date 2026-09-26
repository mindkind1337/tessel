// Specs for the Agent Task Board view: TaskBoard.vue (the 4-column kanban) and
// TaskCard.vue (a single task with move / edit / delete / assign controls).
// These mount the real components with @vue/test-utils and consume the live
// reactive store from B1 (src/renderer/src/taskBoardStore.js) — no IPC / no DOM
// terminal here. Written test-first: they fail until the components exist.

import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { COLUMNS } from '../../../shared/taskModel'
import { tasks, addTask, setTasks } from '../taskBoardStore'
import TaskBoard from '../components/TaskBoard.vue'
import TaskCard from '../components/TaskCard.vue'

const AGENT_PANES = [
  { id: 'pane-1', title: 'Claude', accent: '#c96442' },
  { id: 'pane-2', title: 'Codex', accent: '#10a37f' }
]

beforeEach(() => {
  // Reset the shared reactive store between tests without swapping the array
  // reference (the store and any watchers hold onto it).
  setTasks([])
})

describe('TaskBoard.vue', () => {
  it('renders one column per kanban status, labelled and in order', () => {
    const wrapper = mount(TaskBoard)
    const columns = wrapper.findAll('[data-test="column"]')
    expect(columns).toHaveLength(COLUMNS.length)
    columns.forEach((col, i) => {
      expect(col.attributes('data-column')).toBe(COLUMNS[i])
    })
  })

  it('renders each task as a TaskCard inside its column', () => {
    addTask({ title: 'In todo' })
    const doing = addTask({ title: 'In doing' })
    doing.column = 'doing'
    const wrapper = mount(TaskBoard)

    const todoCol = wrapper.get('[data-column="todo"]')
    const doingCol = wrapper.get('[data-column="doing"]')
    expect(todoCol.findAllComponents(TaskCard)).toHaveLength(1)
    expect(doingCol.findAllComponents(TaskCard)).toHaveLength(1)
    expect(todoCol.text()).toContain('In todo')
    expect(doingCol.text()).toContain('In doing')
  })

  it('passes agentPanes through to its TaskCards', () => {
    addTask({ title: 'needs an agent' })
    const wrapper = mount(TaskBoard, { props: { agentPanes: AGENT_PANES } })
    const card = wrapper.getComponent(TaskCard)
    expect(card.props('agentPanes')).toEqual(AGENT_PANES)
  })

  it('shows only the tasks of its workspace', () => {
    addTask({ title: 'Tessel task', wsId: 'ws-a' })
    addTask({ title: 'BridgeClip task', wsId: 'ws-b' })
    const wrapper = mount(TaskBoard, { props: { workspaceId: 'ws-a' } })
    expect(wrapper.findAllComponents(TaskCard)).toHaveLength(1)
    expect(wrapper.text()).toContain('Tessel task')
    expect(wrapper.text()).not.toContain('BridgeClip task')
  })

  it('adds new tasks to its workspace', async () => {
    const wrapper = mount(TaskBoard, { props: { workspaceId: 'ws-a' } })
    await wrapper.get('[data-test="new-task-input"]').setValue('For this project')
    await wrapper.get('[data-test="add-task-form"]').trigger('submit')
    expect(tasks.find((t) => t.title === 'For this project').wsId).toBe('ws-a')
  })

  it('adds a task through the add-task control', async () => {
    const wrapper = mount(TaskBoard)
    await wrapper.get('[data-test="new-task-input"]').setValue('Fresh task')
    await wrapper.get('[data-test="add-task-form"]').trigger('submit')

    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('Fresh task')
    expect(tasks[0].column).toBe('todo')
    // input clears after a successful add
    expect(wrapper.get('[data-test="new-task-input"]').element.value).toBe('')
  })

  it('does not add a blank task — no throw, no row', async () => {
    const wrapper = mount(TaskBoard)
    await wrapper.get('[data-test="new-task-input"]').setValue('   ')
    await wrapper.get('[data-test="add-task-form"]').trigger('submit')
    expect(tasks).toHaveLength(0)
  })

  it('reuses card DOM nodes on a single-task update — no full-board re-render', async () => {
    const a = addTask({ title: 'A' })
    addTask({ title: 'B' })
    const wrapper = mount(TaskBoard)

    const cardsBefore = wrapper.findAll('[data-test="task-card"]')
    const bNodeBefore = cardsBefore[1].element

    // Mutate only task A; B's DOM node must be the very same element (keyed reuse).
    a.title = 'A renamed'
    await nextTick()

    const cardsAfter = wrapper.findAll('[data-test="task-card"]')
    expect(cardsAfter[1].element).toBe(bNodeBefore)
    expect(wrapper.text()).toContain('A renamed')
  })
})

describe('TaskCard.vue', () => {
  // Mount a card backed by a real task in the store so we can assert that the
  // card drives the store mutators (it consumes the store, per the brief).
  function mountCard(overrides = {}) {
    const task = addTask({ title: 'Card task' })
    Object.assign(task, overrides)
    const wrapper = mount(TaskCard, {
      props: { task, agentPanes: AGENT_PANES }
    })
    return { wrapper, task }
  }

  it('shows the task title and current status', () => {
    const { wrapper } = mountCard({ column: 'doing' })
    expect(wrapper.get('[data-test="card-title"]').text()).toContain('Card task')
    expect(wrapper.get('[data-test="card-status"]').text().toLowerCase()).toContain('doing')
  })

  it('is moved by dragging only (no arrow buttons)', async () => {
    const { wrapper, task } = mountCard({ column: 'todo' })
    expect(wrapper.find('[data-test="move-prev"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="move-next"]').exists()).toBe(false)
    const data = {}
    const dataTransfer = { setData: (k, v) => (data[k] = v), effectAllowed: '' }
    await wrapper.get('[data-test="task-card"]').trigger('dragstart', { dataTransfer })
    expect(data['application/x-tessel-task']).toBe(task.id)
  })

  it('does not start a drag from its agent menu', async () => {
    const { wrapper } = mountCard({ column: 'todo' })
    const data = {}
    const dataTransfer = { setData: (k, v) => (data[k] = v), effectAllowed: '' }
    await wrapper.get('[data-test="assign-select"]').trigger('dragstart', { dataTransfer })
    expect(data).toEqual({})
  })

  it('edits the title and saves it back to the store', async () => {
    const { wrapper, task } = mountCard()
    await wrapper.get('[data-test="edit-title"]').trigger('click')
    const input = wrapper.get('[data-test="title-input"]')
    await input.setValue('Edited title')
    await input.trigger('keydown.enter')
    expect(task.title).toBe('Edited title')
    expect(wrapper.find('[data-test="title-input"]').exists()).toBe(false)
  })

  it('renames only in To do: no pencil once the task has started', async () => {
    for (const column of ['doing', 'review', 'done']) {
      const { wrapper, task } = mountCard({ column })
      expect(wrapper.find('[data-test="edit-title"]').exists()).toBe(false)
      await wrapper.get('[data-test="card-title"]').trigger('dblclick')
      expect(wrapper.find('[data-test="title-input"]').exists()).toBe(false)
      expect(task.title).toBe('Card task')
    }
  })

  it('keeps the old title when an edit is blanked — no silent wipe', async () => {
    const { wrapper, task } = mountCard()
    await wrapper.get('[data-test="edit-title"]').trigger('click')
    const input = wrapper.get('[data-test="title-input"]')
    await input.setValue('   ')
    await input.trigger('keydown.enter')
    expect(task.title).toBe('Card task')
  })

  it('deletes the task from the store', async () => {
    const { wrapper, task } = mountCard()
    expect(tasks).toContain(task)
    await wrapper.get('[data-test="delete-task"]').trigger('click')
    expect(tasks).not.toContain(task)
  })

  it('assigns the task to an agent pane and back to unassigned', async () => {
    const { wrapper, task } = mountCard()
    const select = wrapper.get('[data-test="assign-select"]')
    await select.setValue('pane-2')
    expect(task.paneId).toBe('pane-2')
    await select.setValue('')
    expect(task.paneId).toBeNull()
  })

  it('shows the assigned pane name when assigned', async () => {
    const { wrapper } = mountCard({ paneId: 'pane-1' })
    expect(wrapper.get('[data-test="assignee"]').text()).toContain('Claude')
  })

  it('falls back to the agentId when a pane has no title', () => {
    const task = addTask({ title: 'Card task' })
    task.paneId = 'pane-3'
    const wrapper = mount(TaskCard, {
      props: {
        task,
        agentPanes: [{ id: 'pane-3', agentId: 'gemini', accent: '#1a73e8' }]
      }
    })
    expect(wrapper.get('[data-test="assignee"]').text()).toContain('gemini')
    const options = wrapper.findAll('[data-test="assign-select"] option')
    expect(options.some((o) => o.text().includes('gemini'))).toBe(true)
  })
})

describe('when a task started and finished', () => {
  it('records the first start, the finish, and forgets the finish when reopened', async () => {
    const { tasks, addTask, moveTask } = await import('../taskBoardStore')
    const t = addTask({ title: 'Timed task' })
    moveTask(t.id, 'doing')
    const started = t.startedAt
    expect(typeof started).toBe('number')
    moveTask(t.id, 'review')
    moveTask(t.id, 'doing')
    expect(t.startedAt).toBe(started) // the first start stays
    moveTask(t.id, 'done')
    expect(typeof t.doneAt).toBe('number')
    moveTask(t.id, 'review')
    expect(t.doneAt).toBe(null)
    tasks.splice(tasks.indexOf(t), 1)
  })

  it('shows start, finish and duration on a done card', () => {
    const task = { id: 'task-t-1', title: 'Done card', column: 'done', paneId: null, startedAt: Date.now() - 23 * 60000, doneAt: Date.now() }
    const wrapper = mount(TaskCard, { props: { task, agentPanes: [] } })
    expect(wrapper.get('[data-test="task-timing"]').text()).toMatch(/^Started .+ · done .+ · 23 min$/)
  })
})

describe('the order of the cards in a column', () => {
  it('lists cards in the order they arrived, the latest at the bottom', async () => {
    const { tasks, addTask, moveTask } = await import('../taskBoardStore')
    const before = tasks.length
    const a = addTask({ title: 'First done' })
    const b = addTask({ title: 'Second done' })
    const now = Date.now
    let t = 1000
    Date.now = () => (t += 1000)
    try {
      moveTask(b.id, 'done') // b finished first
      moveTask(a.id, 'done')
    } finally {
      Date.now = now
    }
    const wrapper = mount(TaskBoard, { props: { agentPanes: [], workspaceId: null } })
    const done = wrapper.get('[data-column="done"]').findAll('[data-test="card-title"]').map((w) => w.text())
    expect(done.slice(-2)).toEqual(['Second done', 'First done'])
    tasks.splice(before)
  })
})
