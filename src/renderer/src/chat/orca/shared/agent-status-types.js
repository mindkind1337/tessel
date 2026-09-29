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
import { isAgentJournalTurnOutcome } from "./agent-turn-outcome.js";
import { normalizeInteractivePromptField, normalizeOptionalField, normalizeOptionalMultilineField, normalizePromptField, normalizeTurnCompletedAtField } from "./agent-status-field-normalization.js";
import { assertJsonTextStructureWithinLimits } from "./json-text-structure-limit.js";
export { AGENT_STATUS_MAX_FIELD_LENGTH } from "./agent-status-field-normalization.js";
export { mainAgentStatusEqual } from "./main-agent-status.js";
export { AGENT_STATE_HISTORY_MAX } from "./agent-state-history.js";
export const AGENT_STATUS_STATES = [
    'working',
    'blocked',
    'waiting',
    'done'
];
export function pickParsedAgentStatusPayload(row) {
    return {
        state: row.state,
        ...row.workingMode !== undefined ? {
            workingMode: row.workingMode
        } : {},
        prompt: row.prompt,
        ...row.agentType !== undefined ? {
            agentType: row.agentType
        } : {},
        ...row.model !== undefined ? {
            model: row.model
        } : {},
        ...row.modelSwitchCommand ? {
            modelSwitchCommand: row.modelSwitchCommand
        } : {},
        ...row.toolName !== undefined ? {
            toolName: row.toolName
        } : {},
        ...row.toolInput !== undefined ? {
            toolInput: row.toolInput
        } : {},
        ...row.interactivePrompt !== undefined ? {
            interactivePrompt: row.interactivePrompt
        } : {},
        ...row.lastAssistantMessage !== undefined ? {
            lastAssistantMessage: row.lastAssistantMessage
        } : {},
        ...row.lastAssistantMessageIsToolOutput !== undefined ? {
            lastAssistantMessageIsToolOutput: row.lastAssistantMessageIsToolOutput
        } : {},
        ...row.interrupted !== undefined ? {
            interrupted: row.interrupted
        } : {},
        ...row.sessionBoundary !== undefined ? {
            sessionBoundary: row.sessionBoundary
        } : {},
        ...row.turnCompletedAt !== undefined ? {
            turnCompletedAt: row.turnCompletedAt
        } : {},
        ...row.subagents !== undefined ? {
            subagents: row.subagents
        } : {},
        ...row.mainAgent !== undefined ? {
            mainAgent: row.mainAgent
        } : {}
    };
}
export const AGENT_STATUS_TOOL_NAME_MAX_LENGTH = 60;
export const AGENT_STATUS_TOOL_INPUT_MAX_LENGTH = 160;
export const AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH = 8000;
export const AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH = 16000;
export { AGENT_STATUS_STALE_AFTER_MS, agentStatusAuthorityObservedAt, agentStatusEvidenceObservedAt, isFreshNonDoneAgentStatus } from "./agent-status-freshness.js";
const VALID_STATES = new Set(AGENT_STATUS_STATES);
export function isAgentStatusState(value) {
    return typeof value === 'string' && VALID_STATES.has(value);
}
export const AGENT_TYPE_MAX_LENGTH = 40;
export const AGENT_MODEL_MAX_LENGTH = 120;
export const AGENT_STATUS_MAX_SUBAGENTS = 32;
export const AGENT_STATUS_JSON_STRUCTURE_LIMITS = {
    structuralTokens: 4096,
    nestingDepth: 16
};
const AGENT_SUBAGENT_ID_MAX_LENGTH = 64;
function normalizeSubagentSnapshot(value) {
    if (typeof value !== 'object' || value === null) {
        return null;
    }
    const obj = value;
    if (typeof obj.id !== 'string') {
        return null;
    }
    const id = obj.id.trim();
    if (id.length === 0 || id.length > AGENT_SUBAGENT_ID_MAX_LENGTH) {
        return null;
    }
    if (obj.state !== 'working' && obj.state !== 'blocked' && obj.state !== 'waiting' && obj.state !== 'idle' && obj.state !== 'unverifiable') {
        return null;
    }
    return {
        id,
        state: obj.state,
        startedAt: typeof obj.startedAt === 'number' && Number.isFinite(obj.startedAt) ? obj.startedAt : 0,
        agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
        model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
        description: normalizeOptionalField(obj.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
    };
}
function normalizeSubagentsField(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    const normalized = [];
    for (const item of value){
        const snapshot = normalizeSubagentSnapshot(item);
        if (snapshot) {
            normalized.push(snapshot);
            if (normalized.length >= AGENT_STATUS_MAX_SUBAGENTS) {
                break;
            }
        }
    }
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeMainAgentStatusField(value) {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const obj = value;
    const state = obj.state;
    if (!isAgentStatusState(state)) {
        return undefined;
    }
    if (typeof obj.stateStartedAt !== 'number' || !Number.isFinite(obj.stateStartedAt)) {
        return undefined;
    }
    return {
        state,
        ...state === 'done' && isAgentJournalTurnOutcome(obj.outcome) ? {
            outcome: obj.outcome
        } : {},
        stateStartedAt: obj.stateStartedAt
    };
}
export function agentSubagentsEqual(a, b) {
    if (a === b) {
        return true;
    }
    if (!a || !b || a.length !== b.length) {
        return !a && !b;
    }
    for(let i = 0; i < a.length; i++){
        const x = a[i];
        const y = b[i];
        if (x.id !== y.id || x.state !== y.state || x.startedAt !== y.startedAt || x.agentType !== y.agentType || x.model !== y.model || x.description !== y.description) {
            return false;
        }
    }
    return true;
}
function normalizeAgentStatusObject(parsed) {
    if (typeof parsed !== 'object' || parsed === null) {
        return null;
    }
    const obj = parsed;
    if (typeof obj.state !== 'string') {
        return null;
    }
    const state = obj.state;
    if (!VALID_STATES.has(state)) {
        return null;
    }
    return {
        state: state,
        workingMode: state === 'working' && obj.workingMode === 'monitoring' ? 'monitoring' : undefined,
        prompt: normalizePromptField(obj.prompt),
        agentType: normalizeOptionalField(obj.agentType, AGENT_TYPE_MAX_LENGTH),
        model: normalizeOptionalField(obj.model, AGENT_MODEL_MAX_LENGTH),
        ...obj.modelSwitchCommand === 'orca-model' ? {
            modelSwitchCommand: 'orca-model'
        } : {},
        toolName: normalizeOptionalField(obj.toolName, AGENT_STATUS_TOOL_NAME_MAX_LENGTH),
        toolInput: normalizeOptionalField(obj.toolInput, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH),
        interactivePrompt: normalizeInteractivePromptField(obj.interactivePrompt, AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH),
        lastAssistantMessage: normalizeOptionalMultilineField(obj.lastAssistantMessage, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH),
        lastAssistantMessageIsToolOutput: obj.lastAssistantMessageIsToolOutput === true ? true : undefined,
        interrupted: obj.interrupted === true && state === 'done' ? true : undefined,
        sessionBoundary: obj.sessionBoundary === true && state === 'done' ? true : undefined,
        turnCompletedAt: normalizeTurnCompletedAtField(obj.turnCompletedAt, state),
        subagents: normalizeSubagentsField(obj.subagents),
        mainAgent: normalizeMainAgentStatusField(obj.mainAgent)
    };
}
export function normalizeAgentStatusPayload(payload) {
    return normalizeAgentStatusObject(payload);
}
export function parseAgentStatusPayload(json) {
    try {
        assertJsonTextStructureWithinLimits(json, AGENT_STATUS_JSON_STRUCTURE_LIMITS);
        return normalizeAgentStatusObject(JSON.parse(json));
    } catch  {
        return null;
    }
}
