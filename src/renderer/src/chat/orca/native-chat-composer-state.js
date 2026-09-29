/*
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { filterSlashCommands, isSlashCommandDraft, applySlashSuggestion, slashCommandDispatchText } from "./shared/native-chat-slash-commands.js";
import { buildNativeChatPickerItems, LEADING_SLASH_TRIGGER, MID_PROMPT_SLASH_TRIGGER } from "./native-chat-picker-items.js";
export { filterSlashCommands, isSlashCommandDraft, applySlashSuggestion, slashCommandDispatchText };
export { applyPickerSuggestion, buildNativeChatPickerItems, classifyNativeChatSend } from "./native-chat-picker-items.js";
const EMPTY_DISCOVERY = {
    status: 'ready',
    skills: []
};
export function isSkillPickerTriggered(before, profile) {
    if (!profile) {
        return false;
    }
    return LEADING_SLASH_TRIGGER.test(before) || MID_PROMPT_SLASH_TRIGGER.test(before);
}
export function deriveComposerAutocomplete(draft, caret, agentCommands, skills = [], profile = null, discovery = {
    ...EMPTY_DISCOVERY,
    skills
}, dismissedTriggerKey = null, sessionSkillNames) {
    const before = draft.slice(0, caret);
    const leadingMatch = before.match(LEADING_SLASH_TRIGGER);
    if (leadingMatch) {
        return deriveSlashAutocomplete(leadingMatch[1], 0, agentCommands, profile, discovery, dismissedTriggerKey, sessionSkillNames);
    }
    const mentionMatch = before.match(/(?:^|\s)@(\S*)$/);
    if (mentionMatch) {
        return {
            mode: 'mention',
            query: mentionMatch[1]
        };
    }
    const midPromptMatch = profile ? before.match(MID_PROMPT_SLASH_TRIGGER) : null;
    if (!midPromptMatch) {
        return {
            mode: 'none'
        };
    }
    const query = midPromptMatch[1];
    return deriveSlashAutocomplete(query, before.length - query.length - 1, agentCommands, profile, discovery, dismissedTriggerKey, sessionSkillNames);
}
function deriveSlashAutocomplete(query, triggerPosition, agentCommands, profile, discovery, dismissedTriggerKey, sessionSkillNames) {
    const triggerKey = `/:${triggerPosition}`;
    if (dismissedTriggerKey === triggerKey) {
        return {
            mode: 'none'
        };
    }
    const skillsEnabled = profile !== null;
    const items = buildNativeChatPickerItems(agentCommands, skillsEnabled ? discovery.skills : [], query, profile?.skillPrefix ?? '/', skillsEnabled ? sessionSkillNames : []);
    return {
        mode: 'slash',
        query,
        triggerKey,
        prefix: '/',
        dispatchable: triggerPosition === 0,
        grouped: skillsEnabled,
        commandsEnabled: agentCommands.length > 0,
        skillsEnabled,
        items,
        skillStatus: skillsEnabled ? discovery.status === 'idle' ? 'loading' : discovery.status : 'ready',
        ...skillsEnabled && discovery.errorKind ? {
            skillErrorKind: discovery.errorKind
        } : {}
    };
}
export function editReplacesTriggerToken(previous, next, triggerKey) {
    const triggerPosition = Number.parseInt(triggerKey.slice(triggerKey.indexOf(':') + 1), 10);
    if (!Number.isFinite(triggerPosition) || previous === next) {
        return false;
    }
    let commonPrefix = 0;
    const maxPrefix = Math.min(previous.length, next.length);
    while(commonPrefix < maxPrefix && previous[commonPrefix] === next[commonPrefix]){
        commonPrefix += 1;
    }
    let commonSuffix = 0;
    while(commonSuffix < previous.length - commonPrefix && commonSuffix < next.length - commonPrefix && previous[previous.length - 1 - commonSuffix] === next[next.length - 1 - commonSuffix]){
        commonSuffix += 1;
    }
    const removed = previous.length - commonPrefix - commonSuffix;
    const inserted = next.length - commonPrefix - commonSuffix;
    if (removed === 0 || inserted === 0) {
        return false;
    }
    let tokenEnd = triggerPosition + 1;
    while(tokenEnd < previous.length && !/\s/.test(previous[tokenEnd])){
        tokenEnd += 1;
    }
    return commonPrefix < tokenEnd && previous.length - commonSuffix > triggerPosition;
}
export function applyMentionSuggestion(draft, caret, path) {
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const match = before.match(/(^|\s)@(\S*)$/);
    if (!match) {
        return {
            draft,
            caret
        };
    }
    const tokenStart = before.length - match[2].length - 1;
    const nextBefore = `${before.slice(0, tokenStart)}@${path} `;
    return {
        draft: nextBefore + after,
        caret: nextBefore.length
    };
}
export const EMPTY_HISTORY = {
    entries: [],
    index: null
};
export function pushHistory(history, sent) {
    if (sent.trim() === '' || history.entries.at(-1) === sent) {
        return {
            entries: history.entries,
            index: null
        };
    }
    return {
        entries: [
            ...history.entries,
            sent
        ],
        index: null
    };
}
export function recallPrevious(history) {
    if (history.entries.length === 0) {
        return {
            history,
            draft: null
        };
    }
    const index = history.index === null ? history.entries.length - 1 : Math.max(0, history.index - 1);
    return {
        history: {
            entries: history.entries,
            index
        },
        draft: history.entries[index]
    };
}
export function recallNext(history) {
    if (history.index === null) {
        return {
            history,
            draft: null
        };
    }
    const index = history.index + 1;
    if (index >= history.entries.length) {
        return {
            history: {
                entries: history.entries,
                index: null
            },
            draft: ''
        };
    }
    return {
        history: {
            entries: history.entries,
            index
        },
        draft: history.entries[index]
    };
}
