<script setup>
// Preferences dialog. Edits the shared `settings` store directly, so every
// change applies live to all panes and is saved automatically.
import { ref, onMounted, onUnmounted } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { settings, FONT_FAMILIES, resetSettings, clamp } from '../settings'
import { THEMES } from '../themes'
import { playAlertSound } from '../notificationsStore'
import { parseEnvText, YOLO_ARGS, YOLO_ENV, agentEnabled } from '../../../shared/agentPrefs'
import { AGENT_DOCS } from '../../../shared/agentDocs'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null },
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) },
  // Open scrolled to this section (its element id), e.g. 'quick-commands'.
  section: { type: String, default: null }
})

// Quick commands: text sent to the active pane from the command palette.
const quickDraft = ref({ name: '', text: '', enter: true, error: '' })
function addQuickCommand() {
  const d = quickDraft.value
  const name = d.name.trim()
  const text = d.text.replace(/\s+$/, '')
  if (!name || !text.trim()) {
    d.error = 'Give it a name and the text to send.'
    return
  }
  settings.quickCommands.push({ id: `qc-${Date.now().toString(36)}`, name, text, enter: !!d.enter })
  quickDraft.value = { name: '', text: '', enter: d.enter, error: '' }
}
function removeQuickCommand(id) {
  const i = settings.quickCommands.findIndex((q) => q.id === id)
  if (i >= 0) settings.quickCommands.splice(i, 1)
}
const emit = defineEmits(['close', 'set-default-shell', 'check-updates', 'open-update', 'detect-agents'])

// Settings > Agents: each detected agent's own command, arguments and
// variables, whether it is offered, and the one a new pane starts.
const openAgent = ref(null) // the agent whose "Customize" is open
const envErrors = ref({})
function agentPref(id) {
  return settings.agentPrefs[id] || {}
}
function setAgentPref(id, field, value) {
  const next = { ...agentPref(id), [field]: value }
  if (field === 'env') {
    const r = parseEnvText(value)
    envErrors.value = { ...envErrors.value, [id]: r.error || '' }
  }
  settings.agentPrefs = { ...settings.agentPrefs, [id]: next }
}
function resetAgent(id) {
  const next = { ...settings.agentPrefs }
  const keepOff = next[id] && next[id].enabled === false
  delete next[id]
  if (keepOff) next[id] = { enabled: false }
  settings.agentPrefs = next
  envErrors.value = { ...envErrors.value, [id]: '' }
}
function customized(id) {
  const p = agentPref(id)
  return !!((p.command && p.command.trim()) || (p.args && p.args.trim()) || (p.env && p.env.trim()))
}
const detecting = ref(false)
async function detectAgents() {
  detecting.value = true
  try {
    await new Promise((resolve) => emit('detect-agents', resolve))
  } finally {
    detecting.value = false
  }
}
function openDocs(id) {
  if (AGENT_DOCS[id] && window.shellApi.openExternal) window.shellApi.openExternal(AGENT_DOCS[id])
}

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
let previousFocus
const inertSiblings = []

function focusCard() {
  cardEl.value?.focus({ preventScroll: true })
}

function containFocus(event) {
  if (cardEl.value && !cardEl.value.contains(event.target)) focusCard()
}

function trapTab(event) {
  const card = cardEl.value
  const controls = [
    ...card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')
  ].filter((el) => {
    const style = getComputedStyle(el)
    return (
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      !el.closest('[hidden], [inert]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    )
  })
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || document.activeElement === card) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  previousFocus = document.activeElement
  // Make every branch outside this modal inert, including live xterm inputs.
  // Keep existing inert attributes intact when the dialog closes.
  let branch = cardEl.value?.parentElement
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children || []) {
      if (sibling !== branch && !sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '')
        inertSiblings.push(sibling)
      }
    }
    branch = branch.parentElement
  }
  document.addEventListener('focusin', containFocus)
  focusCard()
  if (props.section) {
    const el = document.getElementById(`set-${props.section}`)
    if (el) el.scrollIntoView({ block: 'start' })
  }
  if (window.shellApi.inputLanguages) {
    try {
      languages.value = (await window.shellApi.inputLanguages()) || []
    } catch {
      languages.value = []
    }
  }
})

