import { describe, expect, it } from 'vitest'
import { useNativeChatTranscriptLifecycle } from '../use-native-chat-transcript-lifecycle.js'

describe('transcript lifecycle pagination races', () => {
  it('accepts matching pagination and rejects a page overtaken by a live completion', () => {
    const [state, control] = useNativeChatTranscriptLifecycle()
    const initial = control.revision()
    control.replaceFromPagination({ state: 'running' }, initial)
    expect(state.value.state).toBe('running')
    const pageRevision = control.revision()
    control.append({ state: 'completed' })
    control.replaceFromPagination({ state: 'running' }, pageRevision)
    expect(state.value.state).toBe('completed')
    const revision = control.revision()
    control.append(undefined)
    expect(control.revision()).toBe(revision)
    control.reset()
    expect(state.value).toBeUndefined()
    control.replaceFromPagination({ state: 'running' }, revision)
    expect(state.value).toBeUndefined()
  })
})
