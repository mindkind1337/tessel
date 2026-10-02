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
export const RESUMABLE_TUI_AGENTS = [
    'claude',
    'codex',
    'qoder',
    'gemini',
    'antigravity',
    'opencode',
    'opencode2',
    'pi',
    'mimo-code',
    'droid',
    'grok',
    'devin',
    'omp',
    'prime-agent',
    'copilot',
    'kimi',
    'muse',
    'zcode',
    'dsh'
];
const RESUMABLE_TUI_AGENT_SET = new Set(RESUMABLE_TUI_AGENTS);
const PROVIDER_SESSION_ID_MAX_LENGTH = 512;
export function hasUnsafeProviderSessionIdChars(value) {
    for(let i = 0; i < value.length; i += 1){
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f) {
            return true;
        }
    }
    return false;
}
function normalizeSessionId(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > PROVIDER_SESSION_ID_MAX_LENGTH || trimmed.startsWith('-') || hasUnsafeProviderSessionIdChars(trimmed)) {
        return null;
    }
    return trimmed;
}
function readSessionId(record, keys) {
    for (const key of keys){
        const normalized = normalizeSessionId(record[key]);
        if (normalized) {
            return normalized;
        }
    }
    return null;
}
function readTranscriptPathFromKeys(record, keys) {
    for (const key of keys){
        const raw = record[key];
        if (typeof raw !== 'string') {
            continue;
        }
        const trimmed = raw.trim();
        if (trimmed && !hasUnsafeProviderSessionIdChars(trimmed)) {
            return trimmed;
        }
    }
    return undefined;
}
function withTranscriptPath(metadata, payload, keys = [
    'transcript_path',
    'transcriptPath'
]) {
    const transcriptPath = readTranscriptPathFromKeys(payload, keys);
    return transcriptPath ? {
        ...metadata,
        transcriptPath
    } : metadata;
}
export function isResumableTuiAgent(value) {
    return typeof value === 'string' && RESUMABLE_TUI_AGENT_SET.has(value);
}
export function normalizeAgentProviderSession(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }
    const record = raw;
    const key = record.key;
    if (key !== 'session_id' && key !== 'conversation_id') {
        return null;
    }
    const id = normalizeSessionId(record.id);
    if (!id) {
        return null;
    }
    const transcriptPath = readTranscriptPathFromKeys(record, [
        'transcriptPath'
    ]);
    return transcriptPath ? {
        key,
        id,
        transcriptPath
    } : {
        key,
        id
    };
}
export function agentProviderSessionsEqual(agent, left, right) {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    return left.key === right.key && left.id === right.id && (agent !== 'pi' && agent !== 'prime-agent' || left.transcriptPath === right.transcriptPath);
}
export function extractAgentProviderSession(source, payload) {
    switch(source){
        case 'qoder':
        case 'claude':
        case 'codex':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                return id ? withTranscriptPath({
                    key: 'session_id',
                    id
                }, payload) : null;
            }
        case 'gemini':
        case 'droid':
        case 'kimi':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'muse':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                return id ? withTranscriptPath({
                    key: 'session_id',
                    id
                }, payload) : null;
            }
        case 'zcode':
        // DeepSeek Harness's hook bridge sends an empty transcript_path: the id alone.
        case 'dsh':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'antigravity':
            {
                const id = readSessionId(payload, [
                    'conversationId'
                ]);
                return id ? {
                    key: 'conversation_id',
                    id
                } : null;
            }
        case 'opencode':
        case 'opencode2':
        case 'mimo-code':
            {
                const id = readSessionId(payload, [
                    'sessionID'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'pi':
        case 'prime-agent':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                const providerSession = id ? withTranscriptPath({
                    key: 'session_id',
                    id
                }, payload, [
                    'session_file'
                ]) : null;
                return providerSession?.transcriptPath ? providerSession : null;
            }
        case 'grok':
            {
                const id = readSessionId(payload, [
                    'sessionId',
                    'session_id'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'devin':
            {
                const id = readSessionId(payload, [
                    'session_id',
                    'sessionId'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'omp':
            {
                const id = readSessionId(payload, [
                    'session_id'
                ]);
                return id ? withTranscriptPath({
                    key: 'session_id',
                    id
                }, payload, [
                    'session_file'
                ]) : null;
            }
        case 'copilot':
            {
                const id = readSessionId(payload, [
                    'session_id',
                    'sessionId'
                ]);
                return id ? {
                    key: 'session_id',
                    id
                } : null;
            }
        case 'amp':
        case 'cursor':
        case 'command-code':
        case 'hermes':
            return null;
    }
}
export function getAgentResumeArgv(agent, providerSession, ompResumeFilePath) {
    const id = providerSession.id;
    switch(agent){
        case 'claude':
            return providerSession.key === 'session_id' ? [
                'claude',
                '--resume',
                id
            ] : null;
        case 'codex':
            return providerSession.key === 'session_id' ? [
                'codex',
                'resume',
                id
            ] : null;
        case 'qoder':
            return providerSession.key === 'session_id' ? [
                'qodercli',
                '--resume',
                id
            ] : null;
        case 'gemini':
            return providerSession.key === 'session_id' ? [
                'gemini',
                '--resume',
                id
            ] : null;
        case 'antigravity':
            return providerSession.key === 'conversation_id' ? [
                'agy',
                '--conversation',
                id
            ] : null;
        case 'opencode':
            return providerSession.key === 'session_id' ? [
                'opencode',
                '--session',
                id
            ] : null;
        case 'opencode2':
            return providerSession.key === 'session_id' ? [
                'opencode2',
                '--standalone',
                '--session',
                id
            ] : null;
        case 'pi':
            return providerSession.key === 'session_id' && providerSession.transcriptPath ? [
                'pi',
                '--session',
                providerSession.transcriptPath
            ] : null;
        case 'prime-agent':
            return providerSession.key === 'session_id' && providerSession.transcriptPath ? [
                'prime-agent',
                '--resume',
                providerSession.transcriptPath
            ] : null;
        case 'mimo-code':
            return providerSession.key === 'session_id' ? [
                'mimo',
                '--session',
                id
            ] : null;
        case 'droid':
            return providerSession.key === 'session_id' ? [
                'droid',
                '--resume',
                id
            ] : null;
        case 'grok':
            return providerSession.key === 'session_id' ? [
                'grok',
                '--resume',
                id
            ] : null;
        case 'devin':
            return providerSession.key === 'session_id' ? [
                'devin',
                '--resume',
                id
            ] : null;
        case 'omp':
            return providerSession.key === 'session_id' ? [
                'omp',
                '--resume',
                ompResumeFilePath?.trim() || providerSession.transcriptPath?.trim() || id
            ] : null;
        case 'copilot':
            return providerSession.key === 'session_id' ? [
                'copilot',
                `--resume=${id}` // i18n-ignore
            ] : null;
        case 'kimi':
            return providerSession.key === 'session_id' ? [
                'kimi',
                '--session',
                id
            ] : null;
        case 'muse':
            return providerSession.key === 'session_id' ? [
                'muse',
                'resume',
                id
            ] : null;
        case 'zcode':
            return providerSession.key === 'session_id' ? [
                'zcode',
                '--resume',
                id
            ] : null;
        // dsh keys its sessions by workspace path: the pane keeps its folder.
        case 'dsh':
            return providerSession.key === 'session_id' ? [
                'dsh-tui',
                '--resume',
                id
            ] : null;
    }
}
