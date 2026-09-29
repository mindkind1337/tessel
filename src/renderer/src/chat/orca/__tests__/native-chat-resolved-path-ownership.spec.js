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
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/i18n', ()=>({
        translate: (_key, fallback)=>fallback
    }));
import { nativeChatAttachmentOwnerUnchanged } from "../native-chat-resolved-path-ownership.js";
function ssh(overrides = {}) {
    return {
        kind: 'ssh',
        connectionId: 'conn-1',
        worktreePath: '/remote/wt',
        expectedExecutionHostId: 'ssh:conn-1',
        expectedSshTargetId: 'conn-1',
        expectedSshConnectionGeneration: 4,
        ...overrides
    };
}
describe('nativeChatAttachmentOwnerUnchanged', ()=>{
    it('keeps same-kind local and runtime owners', ()=>{
        expect(nativeChatAttachmentOwnerUnchanged({
            kind: 'local'
        }, {
            kind: 'local'
        })).toBe(true);
        expect(nativeChatAttachmentOwnerUnchanged({
            kind: 'runtime'
        }, {
            kind: 'runtime'
        })).toBe(true);
    });
    it('never treats an unknown owner as the same owner', ()=>{
        expect(nativeChatAttachmentOwnerUnchanged({
            kind: 'not-ready'
        }, {
            kind: 'not-ready'
        })).toBe(false);
        expect(nativeChatAttachmentOwnerUnchanged({
            kind: 'local'
        }, {
            kind: 'not-ready'
        })).toBe(false);
    });
    it('rejects an SSH reconnect that keeps the same connection id', ()=>{
        expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh())).toBe(true);
        expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh({
            expectedSshConnectionGeneration: 5
        }))).toBe(false);
        expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh({
            connectionId: 'conn-2'
        }))).toBe(false);
        expect(nativeChatAttachmentOwnerUnchanged(ssh(), ssh({
            worktreePath: '/other'
        }))).toBe(false);
    });
});
