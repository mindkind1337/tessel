<script setup>
// Preferences dialog. Edits the shared `settings` store directly, so every
// change applies live to all panes and is saved automatically.
import { ref, onMounted } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { settings, FONT_FAMILIES, resetSettings, clamp } from '../settings'
import { THEMES } from '../themes'

defineProps({
  shells: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null },
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) }
})
const emit = defineEmits(['close', 'set-default-shell', 'check-updates', 'open-update'])

function updateText(u) {
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'none':
      return 'You have the latest version.'
    case 'downloading':
      return `Downloading ${u.version}${u.percent ? ` (${u.percent}%)` : ''}…`
    case 'ready':
      return `Version ${u.version} is ready to install.`
    case 'error':
      return 'Could not check for updates. Try again later.'
    case 'disabled':
      return 'Only the installed app updates itself.'
    default:
      return 'Checks automatically every few hours.'
  }
}

const cardEl = ref(null)
const languages = ref([])

onMounted(async () => {
  if (cardEl.value) cardEl.value.focus()
  if (window.shellApi.inputLanguages) {
    try {
      languages.value = (await window.shellApi.inputLanguages()) || []
    } catch {
      languages.value = []
    }
  }
})

function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}

function setScrollback(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.scrollback = clamp(n, 500, 100000)
  e.target.value = settings.scrollback
}

const CURSORS = [
  { id: 'block', label: 'Block' },
  { id: 'bar', label: 'Bar' },
  { id: 'underline', label: 'Underline' }
]
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card settings-card"
      role="dialog"
      aria-label="Settings"
      tabindex="-1"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>Settings</span>
        <button class="tb-icon" title="Close (Esc)" @click="emit('close')">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <section class="set-section">
        <h3>Appearance</h3>
        <div class="set-row">
          <label class="set-label" for="appearance-theme">
            Theme
            <span class="set-hint">Applies immediately. Your sessions keep running.</span>
          </label>
          <select id="appearance-theme" v-model="settings.theme" class="set-select">
            <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
              {{ theme.label }}
            </option>
          </select>
        </div>
      </section>

      <section class="set-section">
        <h3>Text</h3>
        <div class="set-row">
          <div class="set-label">Font</div>
          <select v-model="settings.fontFamily" class="set-select">
            <option v-for="f in FONT_FAMILIES" :key="f" :value="f">{{ f }}</option>
          </select>
        </div>
        <div class="set-row">
          <div class="set-label">
            Size
            <span class="set-hint">Also Ctrl+= and Ctrl+-</span>
          </div>
          <div class="set-stepper">
            <button title="Smaller" @click="stepFont(-1)">−</button>
            <span>{{ settings.fontSize }}</span>
            <button title="Bigger" @click="stepFont(1)">+</button>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">Cursor</div>
          <div class="launch-seg set-seg">
            <button
              v-for="c in CURSORS"
              :key="c.id"
              class="launch-seg-btn"
              :class="{ on: settings.cursorStyle === c.id }"
              @click="settings.cursorStyle = c.id"
            >
              {{ c.label }}
            </button>
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            Use the graphics card to draw terminals
            <span class="set-hint"
              >Faster with busy agents. Turn off if text looks wrong. Applies to new panes</span
            >
          </div>
          <input v-model="settings.gpuRendering" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">Blinking cursor</div>
          <input v-model="settings.cursorBlink" type="checkbox" class="set-switch" />
        </label>
      </section>

      <section class="set-section">
        <h3>Terminal</h3>
        <div class="set-row">
          <div class="set-label">
            Default shell <span class="set-hint">Agents run in it too</span>
          </div>
          <div class="set-shell">
            <BrandIcon :kind="defaultShell || ''" :size="15" />
            <select
              class="set-select"
              :value="defaultShell"
              @change="emit('set-default-shell', $event.target.value)"
            >
              <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
        </div>
        <div class="set-row">
          <div class="set-label">
            Scrollback lines <span class="set-hint">Applies to new panes</span>
          </div>
          <input
            class="set-number"
            type="number"
            min="500"
            max="100000"
            step="500"
            :value="settings.scrollback"
            @change="setScrollback"
          />
        </div>
        <label class="set-row">
          <div class="set-label">Copy text when you select it</div>
          <input v-model="settings.copyOnSelect" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            Right-click pastes
            <span class="set-hint"
              >Pastes the selection, or the clipboard. Shift+right-click opens the menu</span
            >
          </div>
          <input v-model="settings.rightClickPaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            Ask before pasting several lines
            <span class="set-hint">So an accidental paste can't run commands</span>
          </div>
          <input v-model="settings.confirmMultilinePaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            Always select with the mouse
            <span class="set-hint"
              >Even in programs that use the mouse (GitHub Copilot, htop). They no longer get clicks
              or the wheel. Otherwise, hold Shift to select</span
            >
          </div>
          <input v-model="settings.alwaysSelect" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">Ask before closing an agent pane</div>
          <input v-model="settings.confirmCloseAgent" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            Reopen my workspaces at launch
            <span class="set-hint">Off starts with a single terminal</span>
          </div>
          <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
        </label>
      </section>

      <section class="set-section">
        <h3>Agents</h3>
        <label class="set-row">
          <div class="set-label">
            Resume conversations when panes reopen
            <span class="set-hint"
              >Claude Code and Codex continue where they left off after a restart, instead of
              starting a new chat</span
            >
          </div>
          <input v-model="settings.resumeAgents" type="checkbox" class="set-switch" />
        </label>
      </section>

      <section class="set-section">
        <h3>Voice typing</h3>
        <div class="set-row">
          <div class="set-label">
            Language
            <span class="set-hint"
              >Windows dictation listens in one language. The mic button switches to this one first.
              Add languages in Windows Settings, Time &amp; language.</span
            >
          </div>
          <select
            v-model="settings.voiceTip"
            class="set-select"
            @change="settings.voiceTipChosen = true"
          >
            <option value="">Current keyboard language</option>
            <option v-for="l in languages.filter((x) => x.tip)" :key="l.tip" :value="l.tip">
              {{ l.name }}
            </option>
          </select>
        </div>
      </section>

      <section class="set-section">
        <h3>Agent alerts</h3>
        <label class="set-row">
          <div class="set-label">
            Windows notifications
            <span class="set-hint">When an agent finishes while the app is in the background</span>
          </div>
          <input v-model="settings.desktopNotifications" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            In-app alerts
            <span class="set-hint">When an agent finishes in a pane you aren't looking at</span>
          </div>
          <input v-model="settings.inAppAlerts" type="checkbox" class="set-switch" />
        </label>
      </section>

      <section class="set-section">
        <h3>Updates</h3>
        <div class="set-row">
          <div class="set-label">
            Tessel {{ updateStatus.current || '' }}
            <span class="set-hint">{{ updateText(updateStatus) }}</span>
          </div>
          <button
            v-if="updateStatus.state === 'ready'"
            class="exit-btn primary"
            @click="emit('open-update')"
          >
            Restart and update
          </button>
          <button
            v-else
            class="exit-btn"
            :disabled="['disabled', 'checking', 'downloading'].includes(updateStatus.state)"
            @click="emit('check-updates')"
          >
            Check for updates
          </button>
        </div>
      </section>

      <div class="set-foot">
        <span class="set-hint">Changes apply right away and are saved.</span>
        <button class="exit-btn" @click="resetSettings">Reset to defaults</button>
      </div>
    </div>
  </div>
</template>
