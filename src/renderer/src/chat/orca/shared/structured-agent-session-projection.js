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
import { t } from "../../../i18n/index.js";
import { AGENT_STATUS_MAX_FIELD_LENGTH, normalizeOptionalField, normalizePromptField } from "./agent-status-field-normalization.js";
import { AGENT_JOURNAL_MESSAGE_SEND_MODES } from "./agent-session-journal-types.js";
import { isRootAgentJournalItem } from "./agent-session-journal-producer.js";
import { readAgentJournalTurnOutcome } from "./agent-session-turn-record.js";
import { AGENT_STATUS_TOOL_INPUT_MAX_LENGTH, AGENT_STATUS_TOOL_NAME_MAX_LENGTH } from "./agent-status-types.js";
import { describeToolInput } from "./native-chat-tool-summary.js";
import { activeStructuredAgentSessionTurnId, newestStructuredAgentSessionTurn, statusStructuredAgentSessionToolCall } from "./structured-agent-session-live-turn.js";
import { isStructuredAgentSessionToolAction, structuredAgentSessionToolCallBlock } from "./structured-agent-session-tool-call-block.js";
import { sha256 } from "./sha256.js";
import { structuredAgentSessionStatusStartedAt } from "./structured-agent-session-status-started-at.js";
import { isUnansweredStructuredAgentSessionDispatch } from "./structured-agent-session-unanswered-dispatch.js";
export { activeStructuredAgentSessionTurnId, newestStructuredAgentSessionTurn } from "./structured-agent-session-live-turn.js";
function boundedText(payload) {
    return payload.truncated ? t("chat.orca.copy.head_bytes_bytes", "{{head}}\n… ({{bytes}} bytes)", { head: payload.head, bytes: payload.byteLength }) : payload.head;
}
const BOUNDED_TEXT_MARKERS = [
    /\n… \(\d+ bytes\)$/,
    /\n\[Orca: output truncated — \d+ bytes total, digest [0-9a-f]+\]$/
];
export function stripBoundedTextMarker(text) {
    const stripped = BOUNDED_TEXT_MARKERS.reduce((value, marker)=>value.replace(marker, ''), text);
    return {
        text: stripped,
        truncated: stripped.length !== text.length
    };
}
function itemBlocks(item) {
    const body = item.body;
    if (body.kind === 'message') {
        return {
            role: body.role,
            blocks: body.blocks
        };
    }
    if (isStructuredAgentSessionToolAction(body)) {
        const call = structuredAgentSessionToolCallBlock(body);
        if (body.kind === 'diff') {
            return {
                role: 'assistant',
                blocks: [
                    call,
                    {
                        type: 'tool-result',
                        output: boundedText(body.patch)
                    }
                ]
            };
        }
        return {
            role: 'assistant',
            blocks: [
                call,
                ...body.output ? [
                    {
                        type: 'tool-result',
                        output: boundedText(body.output),
                        isError: body.state === 'failed'
                    }
                ] : []
            ]
        };
    }
    if (body.kind === 'approval') {
        if (body.resolution.state === 'pending') {
            return null;
        }
        return {
            role: 'system',
            blocks: [
                {
                    type: 'text',
                    text: `${body.title}\n${body.detail ?? ''}\n${body.resolution.state}`.trim()
                }
            ]
        };
    }
    if (body.kind === 'question') {
        if (body.resolution.state === 'pending') {
            return null;
        }
        const choices = body.options.map((option)=>option.label).join(' · ');
        return {
            role: 'system',
            blocks: [
                {
                    type: 'text',
                    text: `${body.question}\n${choices}`.trim()
                }
            ]
        };
    }
    if (body.kind !== 'status' || body.turnLifecycle) {
        return null;
    }
    return {
        role: 'system',
        blocks: [
            {
                type: 'text',
                text: body.text,
                ...body.presentation !== undefined ? {
                    presentation: body.presentation
                } : {},
                ...body.tone !== undefined ? {
                    tone: body.tone
                } : {},
                ...body.providerFrame ? {
                    providerFrame: body.providerFrame
                } : {}
            }
        ]
    };
}
function isAgentJournalMessageSendMode(value) {
    return AGENT_JOURNAL_MESSAGE_SEND_MODES.some((mode)=>mode === value);
}
const projectedItems = new WeakMap();
export function projectStructuredItemsToNativeChat(items) {
    const messages = [];
    items.forEach((item)=>{
        const projected = projectStructuredItemToNativeChat(item);
        if (projected) {
            messages.push(projected);
        }
    });
    return messages;
}
export function projectStructuredItemToNativeChat(item) {
    const cached = projectedItems.get(item);
    if (cached !== undefined) {
        return cached;
    }
    const projected = itemBlocks(item);
    const sentAs = item.body.kind === 'message' ? item.body.sentAs : undefined;
    const message = projected ? {
        id: item.itemId,
        role: projected.role,
        blocks: projected.blocks,
        timestamp: item.observedAt,
        source: 'transcript',
        ...sentAs !== undefined && isAgentJournalMessageSendMode(sentAs) ? {
            sentAs
        } : {},
        // Tessel's addition: a teammate's message keeps its label and sender.
        ...sentAs === 'team' ? {
            sentAs,
            ...typeof item.body.from === 'string' ? { from: item.body.from } : {}
        } : {}
    } : null;
    projectedItems.set(item, message);
    return message;
}
export function hasPersistedStructuredAgentSessionTurn(items) {
    return items.some((item)=>item.body.kind === 'message' && (item.body.role === 'user' || item.body.role === 'assistant'));
}
export function hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence) {
    return submissions.some((submission)=>isUnansweredStructuredAgentSessionDispatch(submission, currentFence));
}
export function structuredAgentSessionTabId(sessionId) {
    return `structured-agent-session-${sessionId}`; // i18n-ignore
}
export function projectStructuredAgentSessionStatus(items, submissions = [], currentFence) {
    if (items.some((item)=>(item.body.kind === 'approval' || item.body.kind === 'question') && item.body.resolution.state === 'pending')) {
        return 'attention';
    }
    return activeStructuredAgentSessionTurnId(items) || hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence) ? 'working' : 'idle';
}
function messageProse(blocks) {
    return blocks.flatMap((block)=>block.type === 'text' ? [
            block.text
        ] : []).join('\n');
}
export function latestStructuredAgentSessionPrompt(items) {
    const body = latestStructuredAgentSessionUserItem(items)?.body;
    return body?.kind === 'message' ? messageProse(body.blocks) : '';
}
export function latestStructuredAgentSessionUserItem(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        if (item?.body.kind === 'message' && item.body.role === 'user' && isRootAgentJournalItem(item)) {
            return item;
        }
    }
    return null;
}
export function latestStructuredAgentSessionAssistantMessage(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        const body = item?.body;
        if (!isRootAgentJournalItem(item)) {
            continue;
        }
        if (body?.kind === 'message' && body.role === 'user') {
            return '';
        }
        if (body?.kind === 'message' && body.role === 'assistant') {
            const prose = messageProse(body.blocks);
            if (prose.trim()) {
                return prose;
            }
        }
    }
    return '';
}
export function projectStructuredAgentSessionStatusSummary(items, submissions = [], currentFence) {
    if (!hasPersistedStructuredAgentSessionTurn(items) && !hasUnansweredStructuredAgentSessionDispatch(submissions, currentFence)) {
        return {
            status: null,
            latestPrompt: ''
        };
    }
    const status = projectStructuredAgentSessionStatus(items, submissions, currentFence);
    const statusToolCall = status === 'working' ? statusStructuredAgentSessionToolCall(items) : null;
    const toolName = statusToolCall ? normalizeOptionalField(statusToolCall.name, AGENT_STATUS_TOOL_NAME_MAX_LENGTH) : undefined;
    const toolInput = statusToolCall ? normalizeOptionalField(describeToolInput(statusToolCall.input), AGENT_STATUS_TOOL_INPUT_MAX_LENGTH) : undefined;
    const lastAssistantMessage = normalizeOptionalField(latestStructuredAgentSessionAssistantMessage(items), AGENT_STATUS_MAX_FIELD_LENGTH);
    const turnOutcome = status === 'idle' ? readAgentJournalTurnOutcome(newestStructuredAgentSessionTurn(items)) : null;
    const statusStartedAt = structuredAgentSessionStatusStartedAt(status, items, submissions, currentFence);
    return {
        status,
        latestPrompt: normalizePromptField(latestStructuredAgentSessionPrompt(items)),
        ...toolName ? {
            toolName
        } : {},
        ...toolInput ? {
            toolInput
        } : {},
        ...lastAssistantMessage ? {
            lastAssistantMessage
        } : {},
        ...turnOutcome ? {
            turnOutcome
        } : {},
        ...statusStartedAt !== undefined ? {
            statusStartedAt
        } : {}
    };
}
export function structuredAgentSessionPaneKey(tabId, sessionId) {
    const bytes = sha256(new TextEncoder().encode(sessionId));
    const hex = Array.from(bytes.slice(0, 16), (byte)=>byte.toString(16).padStart(2, '0')).join('');
    const leaf = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return `${tabId}:${leaf}`;
}
