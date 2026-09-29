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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isStablePaneId(value) {
    return UUID_RE.test(value);
}
export function isTerminalLeafId(value) {
    return isStablePaneId(value);
}
export function makePaneKey(tabId, stableLeafId) {
    if (!tabId || tabId.includes(':')) {
        throw new Error('tabId must be non-empty and must not contain ":"');
    }
    if (!isTerminalLeafId(stableLeafId)) {
        throw new Error('stableLeafId must be a UUID');
    }
    return `${tabId}:${stableLeafId}`;
}
export function parsePaneKey(paneKey) {
    const first = paneKey.indexOf(':');
    if (first <= 0 || first !== paneKey.lastIndexOf(':') || first === paneKey.length - 1) {
        return null;
    }
    const tabId = paneKey.slice(0, first);
    const leafId = paneKey.slice(first + 1);
    if (!isTerminalLeafId(leafId)) {
        return null;
    }
    return {
        tabId,
        leafId,
        stablePaneId: leafId
    };
}
export function parseLegacyNumericPaneKey(paneKey) {
    if (typeof paneKey !== 'string' || paneKey.length > 256) {
        return null;
    }
    const trimmed = paneKey.trim();
    const delimiter = trimmed.indexOf(':');
    if (delimiter <= 0 || delimiter !== trimmed.lastIndexOf(':') || delimiter === trimmed.length - 1) {
        return null;
    }
    const numericPaneId = trimmed.slice(delimiter + 1);
    if (!/^\d+$/.test(numericPaneId)) {
        return null;
    }
    return {
        tabId: trimmed.slice(0, delimiter),
        numericPaneId,
        paneKey: trimmed
    };
}
