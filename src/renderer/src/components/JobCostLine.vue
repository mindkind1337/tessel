<script setup>
// One muted line with what a job used: "12.4k tokens · 6 min · ~$0.31"
// (compact: "12.4k · ~$0.31"), the details in its tooltip (jobCost.js).
// Nothing when there is no usage.
import { computed } from 'vue'
import { hasUsage, jobCostLine, jobCostDetails } from '../jobCost'
import { currentLocale } from '../i18n'

const props = defineProps({
  entry: { type: Object, default: null },
  compact: { type: Boolean, default: false },
  // Off where the surrounding card already shows the details.
  tooltip: { type: Boolean, default: true }
})

// currentLocale() read here so a language change redraws the line.
const text = computed(() => (currentLocale(), jobCostLine(props.entry, { compact: props.compact })))
const details = computed(() => (props.tooltip ? (currentLocale(), jobCostDetails(props.entry)) : null))
</script>

<template>
  <span v-if="hasUsage(entry) && text" class="job-cost" :class="{ compact }" data-test="job-cost" :title="details || undefined">{{ text }}</span>
</template>

