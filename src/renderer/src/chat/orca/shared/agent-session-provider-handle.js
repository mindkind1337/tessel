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
export const AGENT_SESSION_PROVIDER_HANDLE_PROVIDERS = [
    'claude',
    'codex'
];
export function isAgentSessionHandleProvider(value) {
    return value === 'claude' || value === 'codex';
}
export const MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS = 256;
const MAX_HANDLE_FIELD_LENGTH = 512;
const LINK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
function isHandleField(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE_FIELD_LENGTH && value === value.trim();
}
export function isAgentSessionProviderHandle(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const handle = value;
    if (handle.provider === 'claude') {
        return isHandleField(handle.sessionId) && (handle.leafUuid === null || isHandleField(handle.leafUuid));
    }
    return handle.provider === 'codex' && isHandleField(handle.threadId);
}
export function agentSessionProviderHandleKey(handle) {
    return handle.provider === 'claude' ? `claude:${JSON.stringify([
        handle.sessionId,
        handle.leafUuid
    ])}` : `codex:${JSON.stringify(handle.threadId)}`;
}
export function agentSessionProviderHandleRoot(handle) {
    return handle.provider === 'claude' ? `claude:${JSON.stringify(handle.sessionId)}` : `codex:${JSON.stringify(handle.threadId)}`;
}
export function agentSessionProviderHandlesEqual(left, right) {
    return agentSessionProviderHandleKey(left) === agentSessionProviderHandleKey(right);
}
export function agentSessionProviderHandleChainHead(chain) {
    return chain.at(-1) ?? null;
}
export function findAgentSessionProviderHandleLink(chain, linkId) {
    return chain.find((link)=>link.linkId === linkId) ?? null;
}
export function isAgentSessionProviderHandleLink(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const link = value;
    const originValid = link.origin === 'created' || link.origin === 'adopted' || link.origin === 'resumed' || link.origin === 'forked';
    return typeof link.linkId === 'string' && LINK_ID_PATTERN.test(link.linkId) && isAgentSessionProviderHandle(link.handle) && originValid && Number.isSafeInteger(link.mintedAtFence) && link.mintedAtFence >= 0 && Number.isSafeInteger(link.observedAt) && (link.origin === 'forked' ? isHandleField(link.forkedFromKey) : link.forkedFromKey === undefined) && (link.supersedesKey === undefined || link.origin === 'created' && isHandleField(link.supersedesKey));
}
export function isAgentSessionProviderHandleChain(value) {
    if (!Array.isArray(value) || value.length > MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
        return false;
    }
    let validated = [];
    try {
        for (const link of value){
            if (!isAgentSessionProviderHandleLink(link)) {
                return false;
            }
            const next = appendAgentSessionProviderHandleLink(validated, link);
            if (next.length !== validated.length + 1) {
                return false;
            }
            validated = next;
        }
        return true;
    } catch  {
        return false;
    }
}
export function appendAgentSessionProviderHandleLink(chain, link) {
    if (!isAgentSessionProviderHandleLink(link)) {
        throw new Error('agent_session_provider_handle_invalid');
    }
    const head = agentSessionProviderHandleChainHead(chain);
    if (!head) {
        if (link.origin !== 'created' && link.origin !== 'adopted') {
            throw new Error('agent_session_provider_handle_invalid');
        }
        return [
            link
        ];
    }
    if (link.handle.provider !== head.handle.provider) {
        throw new Error('agent_session_provider_handle_provider_mismatch');
    }
    if (link.mintedAtFence < head.mintedAtFence) {
        throw new Error('agent_session_provider_handle_stale_fence');
    }
    if (link.origin === 'created' && link.supersedesKey !== undefined) {
        return supersedeUnsavedCreation(head, link);
    }
    if (link.origin === 'created' || link.origin === 'adopted') {
        throw new Error('agent_session_provider_handle_invalid');
    }
    const sameRoot = agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle);
    if (link.origin === 'resumed' && !sameRoot) {
        throw new Error('agent_session_provider_handle_forked');
    }
    if (link.origin === 'forked') {
        if (sameRoot) {
            throw new Error('agent_session_provider_handle_invalid');
        }
        if (link.forkedFromKey !== agentSessionProviderHandleKey(head.handle)) {
            throw new Error('agent_session_provider_handle_invalid');
        }
    }
    if (link.origin === 'resumed' && agentSessionProviderHandlesEqual(link.handle, head.handle) && link.mintedAtFence === head.mintedAtFence) {
        return [
            ...chain
        ];
    }
    if (findAgentSessionProviderHandleLink(chain, link.linkId)) {
        throw new Error('agent_session_provider_handle_invalid');
    }
    if (chain.length >= MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS) {
        throw new Error('agent_session_provider_handle_chain_overflow');
    }
    return [
        ...chain,
        link
    ];
}
function supersedeUnsavedCreation(head, link) {
    if (head.origin !== 'created' || link.supersedesKey !== agentSessionProviderHandleKey(head.handle) || agentSessionProviderHandleRoot(link.handle) === agentSessionProviderHandleRoot(head.handle) || link.linkId === head.linkId) {
        throw new Error('agent_session_provider_handle_invalid');
    }
    return [
        link
    ];
}
