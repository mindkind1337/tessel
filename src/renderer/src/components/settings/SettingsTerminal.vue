<script setup>
// Settings > Terminal: shell, font (the old Text page), cursor, drawing, copy
// and paste, mouse and scrolling.
import { computed } from 'vue'
import ThemedSelect from '../ui/ThemedSelect.vue'
import { t, intlLocale } from '../../i18n'
import SettingsToolRows from '../SettingsToolRows.vue'
import { settings, clamp, DEFAULT_SETTINGS, FONT_FAMILIES } from '../../settings'
import { LIGHT_BG_MIN_CONTRAST, DEFAULT_WORD_SEPARATOR } from '../../terminalOptions'
import { PAGES } from './settingsPages'
import { setNumber, setRange } from './settingsFields'
import { useSettingsShell } from './settingsShell'

defineProps({
  shells: { type: Array, default: () => [] },
  defaultShell: { type: String, default: null }
})
const { shown, emit } = useSettingsShell()

function setScrollback(e) {
  const n = parseInt(e.target.value, 10)
  if (Number.isFinite(n)) settings.scrollback = clamp(n, 500, 100000)
  e.target.value = settings.scrollback
}

// Font: size, weights (the CSS names), cursor.
function stepFont(d) {
  settings.fontSize = clamp(settings.fontSize + d, 8, 28)
}
const WEIGHT_NAMES = computed(() => ({
  100: t('settings.text.weightThin', 'Thin'),
  200: t('settings.text.weightExtraLight', 'Extra light'),
  300: t('settings.text.weightLight', 'Light'),
  400: t('settings.text.weightNormal', 'Normal'),
  500: t('settings.text.weightMedium', 'Medium'),
  600: t('settings.text.weightSemibold', 'Semibold'),
  700: t('settings.text.weightBold', 'Bold'),
  800: t('settings.text.weightExtraBold', 'Extra bold'),
  900: t('settings.text.weightBlack', 'Black')
}))
// The nine CSS weights, plus the one saved if it is none of them (a value
// typed before the weights were a list, e.g. 350), so it still shows.
function weightOptions(current) {
  const values = [100, 200, 300, 400, 500, 600, 700, 800, 900]
  if (Number.isFinite(current) && !values.includes(current)) values.push(current)
  return values
    .sort((a, b) => a - b)
    .map((value) => ({
      value,
      label: WEIGHT_NAMES.value[value]
        ? t('settings.text.weightOption', '{{name}} ({{weight}})', { name: WEIGHT_NAMES.value[value], weight: value })
        : String(value)
    }))
}
const CURSORS = computed(() => [
  { id: 'block', label: t('settings.text.cursorBlock', 'Block') },
  { id: 'bar', label: t('settings.text.cursorBar', 'Bar') },
  { id: 'underline', label: t('settings.text.cursorUnderline', 'Underline') }
])
const percent = (v) => new Intl.NumberFormat(intlLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(v)

const GPU_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.gpuAuto', 'Auto') },
  { id: 'on', label: t('settings.common.on', 'On') },
  { id: 'off', label: t('settings.common.off', 'Off') }
])
const gpuHint = computed(() =>
  settings.gpuAcceleration === 'off'
    ? t('settings.terminal.gpuOffHint', 'WebGL disabled; DOM renderer for max compatibility.')
    : settings.gpuAcceleration === 'on'
      ? t('settings.terminal.gpuOnHint', 'WebGL is always attempted for terminal panes.')
      : t('settings.terminal.gpuAutoHint', 'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.')
)

