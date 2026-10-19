<script setup>
// Live Share: the share's settings (main's, kept across shares, so also
// before you share). Hide what git ignores and what looks like a secret from
// guests (a change counts for every request from now on); find me again
// after a restart through the ntfy.sh relay (on unless turned off); and the
// fact that a share comes back after a restart until you stop it (and,
// while sharing, when its address was last said on the relay); and the
// agents guests may use, for whoever has no rule of its own (null: all).
import { computed, inject } from 'vue'
import LsAgents from './LsAgents.vue'
import { agoText } from '../../liveShareTime'
import { t } from '../../i18n'

const ctx = inject('lsDialog')
const settings = computed(() => (ctx.host.value && ctx.host.value.settings) || {})
const hideIgnored = computed(() => settings.value.hideIgnored !== false)
const rendezvous = computed(() => settings.value.rendezvous !== false)
const agentRule = computed(() => settings.value.agents || null)
// While sharing with the relay on: when the address was last published.
const relayStatus = computed(() => {
  const h = ctx.host.value || {}
  if (h.state !== 'sharing' || !rendezvous.value) return ''
  const ago = agoText(h.relayAt, ctx.now ? ctx.now.value : Date.now())
  return ago ? t('liveShare.setting.relayPublished', 'Your address was last published {{ago}}.', { ago }) : t('liveShare.setting.relayNotYet', 'Your address is not published yet.')
})
function setAgentRule(rule) {
  ctx.run('setting:agents', async () => {
    const r = await ctx.api.setSettings({ agents: rule })
    if (r && r.ok && r.settings) ctx.host.value = { ...ctx.host.value, settings: { ...r.settings } }
    return r
  })
}

// The switch shows main's value until main answers with the new one.
function set(key, event) {
  const box = event && event.target
  const want = box ? !!box.checked : !(key === 'hideIgnored' ? hideIgnored.value : rendezvous.value)
  if (box) box.checked = key === 'hideIgnored' ? hideIgnored.value : rendezvous.value
  ctx.run('setting:' + key, async () => {
    const r = await ctx.api.setSettings({ [key]: want })
    if (r && r.ok && r.settings) ctx.host.value = { ...ctx.host.value, settings: { ...r.settings } }
    return r
  })
}
</script>

<template>
  <section class="lsd-section" data-test="ls-settings" :aria-label="t('liveShare.section.settings', 'Settings')">
    <div class="set-group ls-set-group">
      <h3 class="set-group-title">{{ t('liveShare.settings.guestsTitle', 'What guests see') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <span class="set-label">
            {{ t('liveShare.setting.hideIgnored', 'Hide ignored and secret files from guests') }}
            <span class="set-hint">{{ t('liveShare.setting.hideIgnoredShort', 'Files git ignores and files that look like secrets (.env, keys, credentials).') }}</span>
            <details class="set-more" @click.stop>
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('liveShare.setting.hideIgnoredHint', 'Files git ignores and files that look like secrets (.env, keys, credentials) stay out of guests’ Files, search and Changes. .git and .tessel are always hidden.') }}</p>
            </details>
          </span>
          <input type="checkbox" class="set-switch" :checked="hideIgnored" :disabled="ctx.busy('setting:hideIgnored')" data-test="ls-hide-ignored" @change="set('hideIgnored', $event)" />
        </label>
      </div>
      <div class="set-card set-card-pad ls-set-agents" data-test="ls-agents-setting">
        <LsAgents :rule="agentRule" :inheritable="false" :busy="ctx.busy('setting:agents')" test-key="share" @change="setAgentRule" />
        <p class="set-hint">{{ t('liveShare.setting.agentsHint', 'For every guest, unless you change it for an invitation or a person.') }}</p>
      </div>
    </div>

    <div class="set-group ls-set-group">
      <h3 class="set-group-title">{{ t('liveShare.settings.restartTitle', 'After a restart') }}</h3>
      <div class="set-card">
        <div class="set-row" data-test="ls-setting-permanent">
          <span class="set-label">
            {{ t('liveShare.settings.permanent', 'A share comes back by itself') }}
            <span class="set-hint">{{ t('liveShare.settings.permanentHint', 'Until you stop it, sharing starts again when Tessel restarts, with its invitations and people.') }}</span>
          </span>
          <span class="tag tag-scope">{{ t('liveShare.settings.always', 'Always') }}</span>
        </div>
        <label class="set-row">
          <span class="set-label">
            {{ t('liveShare.setting.rendezvous', 'Find me again after a restart (uses ntfy.sh)') }}
            <span class="set-hint">{{ t('liveShare.setting.rendezvousShort', 'Your new address goes, encrypted, to the free ntfy.sh relay so guests find you.') }}</span>
            <span v-if="relayStatus" class="set-hint ls-relay-status" data-test="ls-relay-status">{{ relayStatus }}</span>
            <details class="set-more" @click.stop>
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('liveShare.setting.rendezvousHint', 'When your address changes, Tessel leaves it, encrypted, on the free ntfy.sh relay so your guests find you (and looks there for a host’s when you are a guest). Off: nothing is sent there, and codes stop working when your address changes.') }}</p>
            </details>
          </span>
          <input type="checkbox" class="set-switch" :checked="rendezvous" :disabled="ctx.busy('setting:rendezvous')" data-test="ls-rendezvous" @change="set('rendezvous', $event)" />
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ls-set-group {
  margin-bottom: 14px;
}
.ls-set-agents {
  margin-top: 8px;
}
.ls-set-agents .set-hint {
  margin: 6px 0 0;
}
.ls-relay-status {
  color: var(--text);
}
.ls-set-group:last-child {
  margin-bottom: 0;
}
</style>
