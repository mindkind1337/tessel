<script setup>
// Settings > Agents > Permissions > Terminals: the agents' terminal tools (after VS Code's
// run_in_terminal, src/main/agentTerminal.js): on or off, the rules that let
// commands run without asking (the master switch asks once, as VS Code warns
// before its terminal auto approve), the defaults, and the rules saved from
// the approval card ("always", "in this project"), each removable.
import { computed, inject } from 'vue'
import { t } from '../i18n'
import { settings } from '../settings'
import { isRegexKey } from '../../../shared/terminalRules'
import ThemedSelect from './ui/ThemedSelect.vue'

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
  <div class="set-group agent-terminal-settings" data-test="settings-agent-terminal">
    <h3 class="set-group-title">{{ t('settings.agents.terminals', 'Terminals') }}</h3>
    <div class="set-card">
      <div class="set-row">
        <div class="set-label">
          <label for="settings-agent-terminal">{{ t('settings.agents.terminal', 'Let agents use terminals') }}</label>
          <span class="set-hint">{{ t('settings.agents.terminalShort', 'Terminals of their own next to their pane; you approve each command') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{
              t(
                'settings.agents.terminalHint',
                'Agents run shell commands in terminals of their own, next to their pane (on their project\'s SSH host when it is there), and you approve each command. They can read your other terminals, and run a command in one of your shells only after you allow it for that terminal; never in another agent\'s pane. A terminal an agent uses shows a badge with Stop.'
              )
            }}</p>
            <p data-test="settings-terminal-log">{{ logText }}</p>
          </details>
        </div>
        <input id="settings-agent-terminal" v-model="settings.agentTerminal" type="checkbox" class="set-switch" data-setting="agentTerminal" />
      </div>
      <div class="set-row">
        <div class="set-label">
          <label for="settings-agent-terminal-yolo">{{ t('settings.agents.terminalYoloNoAsk', 'Agents in Yolo run commands in their own terminal without asking') }}</label>
          <span class="set-hint">{{ t('settings.agents.terminalYoloNoAskShort', 'Still logged and shown on the terminal\'s badge; your own terminals still ask') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{
              t(
                'settings.agents.terminalYoloNoAskHint',
                'An agent started in Yolo can already run anything with its own shell tool, so its commands in its own terminal (on this computer or its project\'s SSH host) run without the approval card. They are still logged and shown on the terminal\'s badge. Your terminals, other SSH hosts and passwords still ask; Stop still works.'
              )
            }}</p>
          </details>
        </div>
        <input id="settings-agent-terminal-yolo" v-model="settings.agentTerminalYoloNoAsk" type="checkbox" class="set-switch" data-setting="agentTerminalYoloNoAsk" />
      </div>
      <div class="set-row" data-test="settings-agent-relay">
        <div class="set-label">
          <label for="settings-agent-relay">{{ t('settings.agents.relay', 'Messages between projects') }}</label>
          <span class="set-hint">{{ t('settings.agents.relayShort', 'Agents can write to agents of other projects, on this computer or on SSH hosts; Tessel relays the messages. Needs terminals allowed for agents, and wake-ups on so that they are told') }}</span>
        </div>
        <input id="settings-agent-relay" v-model="settings.agentRelay" type="checkbox" class="set-switch" data-setting="agentRelay" />
      </div>
      <div v-if="settings.agentRelay !== false" class="set-row" data-test="settings-agent-relay-ask">
        <div class="set-label">
          <label for="settings-agent-relay-ask">{{ t('settings.agents.relayAsk', 'Ask before two agents write to each other') }}</label>
          <span class="set-hint">{{ t('settings.agents.relayAskShort', 'Asked once for each pair of agents, until Tessel restarts. Off: any agent can write to any other, including agents on servers to agents on this computer') }}</span>
        </div>
        <input id="settings-agent-relay-ask" v-model="settings.agentRelayAsk" type="checkbox" class="set-switch" data-setting="agentRelayAsk" />
      </div>
      <div v-if="settings.agentRelay !== false" class="set-row" data-test="settings-agent-relay-max">
        <div class="set-label">
          <label for="settings-agent-relay-max">{{ t('settings.agents.relayMax', 'Messages an hour between two agents') }}</label>
          <span class="set-hint">{{ t('settings.agents.relayMaxShort', 'Past it they are refused: two agents answering each other would spend your quota') }}</span>
        </div>
        <ThemedSelect id="settings-agent-relay-max" v-model.number="settings.agentRelayMax" class="set-select" data-setting="agentRelayMax">
          <option :value="10">10</option>
          <option :value="30">30</option>
          <option :value="100">100</option>
        </ThemedSelect>
      </div>
      <div class="set-row" data-test="settings-terminal-background">
        <div class="set-label">
          <label for="settings-agent-terminal-background">{{ t('settings.agents.terminalBackground', 'Background commands') }}</label>
          <span class="set-hint">{{ t('settings.agents.terminalBackgroundShort', 'Where a command an agent leaves running (a dev server) goes') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{
              t(
                'settings.agents.terminalBackgroundHint',
                'One terminal per agent: an agent runs all its commands in its terminal. While a command it left running (a dev server) holds it, its next command opens one more terminal, which closes once its command ends. A terminal each: each command left running gets a terminal of its own, which closes once the command ends. A terminal you click into, type in, resize or move stays open.'
              )
            }}</p>
          </details>
        </div>
        <ThemedSelect id="settings-agent-terminal-background" v-model="settings.agentTerminalBackground" class="set-select" data-setting="agentTerminalBackground">
          <option value="one">{{ t('settings.agents.terminalBackgroundOne', 'One terminal per agent') }}</option>
          <option value="each">{{ t('settings.agents.terminalBackgroundEach', 'A terminal each') }}</option>
        </ThemedSelect>
      </div>
      <div class="set-row">
        <div class="set-label">
          <label for="settings-agent-terminal-rules">{{ t('settings.agents.terminalAutoApprove', 'Let rules approve commands') }}</label>
          <span class="set-hint">{{ t('settings.agents.terminalAutoApproveShort', 'Commands the rules allow run in an agent\'s own terminal without asking') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{
              t(
                'settings.agents.terminalAutoApproveHint',
                'Commands in an agent\'s own terminal that the rules allow run without asking: read-only commands by default (ls, cat, git status...), and the rules you add from the approval card. Deleting, downloading and evaluating commands always ask. Your own terminals always ask.'
              )
            }}</p>
          </details>
        </div>
        <input id="settings-agent-terminal-rules" :checked="settings.agentTerminalAutoApprove" type="checkbox" class="set-switch" data-setting="agentTerminalAutoApprove" @change="setAutoApprove" />
      </div>
      <div class="set-row">
        <div class="set-label">
          <label for="settings-agent-terminal-defaults">{{ t('settings.agents.terminalIgnoreDefaults', 'Ignore the default rules') }}</label>
          <span class="set-hint">{{ t('settings.agents.terminalIgnoreDefaultsShort', 'Only your own rules count') }}</span>
          <details class="set-more">
            <summary>{{ t('settings.common.learnMore', 'Learn more') }}</summary>
            <p>{{ t('settings.agents.terminalIgnoreDefaultsHint', 'Only your own rules count. The default rules also protect you: deleting, downloading and evaluating commands always ask.') }}</p>
          </details>
        </div>
        <input id="settings-agent-terminal-defaults" v-model="settings.agentTerminalIgnoreDefaultRules" type="checkbox" class="set-switch" data-setting="agentTerminalIgnoreDefaultRules" />
      </div>
      <div v-if="userRules.length" class="set-row terminal-rules" data-test="settings-terminal-rules">
        <div class="set-label">
          {{ t('settings.agents.terminalRules', 'Your rules') }}
          <span class="set-hint">{{ t('settings.agents.terminalRulesHint', 'Saved with "Always allow" on an approval card') }}</span>
          <ul class="terminal-rule-list">
            <li v-for="[key, value] in userRules" :key="key">
              <code class="sl-path terminal-rule" :title="key">{{ key }}</code>
              <span class="set-hint">{{ ruleValue(value) }}{{ isRegexKey(key) ? ` · ${regexLabel}` : "" }}</span>
              <button type="button" class="exit-btn small" @click="removeUser(key)">{{ t('settings.agents.yoloFolderRemove', 'Remove') }}</button>
            </li>
          </ul>
        </div>
      </div>
      <div v-for="p in projectRules" :key="p.project" class="set-row terminal-rules" data-test="settings-terminal-project-rules">
        <div class="set-label">
          {{ t('settings.agents.terminalProjectRules', 'Rules of a project') }}
          <span class="sl-path" :title="p.project">{{ p.project }}</span>
          <ul class="terminal-rule-list">
            <li v-for="[key, value] in p.rules" :key="key">
              <code class="sl-path terminal-rule" :title="key">{{ key }}</code>
              <span class="set-hint">{{ ruleValue(value) }}{{ isRegexKey(key) ? ` · ${regexLabel}` : "" }}</span>
              <button type="button" class="exit-btn small" @click="removeProject(p.project, key)">{{ t('settings.agents.yoloFolderRemove', 'Remove') }}</button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-rule-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.terminal-rule-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.terminal-rule {
  flex: 0 1 auto;
  direction: ltr;
  font-size: 11px;
}
.terminal-rule-list .exit-btn {
  margin-left: auto;
}
.set-more > p {
  max-width: 62ch;
}
.set-row:has(> .set-label > .set-more[open]) {
  align-items: flex-start;
}
</style>
