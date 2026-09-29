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
import { isAgentSessionRewindRecord } from "./agent-session-rewind.js";
import { isAgentSessionLaunchArgs } from "./agent-session-launch-args.js";
import { isAgentSessionConversationName } from "./agent-session-conversation-name.js";
import { isPersistedAgentSessionHandoffStage, isPersistedAgentSessionRuntimeKind } from "./agent-session-legacy-handoff-lease.js";
import { isAgentSessionConversationCommandRecord } from "./agent-session-conversation-command.js";
import { isAgentSessionProviderHandleChain } from "./agent-session-provider-handle.js";
export const AGENT_SESSION_RECORD_SCHEMA_VERSION = 2;
const MAX_ID_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_LAUNCH_ENV_ENTRIES = 256;
const MAX_LAUNCH_ENV_VALUE_LENGTH = 65_536;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
function isBoundedString(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}
export function isAgentSessionId(value) {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}
const SCOPE_KEY_SEPARATOR = '\u0000';
export function agentSessionScopeKey(location) {
    return [
        location.executionHostId,
        location.wslDistro ?? '',
        location.workspaceId
    ].join(SCOPE_KEY_SEPARATOR);
}
export function agentSessionExecutionLocationsEqual(left, right) {
    return agentSessionScopeKey(left) === agentSessionScopeKey(right) && left.workspaceKind === right.workspaceKind;
}
export function isAgentSessionExecutionLocation(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const location = value;
    return isBoundedString(location.executionHostId, MAX_ID_LENGTH) && (location.wslDistro === null || isBoundedString(location.wslDistro, MAX_ID_LENGTH)) && isBoundedString(location.workspaceId, MAX_ID_LENGTH) && (location.workspaceKind === 'git-worktree' || location.workspaceKind === 'folder');
}
export function isAgentSessionProcessIdentity(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const identity = value;
    return isBoundedString(identity.hostId, MAX_ID_LENGTH) && Number.isSafeInteger(identity.pid) && identity.pid > 0 && (identity.processStartTimeMs === null || Number.isSafeInteger(identity.processStartTimeMs) && identity.processStartTimeMs >= 0) && isBoundedString(identity.spawnToken, MAX_ID_LENGTH);
}
function isAgentSessionAccountHome(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const home = value;
    return (home.variable === 'CLAUDE_CONFIG_DIR' || home.variable === 'CODEX_HOME') && isBoundedString(home.path, MAX_PATH_LENGTH);
}
export function isAgentSessionOptions(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const entries = Object.entries(value);
    return entries.length <= 32 && entries.every(([key, option])=>isBoundedString(key, MAX_ID_LENGTH) && isBoundedString(option, MAX_ID_LENGTH));
}
export function isAgentSessionLaunchEnv(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const entries = Object.entries(value);
    return entries.length <= MAX_LAUNCH_ENV_ENTRIES && entries.every(([key, entry])=>isBoundedString(key, MAX_ID_LENGTH) && typeof entry === 'string' && entry.length <= MAX_LAUNCH_ENV_VALUE_LENGTH);
}
function isAgentSessionJournalCheckpoint(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const checkpoint = value;
    return Number.isSafeInteger(checkpoint.epoch) && checkpoint.epoch >= 0 && Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence >= 0;
}
function isAgentSessionDeathEvidence(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const evidence = value;
    return (evidence.kind === 'exit-observed' || evidence.kind === 'pid-absent' || evidence.kind === 'identity-mismatch') && isBoundedString(evidence.detail, MAX_ID_LENGTH) && Number.isSafeInteger(evidence.observedAt) && evidence.observedAt >= 0;
}
function isPersistedAgentSessionLease(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const lease = value;
    return isAgentSessionId(lease.sessionId) && isPersistedAgentSessionRuntimeKind(lease.runtimeKind) && Number.isSafeInteger(lease.runtimeFence) && lease.runtimeFence >= 0 && (lease.handoffStage === null || isPersistedAgentSessionHandoffStage(lease.handoffStage)) && (lease.provenHandleLinkId === null || isBoundedString(lease.provenHandleLinkId, 128)) && (lease.ownerProcess === null || isAgentSessionProcessIdentity(lease.ownerProcess)) && (lease.reservedSpawnToken === null || isBoundedString(lease.reservedSpawnToken, MAX_ID_LENGTH)) && Number.isSafeInteger(lease.leaseDeadlineAt) && Number.isSafeInteger(lease.lastRenewedAt) && (lease.handoffOperationId === null || isBoundedString(lease.handoffOperationId, MAX_ID_LENGTH)) && (lease.journalCheckpoint === null || isAgentSessionJournalCheckpoint(lease.journalCheckpoint)) && isBoundedString(lease.claimKeyId, MAX_ID_LENGTH) && (lease.claimStatus === 'reserved' || lease.claimStatus === 'live' || lease.claimStatus === 'conflicted' || lease.claimStatus === 'released') && typeof lease.unreconciled === 'boolean' && (lease.deathEvidence === null || isAgentSessionDeathEvidence(lease.deathEvidence));
}
export function isPersistedAgentSessionRecord(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    const fieldsValid = record.schemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION && isAgentSessionId(record.sessionId) && isAgentSessionExecutionLocation(record.location) && (record.provider === 'claude' || record.provider === 'codex') && isAgentSessionProviderHandleChain(record.providerHandleChain) && isAgentSessionAccountHome(record.accountHome) && (record.options === undefined || isAgentSessionOptions(record.options)) && (record.rewind === undefined || isAgentSessionRewindRecord(record.rewind)) && (record.conversationCommand === undefined || isAgentSessionConversationCommandRecord(record.conversationCommand)) && (record.conversationName === undefined || isAgentSessionConversationName(record.conversationName)) && (record.launchArgs === undefined || isAgentSessionLaunchArgs(record.launchArgs)) && !Object.hasOwn(record, 'launchEnv') && isPersistedAgentSessionLease(record.lease) && record.lease.sessionId === record.sessionId && Number.isSafeInteger(record.createdAt) && Number.isSafeInteger(record.updatedAt);
    if (!fieldsValid) {
        return false;
    }
    const validated = record;
    const head = validated.providerHandleChain.at(-1);
    return validated.providerHandleChain.every((link)=>link.handle.provider === validated.provider) && (validated.lease.claimStatus !== 'live' || validated.lease.ownerProcess !== null && head?.linkId === validated.lease.provenHandleLinkId && head.mintedAtFence === validated.lease.runtimeFence);
}
