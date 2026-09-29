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
import { afterEach, describe, expect, it } from 'vitest';
import { clearNativeChatDraftCacheForTests, readNativeChatDraftCache, writeNativeChatDraftCache } from "../native-chat-draft-cache.js";
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from "../native-chat-composer-scope-cache.js";
afterEach(()=>{
    clearNativeChatDraftCacheForTests();
});
describe('native-chat draft cache', ()=>{
    it('returns an empty string for an unknown scope', ()=>{
        expect(readNativeChatDraftCache('pty-1')).toBe('');
    });
    it('round-trips a draft per scope key', ()=>{
        writeNativeChatDraftCache('pty-1', 'hello');
        writeNativeChatDraftCache('pty-2', 'world');
        expect(readNativeChatDraftCache('pty-1')).toBe('hello');
        expect(readNativeChatDraftCache('pty-2')).toBe('world');
    });
    it('drops the entry when the draft is cleared so stale text never resurfaces', ()=>{
        writeNativeChatDraftCache('pty-1', 'hello');
        writeNativeChatDraftCache('pty-1', '');
        expect(readNativeChatDraftCache('pty-1')).toBe('');
    });
    it('bounds the cache so unsent drafts for removed panes cannot accumulate', ()=>{
        writeNativeChatDraftCache('keep', 'hot');
        const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 40;
        for(let i = 0; i < total; i += 1){
            writeNativeChatDraftCache(`scope-${i}`, `draft-${i}`);
            if (i % 20 === 0) {
                writeNativeChatDraftCache('keep', 'hot');
            }
        }
        expect(readNativeChatDraftCache('scope-0')).toBe('');
        expect(readNativeChatDraftCache('keep')).toBe('hot');
        expect(readNativeChatDraftCache(`scope-${total - 1}`)).toBe(`draft-${total - 1}`);
    });
});
