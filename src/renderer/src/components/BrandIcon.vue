<script setup>
// Small brand/shell glyphs, drawn inline so they stay crisp at any size and work
// under the app's strict CSP (no external images). `kind` is an agent id
// (claude / codex / gemini / opencode) or a shell id (powershell / pwsh / cmd / gitbash /
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
  'opencode',
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

// The OpenAI blossom (Codex), as OpenAI draws it.
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

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
    <path v-else-if="k === 'codex' || k === 'openai'" :d="OPENAI_PATH" fill="#ececec" />

    <!-- OpenCode: its block "O" (white frame, grey lower half) on dark -->
    <g v-else-if="k === 'opencode'" transform="scale(0.046875)">
      <rect width="512" height="512" rx="96" fill="#131010" />
      <path d="M320 224V352H192V224H320Z" fill="#5a5858" />
      <path fill-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="#fff" />
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
