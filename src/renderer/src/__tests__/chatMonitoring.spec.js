// A chat pane's state for the sidebar (App.vue chatPaneState): its turn over
// while its background work runs is "monitoring". Runs App.vue's own
// function (as chatTeamDelivery.spec.js does).
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import vm from 'vm'
import { join } from 'path'
import { paneDotState, agentStateLabel } from '../sidebarModel'

const source = fs.readFileSync(join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
function slice(from, to) {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a)
  if (a < 0 || b < 0) throw new Error(`App.vue changed: ${from}`)
  return source.slice(a, b)
}

describe('chat pane state with background work', () => {
  let ctx
  beforeEach(() => {
    ctx = { reactive: (v) => v, limits: {}, attention: {} }
    vm.createContext(ctx)
    vm.runInContext(
      slice('const chatStatus = reactive({})', '// A new chat agent next to the active pane') +
        '\nthis.api = { chatPaneState, chatStatus, chatInterrupted, chatBackground }',
      ctx
    )
  })
  const leaf = (extra = {}) => ({ id: 'c1', kind: 'chat', ...extra })

  it('idle with background tasks running: monitoring (its dot and words in the sidebar)', () => {
    const { api } = ctx
    api.chatStatus.c1 = 'idle'
    api.chatBackground.c1 = 2
    expect(api.chatPaneState(leaf())).toBe('monitoring')
    expect(paneDotState({ kind: 'chat', state: 'monitoring' })).toBe('monitoring')
    expect(agentStateLabel('monitoring')).toBe('Monitoring background tasks')
  })

  it('working, an approval or a usage limit first; ready or waiting once the work is over', () => {
    const { api } = ctx
    api.chatBackground.c1 = 1
    api.chatStatus.c1 = 'working'
    expect(api.chatPaneState(leaf())).toBe('working')
    api.chatStatus.c1 = 'approval'
    expect(api.chatPaneState(leaf())).toBe('approval')
    api.chatStatus.c1 = 'idle'
    ctx.limits.c1 = { reset: '' }
    expect(api.chatPaneState(leaf())).toBe('limited')
    delete ctx.limits.c1
    api.chatBackground.c1 = 0
    expect(api.chatPaneState(leaf())).toBe('ready')
    ctx.attention.c1 = true
    expect(api.chatPaneState(leaf())).toBe('waiting')
  })

  it("after a reload (no event yet): the pane's own status and count", () => {
    const { api } = ctx
    expect(api.chatPaneState(leaf({ liveStatus: 'idle', liveBackground: 1 }))).toBe('monitoring')
    expect(api.chatPaneState(leaf({ liveStatus: 'idle', liveBackground: 0 }))).toBe('ready')
    // An event that says the work ended wins over the pane's older count.
    api.chatBackground.c1 = 0
    expect(api.chatPaneState(leaf({ liveStatus: 'idle', liveBackground: 1 }))).toBe('ready')
    expect(api.chatPaneState(leaf({ liveStatus: 'ended', liveBackground: 1 }))).toBe('stopped')
  })
})
