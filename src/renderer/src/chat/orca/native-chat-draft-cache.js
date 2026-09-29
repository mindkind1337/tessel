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
import { setBoundedScopeCacheEntry } from "./native-chat-composer-scope-cache.js";
const draftCache = new Map();
export function readNativeChatDraftCache(scopeKey) {
    return draftCache.get(scopeKey)?.text ?? '';
}
export function writeNativeChatDraftCache(scopeKey, draft) {
    if (draft === '') {
        draftCache.delete(scopeKey);
        return;
    }
    setBoundedScopeCacheEntry(draftCache, scopeKey, {
        text: draft,
        document: draftCache.get(scopeKey)?.text === draft ? draftCache.get(scopeKey)?.document : undefined
    });
}
export function clearNativeChatDraftCacheForTests() {
    draftCache.clear();
}
export function readNativeChatDraftDocument(scopeKey, text) {
    const cached = draftCache.get(scopeKey);
    return cached?.text === text ? cached.document : undefined;
}
export function writeNativeChatDraftDocument(scopeKey, text, document) {
    if (!text) {
        draftCache.delete(scopeKey);
        return;
    }
    setBoundedScopeCacheEntry(draftCache, scopeKey, {
        text,
        document
    });
}