// Color Contrast (Orca's): Automatic (null), Off (1) or a custom ratio.
const CONTRAST_MODES = computed(() => [
  { id: 'auto', label: t('settings.terminal.contrastAuto', 'Automatic') },
  { id: 'off', label: t('settings.common.off', 'Off') },
  { id: 'custom', label: t('settings.terminal.contrastCustom', 'Custom') }
])
const contrastMode = computed(() =>
  settings.minimumContrastRatio === null ? 'auto' : settings.minimumContrastRatio === 1 ? 'off' : 'custom'
)
let lastCustomContrast = LIGHT_BG_MIN_CONTRAST
function setContrastMode(mode) {
  if (contrastMode.value === 'custom') lastCustomContrast = settings.minimumContrastRatio
  settings.minimumContrastRatio = mode === 'auto' ? null : mode === 'off' ? 1 : lastCustomContrast
}
const contrastHint = computed(() =>
  contrastMode.value === 'auto'
    ? t('settings.terminal.contrastAutoHint', 'Balances readability with your terminal theme. Recommended.')
    : contrastMode.value === 'off'
      ? t('settings.terminal.contrastOffHint', 'Keeps program colors unchanged, including dim text and Powerline separators.')
      : t('settings.terminal.contrastCustomHint', 'Choose how much to increase contrast between text and its background.')
)

function resetScrollSpeed() {
  settings.scrollSensitivity = DEFAULT_SETTINGS.scrollSensitivity
  settings.fastScrollSensitivity = DEFAULT_SETTINGS.fastScrollSensitivity
}
</script>

