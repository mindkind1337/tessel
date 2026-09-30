<script setup>
// The complete pane menu: one structure and order for terminal and chat headers.
import { ref } from 'vue'
import PaneContextMenu from './PaneContextMenu.vue'
import BrandIcon from './BrandIcon.vue'
import { t } from '../i18n'
const props = defineProps(["ctxMenu","paneTitle","closeCtxMenuAndRefocus","node","team","teamFactTitle","isLead","isAgent","yoloTitle","statusTitle","exited","asksApproval","limit","limitState","agentStatus","estimatedState","needsYou","stuck","track","cache","cacheTitle","cacheLeft","unsent","launchStale","menuResolveUnsent","applyTitle","menuRestartApply","menuCopy","menuPaste","menuCopyOutput","menuClear","menuCopySession","menuFind","hasModelChoice","modelTitle","menuModel","modelText","sessionPillLabel","paneModelList","paneValues","ctx","menuVoice","settings","menuPickVoice","otherPanes","menuSendSelection","menuAskReview","closeCtxMenu","leadToggleText","leaveTeamText","startEditTitle","isMaximized","menuOpenHere","menuSplit","menuRestart","canViewTranscript","menuViewTranscript","transcriptOpen","canOpenAsChat","menuOpenAsChat","canSwitchYolo","menuSwitchYolo","yoloFolder","yoloFolderOn","menuYoloFolder","folderName","menuClose","isChat","disabledReasons"])
const unavailable = name => props.disabledReasons?.[name] || ''
const menuRef = ref(null)
defineExpose({ focus: options => menuRef.value?.focus(options), contains: target => menuRef.value?.contains(target), getBoundingClientRect: () => menuRef.value.getBoundingClientRect() })
</script>
<template>
    <PaneContextMenu
      v-if="ctxMenu.visible"
      ref="menuRef"
      :title="paneTitle"
      @close="closeCtxMenuAndRefocus"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      tabindex="-1"
      @mousedown.stop
      @keydown.escape.prevent.stop="closeCtxMenuAndRefocus"
    >
      <div class="ctx-menu-header">
        <span class="ctx-menu-title">{{ paneTitle }}</span>
        <span class="ctx-menu-subtitle">{{ node.shellName }}</span>
      </div>
      <!-- What the pane header does not show (Orca keeps its header to the
           title): where it works, its team, how it was started, its states. -->
      <div class="ctx-menu-facts" data-test="pane-menu-facts">
        <div v-if="node.worktree" class="ctx-menu-fact" data-test="pane-branch" :title="t('pane.fact.branchHint', 'Separate copy on branch {{branch}}\n{{path}}', { branch: node.worktree.branch, path: node.worktree.path })">
          <span class="ctx-fact-label">{{ t('pane.fact.branch', 'Branch') }}</span><span class="ctx-fact-value">{{ node.worktree.branch }}</span>
        </div>
        <div v-if="team" class="ctx-menu-fact" data-test="pane-team" :title="teamFactTitle()">
          <span class="ctx-fact-label">{{ t('pane.fact.team', 'Team') }}</span><span class="ctx-fact-value pane-team-name">{{ team.name }}{{ isLead ? ' · ' + t('pane.fact.lead', 'lead') : '' }}</span>
        </div>
        <div v-if="isAgent && node.launchYolo" class="ctx-menu-fact" data-test="pane-yolo" :title="yoloTitle()">
          <span class="ctx-fact-label">{{ t('pane.fact.started', 'Started') }}</span><span class="ctx-fact-value pane-yolo">Yolo</span>
        </div>
        <div v-if="isAgent" class="ctx-menu-fact" data-test="pane-state" :title="statusTitle">
          <span class="ctx-fact-label">{{ t('pane.fact.state', 'State') }}</span>
          <span class="ctx-fact-value">
            <template v-if="node.sleeping">{{ t('pane.badge.asleep', 'asleep') }}</template>
            <template v-else-if="exited">{{ t('pane.badge.exited', 'exited') }}</template>
            <template v-else-if="asksApproval">{{ t('pane.state.asksApproval', 'asks you to approve') }}</template>
            <template v-else-if="limit">{{ limitState() }}</template>
            <template v-else-if="agentStatus === 'busy'">{{ estimatedState ? t('pane.state.workingEstimated', 'working (estimated)') : t('pane.badge.working', 'working') }}</template>
            <template v-else-if="agentStatus === 'unknown'">{{ t('pane.badge.unknown', 'unknown') }}</template>
            <template v-else-if="needsYou">{{ t('pane.state.doneNeedsYou', 'done, needs you') }}</template>
            <template v-else>{{ t('pane.state.idle', 'idle') }}</template>
          </span>
        </div>
        <div v-if="stuck" class="ctx-menu-fact" data-test="pane-stuck" :title="track.reason">
          <span class="ctx-fact-label">{{ t('pane.fact.quiet', 'Quiet') }}</span><span class="ctx-fact-value pane-stuck-text" :class="track.level">{{ track.minutes }} min</span>
        </div>
        <div v-if="cache" class="ctx-menu-fact" data-test="pane-cache-fact" :title="cacheTitle">
          <span class="ctx-fact-label">{{ t('pane.fact.cache', 'Prompt cache') }}</span><span class="ctx-fact-value">{{ cacheLeft() }}</span>
        </div>
      </div>
      <template v-if="unsent || launchStale">
        <button v-if="unsent" class="ctx-menu-item" data-test="menu-unsent" :title="t('pane.menu.unsentHint', 'A message was pasted but not seen taken')" @click="menuResolveUnsent">
          {{ t('pane.menu.unsent', 'Message not confirmed…') }}
        </button>
        <button v-if="launchStale" class="ctx-menu-item" data-test="menu-restart-apply" :title="applyTitle()" @click="menuRestartApply">
          {{ t('pane.menu.restartApply', 'Restart to apply settings') }}
        </button>
      </template>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" :disabled="!ctxMenu.hasSelection" @click="menuCopy">
        {{ t('pane.menu.copy', 'Copy') }}
      </button>
      <button class="ctx-menu-item" @click="menuPaste">{{ t('pane.menu.paste', 'Paste') }}</button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" :disabled="!!unavailable('menuCopyOutput')" :title="unavailable('menuCopyOutput')" @click="menuCopyOutput">{{ t('pane.menu.copyOutput', 'Copy output') }}</button>
      <button class="ctx-menu-item" :disabled="!!unavailable('menuClear')" :title="unavailable('menuClear')" @click="menuClear">{{ t('pane.menu.clear', 'Clear') }}</button>
      <button v-if="node.sessionId" class="ctx-menu-item" @click="menuCopySession">
        {{ t('pane.menu.copySession', 'Copy session ID') }}<span class="ctx-menu-shortcut">{{ node.sessionId.slice(0, 8) }}</span>
      </button>
      <button class="ctx-menu-item" :disabled="!!unavailable('menuFind')" :title="unavailable('menuFind')" @click="menuFind">
        {{ t('pane.menu.find', 'Find') }}<span class="ctx-menu-shortcut">Ctrl+Shift+F</span>
      </button>
      <button
        v-if="hasModelChoice"
        class="ctx-menu-item"
        data-test="pane-model"
        :disabled="!!unavailable('menuModel')"
        :title="unavailable('menuModel') || modelTitle || t('pane.menu.modelHint', 'Choose the model this agent uses')"
        @click="menuModel"
      >
        {{ t('pane.menu.model', 'Model…') }}<span class="ctx-menu-shortcut ctx-menu-model" :class="{ manual: node.sessionOptions }">{{ modelText || sessionPillLabel(paneModelList, paneValues) }}</span>
      </button>
      <div v-else-if="isAgent && modelText" class="ctx-menu-fact" data-test="pane-model-fact" :title="modelTitle">
        <span class="ctx-fact-label">{{ t('pane.sessionOptions.model', 'Model') }}</span><span class="ctx-fact-value">{{ modelText }}</span>
      </div>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" data-test="menu-voice" :title="t('pane.voice.menuHint', 'Speak instead of typing ({{language}}). Windows voice typing', { language: ctx.voiceName.value })" @click="menuVoice">
        {{ t('pane.voice.menu', 'Voice typing') }}<span class="ctx-menu-shortcut">{{ ctx.voiceLabel.value || 'Win+H' }}</span>
      </button>
      <div v-if="ctx.voiceLanguages.value.length" class="ctx-menu-chips" data-test="pane-voice-langs">
        <span class="ctx-chips-label">{{ t('pane.voice.speakIn', 'Speak in') }}</span>
        <button
          v-for="l in ctx.voiceLanguages.value"
          :key="l.tip"
          class="ctx-chip"
          :class="{ selected: settings.voiceTip === l.tip }"
          :title="t('pane.voice.speakInLanguage', 'Speak in {{language}}', { language: l.name })"
          @click="menuPickVoice(l.tip)"
        >
          {{ l.tag.slice(0, 2).toUpperCase() }}
        </button>
        <button class="ctx-chip" :class="{ selected: !settings.voiceTip }" :title="t('pane.voice.keyboard', 'Current keyboard language')" @click="menuPickVoice('')">⌨</button>
      </div>
      <div class="ctx-menu-sep"></div>
      <template v-if="otherPanes.length">
        <div class="ctx-menu-label">{{ t('pane.menu.sendSelection', 'Send selection to') }}</div>
        <button
          v-for="p in otherPanes"
          :key="'sel-' + p.id"
          class="ctx-menu-item pane-pick"
          :disabled="!ctxMenu.hasSelection"
          @mouseenter="ctx.highlightId.value = p.id"
          @mouseleave="ctx.highlightId.value = null"
          @click="menuSendSelection(p.id)"
        >
          <span class="ctx-with-icon">

            <BrandIcon :kind="p.kind" :accent="p.accent" :label="p.title" :size="13" />
            <span class="pick-title">{{ p.paneName || p.title }}</span>
          </span>
          <span class="ctx-menu-shortcut">{{ p.branch || p.where }}</span>
        </button>
        <template v-if="otherPanes.some((p) => p.agent)">
          <div class="ctx-menu-label">{{ t('pane.menu.askReview', "Ask to review this pane's changes") }}</div>
          <button
            v-for="p in otherPanes.filter((p) => p.agent)"
            :key="'rev-' + p.id"
            class="ctx-menu-item pane-pick"
            @mouseenter="ctx.highlightId.value = p.id"
            @mouseleave="ctx.highlightId.value = null"
            @click="menuAskReview(p.id)"
          >
            <span class="ctx-with-icon">

              <BrandIcon :kind="p.kind" :accent="p.accent" :label="p.title" :size="13" />
              <span class="pick-title">{{ p.paneName || p.title }}</span>
            </span>
            <span class="ctx-menu-shortcut">{{ p.branch || p.where }}</span>
          </button>
        </template>
        <div class="ctx-menu-sep"></div>
      </template>
      <template v-if="team">
        <button
          v-if="isAgent && ctx.setTeamLead"
          class="ctx-menu-item"
          @click="(closeCtxMenu(), ctx.setTeamLead(team.id, isLead ? null : node.id))"
        >
          {{ leadToggleText() }}
        </button>
        <button class="ctx-menu-item" @click="(closeCtxMenu(), ctx.leaveTeam(node.id))">
          {{ leaveTeamText() }}
        </button>
        <div class="ctx-menu-sep"></div>
      </template>
      <button class="ctx-menu-item" @click="(closeCtxMenu(), startEditTitle($event))">{{ t('pane.menu.rename', 'Rename') }}</button>
      <button class="ctx-menu-item" @click="(closeCtxMenu(), ctx.toggleMaximize(node.id))">{{ isMaximized ? t('pane.restore', 'Restore pane') : t('pane.maximize', 'Maximize pane') }}</button>
      <button class="ctx-menu-item" @click="menuOpenHere">{{ t('pane.menu.openHere', 'Open terminal or agent here…') }}</button>
      <button class="ctx-menu-item" @click="menuSplit('row')">
        {{ t('pane.menu.splitRight', 'Split right') }}<span class="ctx-menu-shortcut">▥</span>
      </button>
      <button class="ctx-menu-item" @click="menuSplit('col')">
        {{ t('pane.menu.splitDown', 'Split down') }}<span class="ctx-menu-shortcut">▤</span>
      </button>
      <div class="ctx-menu-sep"></div>
      <button class="ctx-menu-item" @click="menuRestart">
        {{ t('pane.restart', 'Restart') }}<span class="ctx-menu-shortcut">Ctrl+Shift+R</span>
      </button>
      <button
        v-if="canViewTranscript"
        class="ctx-menu-item"
        data-test="menu-view-transcript"
        :title="t('pane.menu.viewTranscriptHint', 'Show this conversation as a chat, read-only (typing stays in the terminal)')"
        @click="menuViewTranscript"
      >
        {{ transcriptOpen ? t('pane.menu.hideTranscript', 'Back to the terminal') : t('pane.menu.viewTranscript', 'See the conversation') }}
      </button>
      <button
        v-if="canOpenAsChat"
        class="ctx-menu-item"
        data-test="menu-open-as-chat"
        :disabled="!!unavailable('menuOpenAsChat')"
        :title="unavailable('menuOpenAsChat') || (isChat ? t('chat.orca.contextMenu.switchToTerminal', 'Continue in a terminal') : t('pane.menu.openAsChatHint', 'Continue this conversation in a chat pane (no terminal): same pane, same permissions or fewer'))"
        @click="menuOpenAsChat"
      >
        {{ isChat ? t('chat.orca.contextMenu.switchToTerminal', 'Continue in a terminal') : t('pane.menu.openAsChat', 'Open as chat') }}
      </button>
      <template v-if="canSwitchYolo">
        <button
          class="ctx-menu-item"
          data-test="menu-switch-yolo"
          :disabled="!!unavailable('menuSwitchYolo')"
          :title="unavailable('menuSwitchYolo') || (
            node.launchYolo
              ? t('pane.menu.restartManualHint', 'Restart this agent so it asks you before acting again: same pane, its conversation resumed')
              : t('pane.menu.restartYoloHint', 'Restart this agent without permission prompts: it runs commands and changes files without asking you. Same pane, its conversation resumed')
          )"
          @click="menuSwitchYolo"
        >
          {{ node.launchYolo ? t('pane.menu.restartManual', 'Restart asking first') : t('pane.menu.restartYolo', 'Restart in Yolo') }}
        </button>
        <button
          v-if="yoloFolder"
          class="ctx-menu-item"
          data-test="menu-yolo-folder"
          :aria-pressed="yoloFolderOn"
          :title="t('pane.menu.yoloFolderHint', 'Agents started in {{folder}} (or a folder inside it) always start in Yolo. Agents already running there keep their mode.', { folder: yoloFolder })"
          @click="menuYoloFolder"
        >
          {{ t('pane.menu.yoloFolder', 'Yolo in this folder') }}<span class="ctx-menu-shortcut">{{ yoloFolderOn ? '✓ ' : '' }}{{ folderName(yoloFolder) }}</span>
        </button>
      </template>
      <button class="ctx-menu-item danger" @click="menuClose">{{ t('pane.close', 'Close pane') }}</button>
    </PaneContextMenu>
</template>
