<script setup>
// Live Share: someone's rights in one chip, for rows and summaries (the
// first invitation, the invitations, the people in now): the preset's name
// or "Custom · 4", every right on in its tooltip, red when they can type
// (liveShareRights.js rightsSummary).
import { computed } from 'vue'
import { rightsSummary } from '../../liveShareRights'

const props = defineProps({
  rights: { type: Object, default: () => ({}) }
})
const s = computed(() => rightsSummary(props.rights))
</script>

<template>
  <span class="tag" :class="s.danger ? 'tag-danger' : 'tag-info'" :title="s.title" data-test="ls-rights-chip">{{ s.text }}</span>
</template>