<template>
  <section
    id="set-terminal"
    class="set-page"
    data-page="terminal"
    :hidden="!shown('terminal')"
    aria-labelledby="set-terminal-title"
  >
    <header class="set-page-head">
      <h2 id="set-terminal-title">{{ PAGES.terminal.title }}</h2>
      <p class="set-page-desc">{{ PAGES.terminal.desc }}</p>
    </header>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.shell', 'Shell') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-shell">
            {{ t('settings.terminal.defaultShell', 'Default shell') }} <span class="set-hint">{{ t('settings.terminal.defaultShellHint', 'Agents run in it too') }}</span>
          </label>
          <ThemedSelect
            id="settings-shell"
            class="set-select"
            :value="defaultShell"
            @change="emit('set-default-shell', $event.target.value)"
          >
            <option v-for="s in shells" :key="s.id" :value="s.id">{{ s.name }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-scrollback">
            {{ t('settings.terminal.scrollback', 'Scrollback lines') }} <span class="set-hint">{{ t('settings.terminal.scrollbackHint', 'Applies to new panes') }}</span>
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
      </div>
    </div>
    <!-- The old Text page (Settings > Text opens here: PAGE_ALIASES). -->
    <div id="set-terminal-font" class="set-group" data-group="font">
      <h3 class="set-group-title">{{ t('settings.terminal.font', 'Font') }}</h3>
      <p class="set-group-desc">{{ t('settings.terminal.fontDesc', 'The text of every terminal: typeface, size, weights and line height.') }}</p>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-font">
            {{ t('settings.text.font', 'Font') }}
            <span class="set-hint">{{ t('settings.text.fontHint', 'The typeface of every terminal') }}</span>
          </label>
          <ThemedSelect id="settings-font" v-model="settings.fontFamily" class="set-select">
            <option v-for="f in FONT_FAMILIES" :key="f" :value="f">{{ f }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.text.size', 'Size') }}
            <span class="set-hint">{{ t('settings.text.sizeHint', 'Also Ctrl+= and Ctrl+-') }}</span>
          </div>
          <div class="set-stepper">
            <button type="button" :title="t('settings.text.smaller', 'Smaller')" :aria-label="t('settings.text.smaller', 'Smaller')" @click="stepFont(-1)">−</button>
            <span data-test="font-size">{{ settings.fontSize }}</span>
            <button type="button" :title="t('settings.text.bigger', 'Bigger')" :aria-label="t('settings.text.bigger', 'Bigger')" @click="stepFont(1)">+</button>
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-font-weight">
            {{ t('settings.text.fontWeight', 'Font weight') }}
            <span class="set-hint">{{ t('settings.text.fontWeightHint', 'The weight of normal text.') }}</span>
          </label>
          <ThemedSelect id="settings-font-weight" v-model="settings.fontWeight" class="set-select">
            <option v-for="w in weightOptions(settings.fontWeight)" :key="w.value" :value="w.value">{{ w.label }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <!-- Not a <label>: a click on Learn more must not open the select. -->
          <div class="set-label">
            <label for="settings-font-weight-bold">{{ t('settings.text.boldWeight', 'Bold font weight') }}</label>
            <span class="set-hint">{{ t('settings.text.boldWeightHint', 'The weight of bold text, set apart from the font weight.') }}</span>
            <details class="set-more">
              <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
              <p>{{ t('settings.text.boldWeightMore', 'Some fonts map several weights to one face: if bold looks unchanged, lower the font weight or choose another font.') }}</p>
            </details>
          </div>
          <ThemedSelect id="settings-font-weight-bold" v-model="settings.fontWeightBold" class="set-select">
            <option v-for="w in weightOptions(settings.fontWeightBold)" :key="w.value" :value="w.value">{{ w.label }}</option>
          </ThemedSelect>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-line-height">
            {{ t('settings.text.lineHeight', 'Line height') }}
            <span class="set-hint">{{ t('settings.text.lineHeightHint', 'A multiple of the font size, from 1 to 3.') }}</span>
          </label>
          <input
            id="settings-line-height"
            class="set-number"
            type="number"
            min="1"
            max="3"
            step="0.1"
            :value="settings.lineHeight"
            @change="setNumber('lineHeight', $event)"
          />
        </div>
      </div>
    </div>
    <div class="set-group" data-group="cursor">
      <h3 class="set-group-title">{{ t('settings.text.cursor', 'Cursor') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-cursor-label" class="set-label">{{ t('settings.text.cursorStyle', 'Cursor style') }}</div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-cursor-label">
            <button
              v-for="c in CURSORS"
              :key="c.id"
              type="button"
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
          <div class="set-label">{{ t('settings.text.blink', 'Blinking cursor') }}</div>
          <input v-model="settings.cursorBlink" type="checkbox" class="set-switch" />
        </label>
        <div class="set-row">
          <label class="set-label" for="settings-cursor-opacity">
            {{ t('settings.text.cursorOpacity', 'Cursor opacity') }}
            <span class="set-hint">{{ t('settings.text.cursorOpacityHint', 'Opacity of the terminal cursor.') }}</span>
          </label>
          <div class="set-inline">
            <input
              id="settings-cursor-opacity"
              class="set-range"
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="settings.cursorOpacity"
              @input="setRange('cursorOpacity', $event)"
            />
            <output class="set-range-value" for="settings-cursor-opacity">{{ percent(settings.cursorOpacity) }}</output>
          </div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.rendering', 'Rendering') }}</h3>
      <p class="set-group-desc">{{ t('settings.terminal.renderingDesc', 'How panes draw the terminal: the renderer, its colors and the space around the text.') }}</p>
      <div class="set-card">
        <div class="set-row">
          <div id="settings-gpu-label" class="set-label">
            {{ t('settings.terminal.gpu', 'GPU acceleration') }}
            <span class="set-hint">{{ gpuHint }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-gpu-label">
            <button
              v-for="m in GPU_MODES"
              :key="m.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: settings.gpuAcceleration === m.id }"
              :aria-pressed="settings.gpuAcceleration === m.id"
              @click="settings.gpuAcceleration = m.id"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div class="set-row">
          <div id="settings-contrast-label" class="set-label">
            {{ t('settings.terminal.contrast', 'Color contrast') }}
            <span class="set-hint">{{ contrastHint }}</span>
          </div>
          <div class="launch-seg set-seg" role="group" aria-labelledby="settings-contrast-label">
            <button
              v-for="m in CONTRAST_MODES"
              :key="m.id"
              type="button"
              class="launch-seg-btn"
              :class="{ on: contrastMode === m.id }"
              :aria-pressed="contrastMode === m.id"
              @click="setContrastMode(m.id)"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div v-if="contrastMode === 'custom'" class="set-row set-row-nested">
          <label class="set-label" for="settings-contrast-ratio">
            {{ t('settings.terminal.contrastTarget', 'Contrast target') }}
            <span class="set-hint">{{ t('settings.terminal.contrastTargetHint', 'Higher values increase contrast where possible. Background colors stay unchanged.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="1.1"
              max="21"
              step="0.1"
              :aria-label="t('settings.terminal.contrastTarget', 'Contrast target')"
              :value="settings.minimumContrastRatio"
              @input="setRange('minimumContrastRatio', $event)"
            />
            <input
              id="settings-contrast-ratio"
              class="set-number set-number-short"
              type="number"
              min="1"
              max="21"
              step="0.1"
              :value="settings.minimumContrastRatio"
              @change="setNumber('minimumContrastRatio', $event)"
            />
          </div>
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-pad-x">
            {{ t('settings.appearance.padX', 'Horizontal padding') }}
            <span class="set-hint">{{ t('settings.appearance.padXHint', 'Horizontal padding around the terminal grid in pixels.') }}</span>
          </label>
          <input
            id="settings-pad-x"
            class="set-number"
            type="number"
            min="0"
            max="512"
            step="1"
            :value="settings.terminalPaddingX"
            @change="setNumber('terminalPaddingX', $event, true)"
          />
        </div>
        <div class="set-row">
          <label class="set-label" for="settings-pad-y">
            {{ t('settings.appearance.padY', 'Vertical padding') }}
            <span class="set-hint">{{ t('settings.appearance.padYHint', 'Vertical padding around the terminal grid in pixels.') }}</span>
          </label>
          <input
            id="settings-pad-y"
            class="set-number"
            type="number"
            min="0"
            max="512"
            step="1"
            :value="settings.terminalPaddingY"
            @change="setNumber('terminalPaddingY', $event, true)"
          />
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.copyPaste', 'Copy and paste') }}</h3>
      <div class="set-card">
        <label class="set-row">
          <div class="set-label">{{ t('settings.terminal.copyOnSelect', 'Copy text when you select it') }}</div>
          <input v-model="settings.copyOnSelect" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.rightClickPaste', 'Right-click pastes') }}
            <span class="set-hint">{{ t('settings.terminal.rightClickPasteHint', 'Pastes the selection, or the clipboard. Shift+right-click opens the menu') }}</span>
          </div>
          <input v-model="settings.rightClickPaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.confirmMultiline', 'Ask before pasting several lines') }}
            <span class="set-hint">{{ t('settings.terminal.confirmMultilineHint', 'So an accidental paste can\'t run commands') }}</span>
          </div>
          <input v-model="settings.confirmMultilinePaste" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.alwaysSelect', 'Always select with the mouse') }}
            <span class="set-hint">{{ t('settings.terminal.alwaysSelectHint', 'Even in programs that use the mouse (htop), which then get no clicks. Else hold Shift.') }}</span>
            <span class="set-hint">{{ t('settings.terminal.mouseProgramsHint', 'Programs that use the mouse (tmux, vim, Grok) get plain clicks; their links open with Shift+click or Cmd+click.') }}</span>
          </div>
          <input v-model="settings.alwaysSelect" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.trimGutter', 'Trim gutter on copy') }}
            <span class="set-hint">{{ t('settings.terminal.trimGutterHint', 'Copied agent output loses the indent all its lines share.') }}</span>
          </div>
          <input v-model="settings.copyTrimsGutter" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.osc52', 'Allow TUI clipboard writes (OSC 52)') }}
            <span class="set-hint">{{ t('settings.terminal.osc52Hint', 'Let programs in the terminal (Zellij, tmux, Neovim, fzf, Grok, SSH) copy to your system clipboard.') }}</span>
          </div>
          <input v-model="settings.allowOsc52Clipboard" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.mouse', 'Mouse and scrolling') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.scrollSpeed', 'Scroll speed') }}
            <span class="set-hint">{{ t('settings.terminal.scrollSpeedHint', 'Adjust how wheel input feels in scrollback and in mouse-aware terminal apps.') }}</span>
          </div>
          <button class="exit-btn" type="button" @click="resetScrollSpeed">{{ t('settings.common.reset', 'Reset') }}</button>
        </div>
        <div class="set-row set-row-nested">
          <label class="set-label" for="settings-scroll-normal">
            {{ t('settings.terminal.scrollNormal', 'Normal') }}
            <span class="set-hint">{{ t('settings.terminal.scrollNormalHint', 'Scrollback wheel multiplier.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="0.5"
              max="3"
              step="0.05"
              :aria-label="t('settings.terminal.scrollNormalLabel', 'Normal scroll speed')"
              :value="settings.scrollSensitivity"
              @input="setRange('scrollSensitivity', $event)"
            />
            <input
              id="settings-scroll-normal"
              class="set-number set-number-short"
              type="number"
              min="0.5"
              max="3"
              step="0.05"
              :value="settings.scrollSensitivity"
              @change="setNumber('scrollSensitivity', $event)"
            />
          </div>
        </div>
        <div class="set-row set-row-nested">
          <label class="set-label" for="settings-scroll-fast">
            {{ t('settings.terminal.scrollFast', 'Fast') }}
            <span class="set-hint">{{ t('settings.terminal.scrollFastHint', 'Extra multiplier while scrolling with a modifier key.') }}</span>
          </label>
          <div class="set-inline">
            <input
              class="set-range"
              type="range"
              min="1"
              max="10"
              step="0.5"
              :aria-label="t('settings.terminal.scrollFastLabel', 'Fast scroll speed')"
              :value="settings.fastScrollSensitivity"
              @input="setRange('fastScrollSensitivity', $event)"
            />
            <input
              id="settings-scroll-fast"
              class="set-number set-number-short"
              type="number"
              min="1"
              max="10"
              step="0.5"
              :value="settings.fastScrollSensitivity"
              @change="setNumber('fastScrollSensitivity', $event)"
            />
          </div>
        </div>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.terminal.focusFollowsMouse', 'Focus follows mouse') }}
            <span class="set-hint">{{ t('settings.terminal.focusFollowsMouseHint', 'Hovering a terminal pane activates it without needing to click.') }}</span>
          </div>
          <input v-model="settings.focusFollowsMouse" type="checkbox" class="set-switch" />
        </label>
        <label class="set-row">
          <div class="set-label">
            {{ t('settings.appearance.hideMouse', 'Hide mouse while typing') }}
            <span class="set-hint">{{ t('settings.terminal.hideMouseHint', 'The pointer hides over a terminal while you type in it.') }}</span>
          </div>
          <input v-model="settings.hideMouseWhileTyping" type="checkbox" class="set-switch" />
        </label>
      </div>
    </div>
    <div class="set-group">
      <h3 class="set-group-title">{{ t('settings.terminal.advanced', 'Advanced') }}</h3>
      <div class="set-card">
        <div class="set-row">
          <label class="set-label" for="settings-word-separators">
            {{ t('settings.terminal.wordSeparators', 'Word separators') }}
            <span class="set-hint">{{ t('settings.terminal.wordSeparatorsHint', 'Characters treated as word boundaries for double-click selection.') }}</span>
          </label>
          <input
            id="settings-word-separators"
            class="set-number mcp-input set-mono"
            spellcheck="false"
            :placeholder="DEFAULT_WORD_SEPARATOR"
            :value="settings.wordSeparator"
            @input="settings.wordSeparator = $event.target.value"
          />
        </div>
      </div>
    </div>
    <SettingsToolRows page="terminal" @open="emit('open-tool', $event)" />
  </section>
</template>
