<script setup>
// Small brand/shell glyphs, drawn inline so they stay crisp at any size and work
// under the app's strict CSP (no external images). `kind` is an agent id
// (claude / codex / gemini) or a shell id (powershell / pwsh / cmd / gitbash /
// wsl). Anything unknown falls back to a generic terminal glyph.
import { computed } from 'vue'

const props = defineProps({
  kind: { type: String, default: '' },
  size: { type: Number, default: 16 },
  // For kinds without a drawn logo: a colored badge with the label's initial.
  accent: { type: String, default: null },
  label: { type: String, default: null }
})

const KNOWN = new Set([
  'claude',
  'codex',
  'openai',
  'gemini',
  'powershell',
  'pwsh',
  'cmd',
  'gitbash',
  'bash',
  'git',
  'wsl'
])
const initial = computed(() => ((props.label || props.kind || '?').trim()[0] || '?').toUpperCase())
// Dark text on light badge colors, light text on dark ones.
const badgeText = computed(() => {
  const hex = (props.accent || '#8a93a6').replace('#', '')
  const n = parseInt(
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex,
    16
  )
  const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114
  return lum > 150 ? '#14161b' : '#ffffff'
})

const gid = `bi-grad-${Math.random().toString(36).slice(2, 9)}`

// Claude's spark: uneven rays radiating from the centre.
const claudeRays = computed(() => {
  const lens = [1, 0.74, 0.92, 0.68, 0.98, 0.8, 0.94, 0.7, 1, 0.76, 0.9, 0.72]
  return lens.map((l, i) => {
    const a = ((i * 30 - 90 + 8) * Math.PI) / 180
    const r0 = 2.2
    const r1 = 2.2 + l * 8.6
    return {
      x1: 12 + Math.cos(a) * r0,
      y1: 12 + Math.sin(a) * r0,
      x2: 12 + Math.cos(a) * r1,
      y2: 12 + Math.sin(a) * r1
    }
  })
})

const k = computed(() => (props.kind || '').toLowerCase())
</script>

<template>
  <svg
    class="brand-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <!-- Claude -->
    <g v-if="k === 'claude'" stroke="#d97757" stroke-width="2.3" stroke-linecap="round">
      <line v-for="(r, i) in claudeRays" :key="i" :x1="r.x1" :y1="r.y1" :x2="r.x2" :y2="r.y2" />
    </g>

    <!-- Codex / OpenAI blossom -->
    <g v-else-if="k === 'codex' || k === 'openai'" stroke="#ececec" stroke-width="1.7">
      <rect
        v-for="i in 6"
        :key="i"
        x="-3.3"
        y="-10.2"
        width="6.6"
        height="11.4"
        rx="3.3"
        :transform="`translate(12 12) rotate(${i * 60})`"
      />
    </g>

    <!-- Gemini sparkle -->
    <template v-else-if="k === 'gemini'">
      <defs>
        <linearGradient :id="gid" x1="3" y1="21" x2="21" y2="3" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#4285f4" />
          <stop offset="0.55" stop-color="#9b72cb" />
          <stop offset="1" stop-color="#d96570" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.5C12 7.3 16.7 12 22.5 12 16.7 12 12 16.7 12 22.5 12 16.7 7.3 12 1.5 12 7.3 12 12 7.3 12 1.5Z"
        :fill="`url(#${gid})`"
      />
    </template>

    <!-- Windows PowerShell / PowerShell 7 -->
    <template v-else-if="k === 'powershell' || k === 'pwsh'">
      <path
        d="M6 4h16l-4 16H2Z"
        :fill="k === 'pwsh' ? '#34507a' : '#2671be'"
        :stroke="k === 'pwsh' ? '#34507a' : '#2671be'"
        stroke-width="2"
        stroke-linejoin="round"
      />
      <path
        d="M7 8l5 4-6.5 4.5"
        stroke="#fff"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M12 16.5h4.5" stroke="#fff" stroke-width="1.9" stroke-linecap="round" />
    </template>

    <!-- Command Prompt -->
    <template v-else-if="k === 'cmd'">
      <rect
        x="2"
        y="3.5"
        width="20"
        height="17"
        rx="2.5"
        fill="#0c0c0c"
        stroke="#5a5a5a"
        stroke-width="1.2"
      />
      <path
        d="M6 9.5l3.2 2.5L6 14.5"
        stroke="#e6e6e6"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M11 15h6" stroke="#e6e6e6" stroke-width="1.7" stroke-linecap="round" />
    </template>

    <!-- Git / Git Bash -->
    <template v-else-if="k === 'gitbash' || k === 'bash' || k === 'git'">
      <rect
        x="4.2"
        y="4.2"
        width="15.6"
        height="15.6"
        rx="2.6"
        transform="rotate(45 12 12)"
        fill="#f05032"
      />
      <path d="M9.3 7.6l5 5M12 10.3v6" stroke="#fff" stroke-width="1.5" stroke-linecap="round" />
      <circle cx="12" cy="10.3" r="1.5" fill="#fff" />
      <circle cx="14.6" cy="12.9" r="1.5" fill="#fff" />
      <circle cx="12" cy="16.3" r="1.5" fill="#fff" />
    </template>

    <!-- WSL -->
    <template v-else-if="k === 'wsl'">
      <rect x="2" y="3.5" width="20" height="17" rx="3" fill="#e95420" />
      <path
        d="M6.5 9.5l3.2 2.5-3.2 2.5"
        stroke="#fff"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M11.5 15h6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" />
    </template>

    <!-- Letter badge for agents/tools without a drawn logo -->
    <template v-else-if="!KNOWN.has(k) && (accent || label)">
      <rect x="2" y="2" width="20" height="20" rx="5.5" :fill="accent || '#8a93a6'" />
      <text
        x="12"
        y="16.4"
        text-anchor="middle"
        font-size="12.5"
        font-weight="700"
        font-family="Segoe UI, system-ui, sans-serif"
        :fill="badgeText"
      >
        {{ initial }}
      </text>
    </template>

    <!-- Fallback terminal glyph -->
    <template v-else>
      <rect x="2" y="3.5" width="20" height="17" rx="3" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M6.5 9.5l3.2 2.5-3.2 2.5M11.5 15h6"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </template>
  </svg>
</template>
