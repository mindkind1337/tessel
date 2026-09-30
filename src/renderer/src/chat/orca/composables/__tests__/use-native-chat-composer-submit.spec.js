// After Orca's use-native-chat-composer-submit.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)

import { act, renderHook } from './withSetup.js'
import { describe, expect, it, vi } from 'vitest'

import { useNativeChatComposerSubmit } from '../use-native-chat-composer-submit.js'

const GOAL_ITEM = {
  kind: 'command',
  id: 'goal',
  name: 'goal',
  token: '/goal',
  skillCollision: false,
}
const MODEL_ITEM = {
  ...GOAL_ITEM,
  id: 'model',
  name: 'model',
  token: '/model',
}

function harness(options) {
  const onError = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit reads only threadGoal and onError.
  const structuredTransport = {
    onError,
    ...(options.threadGoal ? { threadGoal: options.threadGoal } : {}),
  }
  const calls = {
    sendPty: vi.fn(),
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn(),
  }
  const hook = renderHook(
    (props) =>
      useNativeChatComposerSubmit({
        structuredTransport: options.lane === 'pty' ? undefined : structuredTransport,
        draft: props.draft,
        caret: props.caret,
        imageAttachments: options.imageAttachments ?? [],
        disabled: false,
        ...calls,
      }),
    { initialProps: { draft: options.draft, caret: options.caret ?? options.draft.length } },
  )
  return { hook, calls, onError }
}

describe('composer goal mode', () => {
  it('enters goal mode on a /goal pick and drops the token from the draft', () => {
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective: vi.fn() } })
    const pick = vi.fn()

    act(() => hook.result.current.goalMode.interceptPick(pick)(GOAL_ITEM))

    expect(pick).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(calls.setCaret).toHaveBeenCalledWith(0)
    expect(hook.result.current.goalMode.active.value).toBe(true)

    act(() => hook.result.current.goalMode.exit())
    expect(hook.result.current.goalMode.active.value).toBe(false)
  })

  it('leaves other picks, and /goal on a host without goals, to the picker', () => {
    const withGoals = harness({ draft: '/mo', threadGoal: { setObjective: vi.fn() } })
    const pick = vi.fn()
    act(() => withGoals.hook.result.current.goalMode.interceptPick(pick)(MODEL_ITEM))
    expect(pick).toHaveBeenCalledWith(MODEL_ITEM)

    const withoutGoals = harness({ draft: '/go' })
    act(() => withoutGoals.hook.result.current.goalMode.interceptPick(pick)(GOAL_ITEM))
    expect(pick).toHaveBeenCalledWith(GOAL_ITEM)
    expect(withoutGoals.hook.result.current.goalMode.active.value).toBe(false)
  })

  it('sets the draft as the goal instead of sending it, then leaves goal mode', async () => {
    const setObjective = vi.fn(async () => ({ ok: true }))
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: '  Ship the parser  ', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenLastCalledWith('')
    expect(hook.result.current.goalMode.active.value).toBe(false)
  })

  it('keeps the draft and goal mode when the goal is refused', async () => {
    const setObjective = vi.fn(async () => ({ ok: false }))
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    hook.rerender({ draft: 'Ship the parser', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledOnce()
    expect(calls.setDraft).not.toHaveBeenCalled()
    expect(hook.result.current.goalMode.active.value).toBe(true)
  })

  it('refuses attachments in goal mode rather than dropping them', () => {
    const setObjective = vi.fn(async () => ({ ok: true }))
    const { hook, onError } = harness({
      draft: '/go',
      threadGoal: { setObjective },
      imageAttachments: [{ id: 'a1', imageId: 'img_000000000000000000000001', name: 'shot.png' }],
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: 'Ship the parser', caret: 0 })

    act(() => hook.result.current.send())

    expect(setObjective).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('A goal is text only. Remove the images first.')
  })

  it('sends attached images (even with no text) and waits for one still saving', () => {
    const images = harness({ draft: '', imageAttachments: [{ id: 'a1', imageId: 'img_000000000000000000000001', name: 'a.png' }] })
    act(() => images.hook.result.current.send())
    expect(images.calls.sendStructured).toHaveBeenCalledWith('', [{ id: 'a1', imageId: 'img_000000000000000000000001', name: 'a.png' }])

    const saving = harness({ draft: 'look', imageAttachments: [{ id: 'a2', name: 'image.png', pending: true }] })
    act(() => saving.hook.result.current.send())
    expect(saving.calls.sendStructured).not.toHaveBeenCalled()
    expect(saving.onError).toHaveBeenCalledWith('An image is still being attached. Send again in a moment.')
  })

  it('enters goal mode from a typed bare /goal, like the pick does', () => {
    const { hook, calls } = harness({ draft: '/goal ', threadGoal: { setObjective: vi.fn() } })
    act(() => hook.result.current.send())
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(hook.result.current.goalMode.active.value).toBe(true)

    // With an objective it is the host command, and without goals it is message text.
    const withObjective = harness({ draft: '/goal ship it', threadGoal: { setObjective: vi.fn() } })
    act(() => withObjective.hook.result.current.send())
    expect(withObjective.calls.sendStructured).toHaveBeenCalledWith('/goal ship it', [])
    const withoutGoals = harness({ draft: '/goal' })
    act(() => withoutGoals.hook.result.current.send())
    expect(withoutGoals.calls.sendStructured).toHaveBeenCalledWith('/goal', [])
    expect(withoutGoals.hook.result.current.goalMode.active.value).toBe(false)
  })

  it('keeps a bare /goal typed inside goal mode as the entrance, not the objective', () => {
    const setObjective = vi.fn(async () => ({ ok: true }))
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    hook.rerender({ draft: '/goal', caret: 5 })

    act(() => hook.result.current.send())

    expect(setObjective).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(hook.result.current.goalMode.active.value).toBe(true)
  })

  it('sets the objective a /goal typed inside goal mode names, not the literal command', async () => {
    const setObjective = vi.fn(async () => ({ ok: true }))
    const { hook } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: '/goal  fix the parser ', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('fix the parser')
    expect(hook.result.current.goalMode.active.value).toBe(false)
  })

  it('keeps a draft edited while the goal was in flight, and stays in goal mode', async () => {
    let settle = () => undefined
    const setObjective = vi.fn(() => new Promise((resolve) => (settle = resolve)))
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: 'Ship the parser', caret: 0 })
    calls.setDraft.mockClear()

    act(() => hook.result.current.send())
    hook.rerender({ draft: 'Ship the parser and its tests', caret: 0 })
    await act(async () => settle({ ok: true }))

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(calls.setHistory).toHaveBeenCalledOnce()
    expect(calls.setDraft).not.toHaveBeenCalled()
    expect(hook.result.current.goalMode.active.value).toBe(true)
  })

  it('sends an ordinary message outside goal mode', () => {
    const { hook, calls } = harness({ draft: 'hello', threadGoal: { setObjective: vi.fn() } })
    act(() => hook.result.current.send())
    expect(calls.sendStructured).toHaveBeenCalledWith('hello', [])
  })
})
