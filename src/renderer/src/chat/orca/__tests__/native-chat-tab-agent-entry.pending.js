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
import { resolveNativeChatSession } from "../native-chat-pane-resolution.js";
import { findTabAgentEntry } from "../native-chat-tab-agent-entry.js";
function entry(overrides) {
    return {
        state: 'working',
        prompt: '',
        updatedAt: 0,
        stateStartedAt: 0,
        stateHistory: [],
        ...overrides
    };
}
describe('findTabAgentEntry (#19 selector)', ()=>{
    it('returns the entry whose paneKey carries the tab id prefix', ()=>{
        const target = entry({
            paneKey: 'tab-1:leaf-a',
            agentType: 'claude'
        });
        const map = {
            'tab-0:leaf-z': entry({
                paneKey: 'tab-0:leaf-z'
            }),
            'tab-1:leaf-a': target,
            'tab-2:leaf-b': entry({
                paneKey: 'tab-2:leaf-b'
            })
        };
        expect(findTabAgentEntry(map, 'tab-1')).toBe(target);
    });
    it('returns undefined when no pane matches the tab id', ()=>{
        const map = {
            'tab-0:leaf-z': entry({
                paneKey: 'tab-0:leaf-z'
            })
        };
        expect(findTabAgentEntry(map, 'tab-1')).toBeUndefined();
    });
    it('returns the first matching pane (deterministic insertion order)', ()=>{
        const first = entry({
            paneKey: 'tab-1:leaf-a'
        });
        const second = entry({
            paneKey: 'tab-1:leaf-b'
        });
        const map = {
            'tab-1:leaf-a': first,
            'tab-1:leaf-b': second
        };
        expect(findTabAgentEntry(map, 'tab-1')).toBe(first);
    });
    it('does not match a tab id that is only a substring of another tab id', ()=>{
        const map = {
            'tab-10:leaf-a': entry({
                paneKey: 'tab-10:leaf-a'
            })
        };
        expect(findTabAgentEntry(map, 'tab-1')).toBeUndefined();
    });
    it('resolves identically to the whole-map scan, including the empty-tabid fallback', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        const target = entry({
            paneKey,
            agentType: 'claude',
            providerSession: {
                key: 'session_id',
                id: 'sess-abc'
            }
        });
        const map = {
            'tab-0:other': entry({
                paneKey: 'tab-0:other',
                agentType: 'codex'
            }),
            [paneKey]: target
        };
        const oldEntry = findTabAgentEntry(map, 'tab-1');
        const oldResolution = resolveNativeChatSession({
            paneKey: oldEntry?.paneKey ?? 'tab-1:',
            launchAgent: 'claude',
            ...oldEntry ? {
                agentStatusEntry: oldEntry
            } : {},
            ptyId: null
        });
        const newEntry = findTabAgentEntry(map, 'tab-1');
        const newResolution = resolveNativeChatSession({
            paneKey: newEntry?.paneKey ?? 'tab-1:',
            launchAgent: 'claude',
            ...newEntry ? {
                agentStatusEntry: newEntry
            } : {},
            ptyId: null
        });
        expect(newEntry).toBe(oldEntry);
        expect(newResolution).toEqual(oldResolution);
    });
    it('falls back to `${terminalTabId}:` paneKey when the tab has no entry', ()=>{
        const map = {};
        const found = findTabAgentEntry(map, 'tab-9');
        const paneKey = found?.paneKey ?? 'tab-9:';
        expect(found).toBeUndefined();
        expect(paneKey).toBe('tab-9:');
    });
});
