<script setup>
// Lucide 0.577.0: original SVG geometry used by Orca; ISC + Feather MIT.
import {
  BarChart3,
  RefreshCw,
  SlidersHorizontal,
  Share2,
  Sparkles,
  Clock,
  Activity,
  DatabaseZap,
  Coins,
  FolderKanban,
  Bot,
  GitPullRequest,
  CalendarDays,
  Brain,
  Gauge,
  Waypoints
} from 'lucide-vue-next'
defineProps({ kind: { type: String, default: 'chart' } })
const icons = {
  chart: BarChart3,
  refresh: RefreshCw,
  filters: SlidersHorizontal,
  share: Share2,
  tokens: Sparkles,
  clock: Clock,
  activity: Activity,
  cache: DatabaseZap,
  money: Coins,
  folder: FolderKanban,
  agent: Bot,
  pr: GitPullRequest,
  calendar: CalendarDays,
  brain: Brain,
  gauge: Gauge,
  waypoints: Waypoints
}
</script>
<template><component :is="icons[kind] || icons.chart" :size="16" aria-hidden="true" /></template>
