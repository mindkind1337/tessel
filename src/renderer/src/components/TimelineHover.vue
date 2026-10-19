<script setup>
// A Timeline entry's hover, as VS Code's (its git extension's hover.ts and
// Local History's tooltip, in VS Code Dark 2026's hover colours): for a
// commit, its author (an identicon made here from the email: no network),
// when, the whole message, its numbers, its hash (copy) and its page on
// GitHub. Placed beside the row (on its left when there is no room on its
// right), kept while the pointer is on it.
import { ref, computed, watch, nextTick } from 'vue'
import { t } from '../i18n'
import { fromNow, longDate, identicon, messageBlocks, shortStatParts, repoUrlOf } from '../explorer/timeline'
import Codicon from './Codicon.vue'

const props = defineProps({
  // The entry (explorer/timeline.js timelineEntries) and its row's rectangle.
  entry: { type: Object, required: true },
  anchor: { type: Object, required: true },
  // A commit's numbers and page: { stats, webUrl } once known.
  info: { type: Object, default: null },
  // An uncommitted file's state ("Modified"…).
  statusText: { type: String, default: '' },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['enter', 'leave', 'open', 'copy', 'open-url'])

const commit = computed(() => (props.entry.kind === 'commit' ? props.entry.commit : null))
const avatar = computed(() => (commit.value ? identicon(commit.value.email || commit.value.author) : null))
const ago = computed(() => fromNow(props.entry.time, true, true, props.now))
const date = computed(() => longDate(props.entry.time))
const repoUrl = computed(() => repoUrlOf(props.info && props.info.webUrl))
const blocks = computed(() => (commit.value ? messageBlocks(commit.value.message, repoUrl.value) : []))
const stats = computed(() => (props.info && props.info.stats ? shortStatParts(props.info.stats) : []))
const shortHash = computed(() => (commit.value ? commit.value.id.slice(0, 7) : ''))

// Where it shows: beside the row, vertically on it, inside the window.
const el = ref(null)
const pos = ref({ left: -9999, top: 0, side: 'left' })
function place() {
  const box = el.value
  if (!box) return
  const a = props.anchor
  const w = box.offsetWidth
  const h = box.offsetHeight
  const gap = 8
  const right = a.right + gap + w <= window.innerWidth - 4
  const left = right ? a.right + gap : Math.max(4, a.left - gap - w)
  const top = Math.max(4, Math.min(a.top - 4, window.innerHeight - h - 4))
  pos.value = { left, top, side: right ? 'right' : 'left', pointer: Math.max(8, Math.min(h - 14, a.top + a.height / 2 - top - 3)) }
}
watch(
  () => [props.anchor, props.entry, props.info],
  () => nextTick(place),
  { immediate: true, flush: 'post' }
)
</script>

<template>
  <Teleport to="body">
    <div
      ref="el"
      class="timeline-hover"
      :class="'side-' + pos.side"
      role="tooltip"
      :style="{ left: pos.left + 'px', top: pos.top + 'px' }"
      data-test="timeline-hover"
      @mouseenter="emit('enter')"
      @mouseleave="emit('leave')"
    >
      <span class="timeline-hover-pointer" aria-hidden="true" :style="{ top: (pos.pointer || 10) + 'px' }"></span>
      <div class="timeline-hover-contents">
        <!-- Local History: "$(history) June 15, 2026 at 5:26 PM", then its source. -->
        <template v-if="entry.kind === 'local'">
          <p><Codicon class="timeline-hover-icon" name="history" :size="14" /> {{ date }}</p>
          <p>{{ entry.label }}</p>
        </template>
        <template v-else>
          <p class="timeline-hover-author">
            <svg v-if="avatar" class="timeline-hover-avatar" width="20" height="20" viewBox="-0.5 -0.5 6 6" aria-hidden="true" data-test="timeline-avatar">
              <rect x="-0.5" y="-0.5" width="6" height="6" fill="#f0f0f0" />
              <template v-for="(on, i) in avatar.cells" :key="i">
                <rect v-if="on" :x="i % 5" :y="Math.floor(i / 5)" width="1.02" height="1.02" :fill="avatar.color" />
              </template>
            </svg>
            <Codicon v-else class="timeline-hover-icon" name="account" :size="14" />
            <a v-if="commit && commit.email" class="timeline-hover-link" href="#" :title="'mailto:' + commit.email" @click.prevent="emit('open-url', 'mailto:' + commit.email, $event)"
              ><strong>{{ commit.author }}</strong></a
            ><strong v-else>{{ commit ? commit.author : t('explorer.timeline.you', 'You') }}</strong>,
            <Codicon class="timeline-hover-icon" name="history" :size="14" /> {{ ago }} ({{ date }})
          </p>
          <template v-if="commit">
            <template v-for="(b, i) in blocks" :key="i">
              <p v-if="b.kind === 'p'">
                <template v-for="(p, j) in b.parts" :key="j">
                  <a v-if="p.kind === 'link'" class="timeline-hover-link" href="#" :title="p.href" @click.prevent="emit('open-url', p.href, $event)">{{ p.text }}</a>
                  <code v-else-if="p.kind === 'code'">{{ p.text }}</code>
                  <template v-else>{{ p.text }}</template>
                </template>
              </p>
              <ul v-else>
                <li v-for="(item, k) in b.items" :key="k">
                  <template v-for="(p, j) in item" :key="j">
                    <a v-if="p.kind === 'link'" class="timeline-hover-link" href="#" :title="p.href" @click.prevent="emit('open-url', p.href, $event)">{{ p.text }}</a>
                    <code v-else-if="p.kind === 'code'">{{ p.text }}</code>
                    <template v-else>{{ p.text }}</template>
                  </template>
                </li>
              </ul>
            </template>
            <hr />
            <template v-if="stats.length">
              <p class="timeline-hover-stats" data-test="timeline-hover-stats">
                <template v-for="(s, i) in stats" :key="s.kind"><template v-if="i">, </template><span :class="'stat-' + s.kind">{{ s.text }}</span></template>
              </p>
              <hr />
            </template>
            <p class="timeline-hover-commands">
              <a class="timeline-hover-link" href="#" :title="t('explorer.timeline.openCommit', 'Open Commit')" data-test="timeline-hover-hash" @click.prevent="emit('open')"
                ><Codicon class="timeline-hover-icon" name="git-commit" :size="14" /> {{ shortHash }}</a
              ><a
                class="timeline-hover-link timeline-hover-copy"
                href="#"
                :title="t('explorer.timeline.copyHash', 'Copy Commit Hash')"
                :aria-label="t('explorer.timeline.copyHash', 'Copy Commit Hash')"
                data-test="timeline-hover-copy"
                @click.prevent="emit('copy', commit.id)"
                ><Codicon class="timeline-hover-icon" name="copy" :size="14"
              /></a>
              <template v-if="info && info.webUrl"
                ><span class="timeline-hover-sep" aria-hidden="true">|</span><a class="timeline-hover-link" href="#" :title="t('explorer.timeline.openOnGitHub', 'Open on GitHub')" data-test="timeline-hover-github" @click.prevent="emit('open-url', info.webUrl, $event)"
                  ><Codicon class="timeline-hover-icon" name="github" :size="14" /> {{ t('explorer.timeline.openOnGitHub', 'Open on GitHub') }}</a
                ></template
              >
            </p>
          </template>
          <p v-else-if="statusText">{{ statusText }}</p>
        </template>
      </div>
    </div>
  </Teleport>
</template>
