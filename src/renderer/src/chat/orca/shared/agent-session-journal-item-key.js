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
const KEY_DELIMITER = ':';
const VERBATIM_BOUNDED_COMPONENT_TAG = '%FF';
const BOUNDED_COMPONENT_PATTERN = /^[\s\S]{0,40}~orca-oversized~(?:[1-9]\d*)~[0-9a-f]{16}$/;
const PARSED_JOURNAL_ITEM_KEY = Symbol('parsedJournalItemKey');
export const MAX_JOURNAL_KEY_COMPONENT_CHARS = 1024;
export function boundJournalKeyComponent(value) {
    if (value.length <= MAX_JOURNAL_KEY_COMPONENT_CHARS && !hasLoneSurrogate(value)) {
        return value;
    }
    const h1 = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, '0');
    const h2 = fnv1a32(value, 0x0100_0193).toString(16).padStart(8, '0');
    return `${wellFormedBoundedHead(value, 40)}~orca-oversized~${value.length}~${h1}${h2}`; // i18n-ignore
}
function wellFormedBoundedHead(value, maxUnits) {
    let head = '';
    let index = 0;
    while(index < value.length && index < maxUnits){
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                if (index + 1 >= maxUnits) {
                    break;
                }
                head += value.charAt(index) + value.charAt(index + 1);
                index += 2;
                continue;
            }
            head += '�';
            index += 1;
            continue;
        }
        head += unit >= 0xdc00 && unit <= 0xdfff ? '�' : value.charAt(index);
        index += 1;
    }
    return head;
}
function hasLoneSurrogate(value) {
    for(let index = 0; index < value.length; index += 1){
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
            if (next < 0xdc00 || next > 0xdfff) {
                return true;
            }
            index += 1;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            return true;
        }
    }
    return false;
}
function fnv1a32(value, seed) {
    let hash = seed >>> 0;
    for(let index = 0; index < value.length; index += 1){
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return hash >>> 0;
}
function encodePart(value) {
    const raw = String(value);
    const bounded = boundJournalKeyComponent(raw);
    const encoded = encodeURIComponent(bounded);
    return raw === bounded && isBoundedComponentRepresentation(raw) ? `${VERBATIM_BOUNDED_COMPONENT_TAG}${encoded}` : encoded;
}
function isBoundedComponentRepresentation(value) {
    return BOUNDED_COMPONENT_PATTERN.test(value);
}
export function agentJournalItemKey(identity) {
    const parsedKey = identity[PARSED_JOURNAL_ITEM_KEY];
    if (parsedKey !== undefined) {
        return parsedKey;
    }
    if (identity.provider === 'codex') {
        return [
            'codex',
            encodePart(identity.threadId),
            encodePart(identity.turnId),
            encodePart(identity.ordinal)
        ].join(KEY_DELIMITER);
    }
    if (identity.provider === 'claude') {
        return [
            'claude',
            encodePart(identity.sessionId),
            encodePart(identity.uuid)
        ].join(KEY_DELIMITER);
    }
    if (identity.provider === 'orca') {
        return [
            'orca',
            encodePart(identity.clientMessageId)
        ].join(KEY_DELIMITER);
    }
    return [
        'legacy',
        encodePart(identity.agent),
        encodePart(identity.sessionId),
        encodePart(identity.recordId)
    ].join(KEY_DELIMITER);
}
export function agentJournalSubmissionKey(clientMessageId) {
    return agentJournalItemKey({
        provider: 'orca',
        clientMessageId
    });
}
export function parseAgentJournalItemKey(key) {
    const parts = [];
    let preserveExactKey = false;
    for (const part of key.split(KEY_DELIMITER)){
        const decoded = decodePart(part);
        if (!decoded) {
            return null;
        }
        parts.push(decoded.value);
        preserveExactKey ||= decoded.tagged || isBoundedComponentRepresentation(decoded.value);
    }
    const [provider, ...rest] = parts;
    if (provider === 'codex' && rest.length === 3) {
        const ordinal = Number(rest[2]);
        return Number.isSafeInteger(ordinal) && ordinal >= 0 ? parsedIdentity({
            provider,
            threadId: rest[0],
            turnId: rest[1],
            ordinal
        }, key, preserveExactKey) : null;
    }
    if (provider === 'claude' && rest.length === 2) {
        return parsedIdentity({
            provider,
            sessionId: rest[0],
            uuid: rest[1]
        }, key, preserveExactKey);
    }
    if (provider === 'orca' && rest.length === 1) {
        return parsedIdentity({
            provider,
            clientMessageId: rest[0]
        }, key, preserveExactKey);
    }
    if (provider === 'legacy' && rest.length === 3) {
        return parsedIdentity({
            provider,
            agent: rest[0],
            sessionId: rest[1],
            recordId: rest[2]
        }, key, preserveExactKey);
    }
    return null;
}
function decodePart(part) {
    const tagged = part.startsWith(VERBATIM_BOUNDED_COMPONENT_TAG);
    try {
        const value = decodeURIComponent(tagged ? part.slice(VERBATIM_BOUNDED_COMPONENT_TAG.length) : part);
        return !tagged || isBoundedComponentRepresentation(value) ? {
            value,
            tagged
        } : null;
    } catch  {
        return null;
    }
}
function parsedIdentity(identity, key, preserveExactKey) {
    if (preserveExactKey) {
        Object.defineProperty(identity, PARSED_JOURNAL_ITEM_KEY, {
            value: key
        });
    }
    return identity;
}
