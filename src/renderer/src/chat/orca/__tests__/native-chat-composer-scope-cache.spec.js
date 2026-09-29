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
import { describe, it, expect } from 'vitest';
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX, setBoundedScopeCacheEntry } from "../native-chat-composer-scope-cache.js";
describe('setBoundedScopeCacheEntry', ()=>{
    it('bounds the cache with LRU eviction, keeping re-set keys', ()=>{
        const cache = new Map();
        setBoundedScopeCacheEntry(cache, 'keep', 1);
        const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 20;
        for(let i = 0; i < total; i += 1){
            setBoundedScopeCacheEntry(cache, `scope-${i}`, i);
            if (i % 10 === 0) {
                setBoundedScopeCacheEntry(cache, 'keep', 1);
            }
        }
        expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX);
        expect(cache.has('scope-0')).toBe(false);
        expect(cache.has('keep')).toBe(true);
        expect(cache.has(`scope-${total - 1}`)).toBe(true);
    });
    it('moves a re-set key to most-recent and updates its value', ()=>{
        const cache = new Map();
        setBoundedScopeCacheEntry(cache, 'a', 1);
        setBoundedScopeCacheEntry(cache, 'b', 2);
        setBoundedScopeCacheEntry(cache, 'a', 3);
        expect([
            ...cache.keys()
        ]).toEqual([
            'b',
            'a'
        ]);
        expect(cache.get('a')).toBe(3);
    });
});
