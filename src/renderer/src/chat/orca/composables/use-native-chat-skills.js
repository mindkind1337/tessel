// After Orca's use-native-chat-skills.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// agent, pane and enabled are reactive. Fourth options argument injects discover().
// Returns refs status/skills/error/errorKind and retry; no store, RPC or remote scan.
// discover({agent,pane,refresh,signal}) returns {skills,sources}; timeouts are bounded.
import { computed, ref, watch, toValue, onScopeDispose } from 'vue'
import { getNativeChatAgentProfile } from '../shared/native-chat-agent-profiles.js'
import { composerOptions } from './composer-options.js'
import { t } from '../../../i18n/index.js'
export function isNativeChatSkillForAgent(agent, skill, result) {
  const profile = getNativeChatAgentProfile(agent)
  if (!profile) return false
  if (!result)
    return (
      agent === 'codex' &&
      (skill.providers.includes('codex') || skill.providers.includes('agent-skills'))
    )
  return (skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]).some((root) => {
    const source = result.sources?.find((entry) => entry.path === root)
    return source?.owner === null || source?.owner === profile.skillSourceOwner
  })
}
// No global discovery state is retained in the Tessel adapter.
export function resetNativeChatSkillDiscoveryCacheForTests() {}
export function useNativeChatSkills(agent, terminalTabId, enabled = false, options = {}) {
  const { read, fn } = composerOptions(options)
  const state = ref({ status: 'idle', skills: [], error: null, errorKind: undefined })
  const retryGeneration = ref(0),
    cache = new Map()
  let force = false
  const stop = watch(
    () => [
      toValue(agent),
      toValue(terminalTabId),
      toValue(enabled),
      read('contextKey'),
      retryGeneration.value,
      fn('discover'),
    ],
    ([agentId, pane, active, contextKey, , discover], _, cleanup) => {
      let canceled = false
      const controller = new AbortController()
      let timer
      cleanup(() => {
        canceled = true
        clearTimeout(timer)
        controller.abort()
      })
      if (!active || !getNativeChatAgentProfile(agentId)) {
        force = false
        state.value = { status: 'idle', skills: [], error: null }
        return
      }
      if (!discover || read('remote')) {
        state.value = {
          status: 'error',
          skills: [],
          error: new Error(t('chat.orca.skills.unavailable', 'Skill discovery is unavailable.')),
          errorKind: 'unavailable',
        }
        return
      }
      const key = JSON.stringify([agentId, pane, contextKey])
      const refresh = force
      force = false
      if (!refresh && cache.has(key)) {
        state.value = cache.get(key)
        return
      }
      state.value = { status: 'loading', skills: [], error: null }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            controller.abort()
            reject(new Error(t('chat.orca.skills.timeout', 'Skill discovery timed out.')))
          },
          read('timeoutMs', 18000),
        )
      })
      Promise.race([
        Promise.resolve().then(() =>
          discover({ agent: agentId, pane, refresh, signal: controller.signal }),
        ),
        timeout,
      ])
        .then(
          (result) => {
            if (canceled) return
            const next = {
              status: 'ready',
              skills: (result.skills || []).filter((skill) =>
                isNativeChatSkillForAgent(agentId, skill, result),
              ),
              error: null,
            }
            cache.set(key, next)
            state.value = next
          },
          (error) => {
            if (!canceled)
              state.value = {
                status: 'error',
                skills: [],
                error,
                errorKind: controller.signal.aborted ? 'timeout' : 'unknown',
              }
          },
        )
        .finally(() => clearTimeout(timer))
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(stop)
  return {
    status: computed(() => state.value.status),
    skills: computed(() => state.value.skills),
    error: computed(() => state.value.error),
    errorKind: computed(() => state.value.errorKind),
    retry: () => {
      force = true
      retryGeneration.value++
    },
  }
}
