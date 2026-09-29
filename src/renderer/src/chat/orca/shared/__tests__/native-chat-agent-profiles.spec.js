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
import { describe, expect, it } from 'vitest';
import { getHostClaimedNativeChatCommands, getNativeChatAgentProfile, getVerifiedNativeChatCommands } from "../native-chat-agent-profiles.js";
describe('native chat agent picker profiles', ()=>{
    it('keeps Codex skills invocable as dollar tokens', ()=>{
        expect(getNativeChatAgentProfile('codex')).toMatchObject({
            skillPrefix: '$',
            skillSourceOwner: 'codex'
        });
    });
    it('writes Claude-family and Grok skills as slash tokens', ()=>{
        expect(getNativeChatAgentProfile('claude')).toMatchObject({
            skillPrefix: '/',
            skillSourceOwner: 'claude'
        });
        expect(getNativeChatAgentProfile('openclaude')).toMatchObject({
            skillSourceOwner: 'claude'
        });
        expect(getNativeChatAgentProfile('grok')).toMatchObject({
            skillPrefix: '/',
            skillSourceOwner: 'grok'
        });
    });
    it('does not grant custom or unverified agents a skill grammar', ()=>{
        expect(getNativeChatAgentProfile('custom-agent')).toBeNull();
    });
});
describe('host-claimed native chat commands', ()=>{
    function names(agent) {
        return getHostClaimedNativeChatCommands(agent).map((command)=>command.name);
    }
    it('claims nothing from the Claude-family catalog', ()=>{
        expect(names('claude')).toEqual([]);
        expect(names('openclaude')).toEqual([]);
    });
    it('keeps the Codex catalog claimed except the model-driven /goal', ()=>{
        expect(names('codex')).toContain('permissions');
        expect(names('codex')).toContain('vim');
        expect(names('codex')).not.toContain('goal');
        expect(getVerifiedNativeChatCommands('codex').map((command)=>command.name)).toContain('goal');
    });
    it('claims the whole catalog for agents with no pass-through policy', ()=>{
        expect(names('custom-agent')).toEqual([
            'clear',
            'help'
        ]);
        expect(names('grok')).toEqual([]);
    });
});
