<script setup>
// Settings > Agents > Terminals: the agents' terminal tools (after VS Code's
// run_in_terminal, src/main/agentTerminal.js): on or off, the rules that let
// commands run without asking (the master switch asks once, as VS Code warns
// before its terminal auto approve), the defaults, and the rules saved from
// the approval card ("always", "in this project"), each removable.
import { computed, inject } from 'vue'
import { t } from '../i18n'
import { settings } from '../settings'
import { isRegexKey } from '../../../shared/terminalRules'

const askConfirm = inject('askConfirm', null)

const logText = computed(() => t('settings.agents.terminalLog', 'Tessel keeps a log of every command agents run in terminals and of the terminals they read (when, which agent, which terminal, the command in full) in agent-terminal.log in its data folder, up to 1 MB (the older part in agent-terminal.log.old). Commands can hold secrets you gave an agent.'))
const regexLabel = computed(() => t('settings.agents.terminalRuleRegex', 'regular expression'))
const userRules = computed(() => Object.entries(settings.agentTerminalRules || {}))
const projectRules = computed(() =>
  Object.entries(settings.agentTerminalWorkspaceRules || {})
    .map(([project, rules]) => ({ project, rules: Object.entries(rules || {}) }))
    .filter((p) => p.rules.length)
)

function ruleValue(v) {
  if (v === true) return t('settings.agents.terminalRuleAllow', 'allowed')
  if (v === false) return t('settings.agents.terminalRuleAsk', 'always asks')
  if (v && typeof v === 'object') return v.approve ? t('settings.agents.terminalRuleAllowLine', 'allowed (whole line)') : t('settings.agents.terminalRuleAskLine', 'always asks (whole line)')
  return String(v)
}
function removeUser(key) {
  const next = { ...settings.agentTerminalRules }
  delete next[key]
  settings.agentTerminalRules = next
}
function removeProject(project, key) {
  const all = { ...settings.agentTerminalWorkspaceRules }
  const rules = { ...(all[project] || {}) }
  delete rules[key]
  if (Object.keys(rules).length) all[project] = rules
  else delete all[project]
  settings.agentTerminalWorkspaceRules = all
}

// Turning the rules on asks once.
async function setAutoApprove(e) {
  const on = !!e.target.checked
  if (!on) {
    settings.agentTerminalAutoApprove = false
    return
  }
  if (!settings.agentTerminalAutoApproveWarned && askConfirm) {
    e.target.checked = false
    const ok = await askConfirm({
      title: t('app.agentTerminal.warnTitle', 'Let rules approve terminal commands?'),
      text: t('app.agentTerminal.warnText', 'Commands your rules allow will run without asking you. The rules are a best-effort protection: they assume the agent is not acting maliciously, and a command can do more than it seems. You can turn this off in Settings > Agents.'),
      confirmLabel: t('app.agentTerminal.warnConfirm', 'Turn on'),
      danger: true
    })
    if (!ok) return
    settings.agentTerminalAutoApproveWarned = true
  }
  settings.agentTerminalAutoApprove = true
}
</script>

