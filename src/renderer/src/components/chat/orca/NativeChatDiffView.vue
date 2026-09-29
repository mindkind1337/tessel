<script setup>
// After Orca's NativeChatDiffView.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Inline coloured diff, used for Edit/Write tool calls and diff-style tool
 * results. Adds/dels use the git-decoration tokens with a faint tinted ground,
 * matching the terminal's diff palette (no invented colors). Text only.
 * Props: lines ([{ kind: 'add' | 'del' | 'meta' | 'context', text }]).
 */
defineProps({
  lines: { type: Array, required: true }
})

function marker(line) {
  return line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
}
</script>

<template>
  <div class="nc-diff-view">
    <div
      v-for="(line, i) in lines"
      :key="i"
      :class="['nc-diff-view__line', `nc-diff-view__line--${line.kind}`]"
    >{{ marker(line) }}{{ line.text }}</div>
  </div>
</template>

<style scoped>
/* overflow-hidden rounded bg-accent py-1 font-mono text-[11px] leading-relaxed */
.nc-diff-view {
  overflow: hidden;
  border-radius: 4px;
  background: var(--nc-accent);
  padding: 4px 0;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 11px;
  line-height: 1.625;
}
/* whitespace-pre-wrap break-words px-2 */
.nc-diff-view__line {
  padding: 0 8px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
/* bg-emerald-500/10 text-[var(--git-decoration-added)] */
.nc-diff-view__line--add {
  background: color-mix(in oklab, oklch(0.696 0.17 162.48) 10%, transparent);
  color: var(--nc-git-added);
}
/* bg-rose-500/10 text-[var(--git-decoration-deleted)] */
.nc-diff-view__line--del {
  background: color-mix(in oklab, oklch(0.645 0.246 16.439) 10%, transparent);
  color: var(--nc-git-deleted);
}
.nc-diff-view__line--meta {
  color: var(--nc-muted-foreground);
}
.nc-diff-view__line--context {
  color: color-mix(in srgb, var(--nc-foreground) 70%, transparent);
}
</style>
