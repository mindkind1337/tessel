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
import { cloneNativeChatSessionOptionRecord, createNativeChatSessionOptionRecord } from "./shared/native-chat-session-option-state.js";
import { setBoundedScopeCacheEntry } from "./native-chat-composer-scope-cache.js";
const sessionOptionCache = new Map();
export function readNativeChatSessionOptionCache(scopeKey, fallbackScopeKey) {
    const record = sessionOptionCache.get(scopeKey) ?? sessionOptionCache.get(fallbackScopeKey ?? '');
    return record ? cloneNativeChatSessionOptionRecord(record) : null;
}
export function writeNativeChatSessionOptionCache(scopeKey, record) {
    setBoundedScopeCacheEntry(sessionOptionCache, scopeKey, cloneNativeChatSessionOptionRecord(record));
}
export function seedNativeChatAppliedSessionOptions(scopeKey, agent, values) {
    const modelId = typeof values?.model === 'string' ? values.model : null;
    if (!modelId) {
        return;
    }
    const record = createNativeChatSessionOptionRecord(agent);
    record.model = {
        value: modelId,
        source: 'applied'
    };
    const modelValues = {};
    for (const [id, value] of Object.entries(values ?? {})){
        if (id !== 'model') {
            modelValues[id] = {
                value,
                source: 'applied'
            };
        }
    }
    record.valuesByModel[modelId] = modelValues;
    writeNativeChatSessionOptionCache(scopeKey, record);
}
export function clearNativeChatSessionOptionCacheForTests() {
    sessionOptionCache.clear();
}