<template>
  <div class="set-group" data-test="settings-agent-terminal">
    <h3 class="set-group-title">{{ t('settings.agents.terminals', 'Terminals') }}</h3>
    <div class="set-card">
      <label class="set-row">
        <div class="set-label">
          {{ t('settings.agents.terminal', 'Let agents use terminals') }}
          <span class="set-hint">{{
            t(
              'settings.agents.terminalHint',
              'Agents run shell commands in terminals of their own, next to their pane (on their project\'s SSH host when it is there), and you approve each command. They can read your other terminals, and run a command in one of your shells only after you allow it for that terminal; never in another agent\'s pane. A terminal an agent uses shows a badge with Stop.'
            )
          }}</span>
        </div>
        <input v-model="settings.agentTerminal" type="checkbox" class="set-switch" data-setting="agentTerminal" />
      </label>
      <p class="set-row set-hint" data-test="settings-terminal-log">{{ logText }}</p>
      <label class="set-row">
        <div class="set-label">
          {{ t('settings.agents.terminalYoloNoAsk', 'Agents in Yolo run commands in their own terminal without asking') }}
          <span class="set-hint">{{
            t(
              'settings.agents.terminalYoloNoAskHint',
              'An agent started in Yolo can already run anything with its own shell tool, so its commands in its own terminal (on this computer or its project\'s SSH host) run without the approval card. They are still logged and shown on the terminal\'s badge. Your terminals, other SSH hosts and passwords still ask; Stop still works.'
            )
          }}</span>
        </div>
        <input v-model="settings.agentTerminalYoloNoAsk" type="checkbox" class="set-switch" data-setting="agentTerminalYoloNoAsk" />
      </label>
      <label class="set-row">
        <div class="set-label">
          {{ t('settings.agents.terminalAutoApprove', 'Let rules approve commands') }}
          <span class="set-hint">{{
            t(
              'settings.agents.terminalAutoApproveHint',
              'Commands in an agent\'s own terminal that the rules allow run without asking: read-only commands by default (ls, cat, git status...), and the rules you add from the approval card. Deleting, downloading and evaluating commands always ask. Your own terminals always ask.'
            )
          }}</span>
        </div>
        <input :checked="settings.agentTerminalAutoApprove" type="checkbox" class="set-switch" data-setting="agentTerminalAutoApprove" @change="setAutoApprove" />
      </label>
      <label class="set-row">
        <div class="set-label">
          {{ t('settings.agents.terminalIgnoreDefaults', 'Ignore the default rules') }}
          <span class="set-hint">{{ t('settings.agents.terminalIgnoreDefaultsHint', 'Only your own rules count. The default rules also protect you: deleting, downloading and evaluating commands always ask.') }}</span>
        </div>
        <input v-model="settings.agentTerminalIgnoreDefaultRules" type="checkbox" class="set-switch" data-setting="agentTerminalIgnoreDefaultRules" />
      </label>
      <div v-if="userRules.length" class="set-row yolo-folders" data-test="settings-terminal-rules">
        <div class="set-label">
          {{ t('settings.agents.terminalRules', 'Your rules') }}
          <span class="set-hint">{{ t('settings.agents.terminalRulesHint', 'Saved with "Always allow" on an approval card') }}</span>
        </div>
        <div class="yolo-folder-list">
          <div v-for="[key, value] in userRules" :key="key" class="yolo-folder">
            <code class="yolo-folder-path terminal-rule" :title="key">{{ key }}</code>
            <span class="set-hint">{{ ruleValue(value) }}{{ isRegexKey(key) ? ` · ${regexLabel}` : "" }}</span>
            <button class="exit-btn" @click="removeUser(key)">{{ t('settings.agents.yoloFolderRemove', 'Remove') }}</button>
          </div>
        </div>
      </div>
      <div v-for="p in projectRules" :key="p.project" class="set-row yolo-folders" data-test="settings-terminal-project-rules">
        <div class="set-label">
          {{ t('settings.agents.terminalProjectRules', 'Rules of a project') }}
          <span class="set-hint" :title="p.project">{{ p.project }}</span>
        </div>
        <div class="yolo-folder-list">
          <div v-for="[key, value] in p.rules" :key="key" class="yolo-folder">
            <code class="yolo-folder-path terminal-rule" :title="key">{{ key }}</code>
            <span class="set-hint">{{ ruleValue(value) }}{{ isRegexKey(key) ? ` · ${regexLabel}` : "" }}</span>
            <button class="exit-btn" @click="removeProject(p.project, key)">{{ t('settings.agents.yoloFolderRemove', 'Remove') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-rule {
  direction: ltr;
  font-family: var(--mono, 'Cascadia Mono', Consolas, monospace);
  font-size: 11.5px;
}
</style>