onUnmounted(() => {
  document.removeEventListener('focusin', containFocus)
  for (const sibling of inertSiblings) sibling.removeAttribute('inert')
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}

function setScrollback(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.scrollback = clamp(n, 500, 100000)
  e.target.value = settings.scrollback
}

const AWAKE_MODES = [
  { id: 'off', label: 'Off', title: 'Windows sleeps as usual' },
  { id: 'agents', label: 'While agents work', title: 'Only while at least one agent is working' },
  { id: 'on', label: 'Always', title: 'As long as Tessel is open' }
]

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
      aria-modal="true"
      tabindex="-1"
      @keydown.tab.stop="trapTab"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>Settings</span>
        <button
          class="tb-icon"
          aria-label="Close settings"
          title="Close (Esc)"
          @click="emit('close')"
        >
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
          <label class="set-label" for="settings-font">Font</label>
          <select id="settings-font" v-model="settings.fontFamily" class="set-select">
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
          <div id="settings-cursor-label" class="set-label">Cursor</div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-cursor-label">
            <button
              v-for="c in CURSORS"
              :key="c.id"
              class="launch-seg-btn"
              :class="{ on: settings.cursorStyle === c.id }"
              :aria-pressed="settings.cursorStyle === c.id"
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
          <label class="set-label" for="settings-shell">
            Default shell <span class="set-hint">Agents run in it too</span>
          </label>
          <div class="set-shell">
            <BrandIcon :kind="defaultShell || ''" :size="15" />
            <select
              id="settings-shell"
              class="set-select"
              :value="defaultShell"
              @change="emit('set-default-shell', $event.target.value)"
            >
              <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-scrollback">
            Scrollback lines <span class="set-hint">Applies to new panes</span>
          </label>
          <input
            id="settings-scrollback"
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
            Wake idle agents for team messages
            <span class="set-hint"
              >Types a one-line reminder in an idle agent's terminal, never while you are in that pane or typing there
              (nothing else can start an idle agent). Off: messages wait until the agent next works</span
            >
          </div>
          <input v-model="settings.teamWakeUps" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            Reopen my workspaces at launch
            <span class="set-hint">Off starts with a single terminal</span>
          </div>
          <input v-model="settings.restoreWorkspaces" type="checkbox" class="set-switch" />
        </label>
      </section>

      <section id="set-agents" class="set-section">
        <h3>Agents</h3>
        <div class="set-row">
          <label class="set-label" for="settings-default-agent">
            Default agent
            <span class="set-hint">What a new pane starts (Ctrl+Shift+T)</span>
          </label>
          <select id="settings-default-agent" v-model="settings.defaultAgent" class="set-select">
            <option value="">The default shell</option>
            <option
              v-for="a in agents.filter((x) => x.available && agentEnabled(settings.agentPrefs, x.id))"
              :key="a.id"
              :value="a.id"
            >
              {{ a.name }}
            </option>
          </select>
        </div>
        <div class="set-row">
          <div id="settings-perm-label" class="set-label">
            Permissions
            <span class="set-hint">For agents you start from now on</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-perm-label">
            <button
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'manual' }"
              :aria-pressed="settings.agentPermissions === 'manual'"
              @click="settings.agentPermissions = 'manual'"
            >
              Manual
            </button>
            <button
              class="launch-seg-btn"
              :class="{ on: settings.agentPermissions === 'yolo' }"
              :aria-pressed="settings.agentPermissions === 'yolo'"
              @click="settings.agentPermissions = 'yolo'"
            >
              Yolo
            </button>
          </div>
        </div>
        <p v-if="settings.agentPermissions === 'yolo'" class="mcp-error agents-warn">
          Yolo: agents run commands and change files without asking you first (each agent's own
          skip-approvals option, unless you set its arguments yourself). Use it only in projects you
          can restore.
        </p>
        <div class="set-row">
          <div id="settings-awake-label" class="set-label">
            Keep the computer awake
            <span class="set-hint">So it doesn't go to sleep in the middle of an agent's work. The screen can still turn off</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-awake-label">
            <button
              v-for="m in AWAKE_MODES"
              :key="m.id"
              class="launch-seg-btn"
              :class="{ on: settings.keepAwake === m.id }"
              :aria-pressed="settings.keepAwake === m.id"
              :title="m.title"
              @click="settings.keepAwake = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div class="agents-head">
          <span class="set-hint">Detected on this computer</span>
          <button class="exit-btn" type="button" :disabled="detecting" @click="detectAgents">
            {{ detecting ? 'Detecting…' : 'Detect again' }}
          </button>
        </div>
        <div v-for="a in agents" :key="a.id" class="agent-set" :data-agent="a.id">
          <div class="set-row">
            <div class="set-label agent-set-name">
              <BrandIcon :kind="a.id" :size="15" />
              <span>{{ a.name }}</span>
              <span class="set-hint">
                {{ a.available ? 'Installed' : 'Not found' }}{{ customized(a.id) ? ' · customized' : '' }}
              </span>
            </div>
            <div class="agent-set-actions">
              <button v-if="AGENT_DOCS[a.id]" class="exit-btn" type="button" @click="openDocs(a.id)">Docs</button>
              <button
                class="exit-btn"
                type="button"
                :aria-expanded="openAgent === a.id"
                @click="openAgent = openAgent === a.id ? null : a.id"
              >
                Customize
              </button>
              <input
                type="checkbox"
                class="set-switch"
                :aria-label="`Offer ${a.name} in menus`"
                :title="agentEnabled(settings.agentPrefs, a.id) ? 'Shown in menus' : 'Hidden from menus'"
                :checked="agentEnabled(settings.agentPrefs, a.id)"
                @change="setAgentPref(a.id, 'enabled', $event.target.checked)"
              />
            </div>
          </div>
          <div v-if="openAgent === a.id" class="agent-custom">
            <label class="agent-field">
              <span class="set-hint">Command</span>
              <input
                class="set-number mcp-input"
                spellcheck="false"
                :placeholder="a.command"
                :value="agentPref(a.id).command || ''"
                @change="setAgentPref(a.id, 'command', $event.target.value)"
              />
            </label>
            <label class="agent-field">
              <span class="set-hint">Arguments (replace the Yolo option when set)</span>
              <input
                class="set-number mcp-input"
                spellcheck="false"
                :placeholder="YOLO_ARGS[a.id] ? `Yolo adds: ${YOLO_ARGS[a.id]}` : 'e.g. --model …'"
                :value="agentPref(a.id).args || ''"
                @change="setAgentPref(a.id, 'args', $event.target.value)"
              />
            </label>
            <label class="agent-field">
              <span class="set-hint"
                >Variables, one NAME=value per line{{
                  YOLO_ENV[a.id] ? ` (Yolo sets ${Object.keys(YOLO_ENV[a.id]).join(', ')})` : ''
                }}</span
              >
              <textarea
                class="set-number mcp-input agent-env"
                rows="3"
                spellcheck="false"
                :value="agentPref(a.id).env || ''"
                @change="setAgentPref(a.id, 'env', $event.target.value)"
              ></textarea>
            </label>
            <p v-if="envErrors[a.id]" class="mcp-error">{{ envErrors[a.id] }} Not used until fixed.</p>
            <div class="agent-custom-foot">
              <span class="set-hint">Applies to panes you start from now on</span>
              <button class="exit-btn" type="button" :disabled="!customized(a.id)" @click="resetAgent(a.id)">
                Reset
              </button>
            </div>
          </div>
        </div>
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

      <section id="set-quick-commands" class="set-section">
        <h3>Quick commands</h3>
        <p class="set-hint">
          Text you send to the active pane from the command palette (Ctrl+Shift+P, then
          "Run: name"): a command you type often, or a prompt for an agent.
        </p>
        <div v-for="q in settings.quickCommands" :key="q.id" class="set-row quick-row">
          <div class="set-label">
            {{ q.name }}
            <span class="set-hint quick-text">{{ q.text }}{{ q.enter ? ' ⏎' : '' }}</span>
          </div>
          <button class="exit-btn" type="button" @click="removeQuickCommand(q.id)">Remove</button>
        </div>
        <form class="custom-agent-form" @submit.prevent="addQuickCommand">
          <input v-model="quickDraft.name" class="set-number" placeholder="Name, e.g. Run tests" spellcheck="false" />
          <input v-model="quickDraft.text" class="set-number mcp-input" placeholder="Text, e.g. npm test" spellcheck="false" />
          <label class="quick-enter"><input v-model="quickDraft.enter" type="checkbox" /> Press Enter</label>
          <button class="exit-btn primary" type="submit">Add</button>
        </form>
        <p v-if="quickDraft.error" class="mcp-error">{{ quickDraft.error }}</p>
      </section>

      <section class="set-section">
        <h3>Voice typing</h3>
        <div class="set-row">
          <label class="set-label" for="settings-language">
            Language
            <span class="set-hint"
              >Windows dictation listens in one language. The mic button switches to this one first.
              Add languages in Windows Settings, Time &amp; language.</span
            >
          </label>
          <select
            id="settings-language"
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
        <label class="set-row">
          <div class="set-label">
            Sound
            <span class="set-hint">With each new notification (the bell in the toolbar lists them)</span>
          </div>
          <select v-model="settings.alertSound" class="set-select" @change="playAlertSound(settings.alertSound)">
            <option value="none">None</option>
            <option value="chime">Chime</option>
            <option value="ping">Ping</option>
          </select>
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
