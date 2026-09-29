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
describe('resolveNativeChatSession', ()=>{
    it('resolves a pane with a captured Claude session', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'claude',
            agentStatusEntry: entry({
                paneKey,
                agentType: 'claude',
                providerSession: {
                    key: 'session_id',
                    id: 'sess-abc'
                }
            }),
            ptyId: 'pty-1'
        })).toEqual({
            agent: 'claude',
            sessionId: 'sess-abc',
            transcriptPath: null,
            ptyId: 'pty-1',
            paneKey
        });
    });
    it('surfaces the hook transcriptPath when the providerSession carries one', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'claude',
            agentStatusEntry: entry({
                paneKey,
                agentType: 'claude',
                providerSession: {
                    key: 'session_id',
                    id: 'sess-abc',
                    transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl'
                }
            }),
            ptyId: 'pty-1'
        })).toEqual({
            agent: 'claude',
            sessionId: 'sess-abc',
            transcriptPath: '/home/u/.claude/projects/slug/real-uuid.jsonl',
            ptyId: 'pty-1',
            paneKey
        });
    });
    it('resolves a just-launched pane with sessionId null', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'claude',
            agentStatusEntry: entry({
                paneKey,
                agentType: 'claude'
            }),
            ptyId: 'pty-1'
        })).toEqual({
            agent: 'claude',
            sessionId: null,
            transcriptPath: null,
            ptyId: 'pty-1',
            paneKey
        });
    });
    it('resolves two split leaves independently to their own values', ()=>{
        const leftKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        const rightKey = 'tab-1:22222222-2222-4222-8222-222222222222';
        const left = resolveNativeChatSession({
            paneKey: leftKey,
            launchAgent: 'claude',
            agentStatusEntry: entry({
                paneKey: leftKey,
                agentType: 'claude',
                providerSession: {
                    key: 'session_id',
                    id: 'left-sess'
                }
            }),
            ptyId: 'pty-left'
        });
        const right = resolveNativeChatSession({
            paneKey: rightKey,
            launchAgent: 'codex',
            agentStatusEntry: entry({
                paneKey: rightKey,
                agentType: 'codex',
                providerSession: {
                    key: 'session_id',
                    id: 'right-sess'
                }
            }),
            ptyId: 'pty-right'
        });
        expect(left).toEqual({
            agent: 'claude',
            sessionId: 'left-sess',
            transcriptPath: null,
            ptyId: 'pty-left',
            paneKey: leftKey
        });
        expect(right).toEqual({
            agent: 'codex',
            sessionId: 'right-sess',
            transcriptPath: null,
            ptyId: 'pty-right',
            paneKey: rightKey
        });
    });
    it('derives a supported agent from the status entry when no launchAgent is set', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: null,
            agentStatusEntry: entry({
                paneKey,
                agentType: 'codex',
                providerSession: {
                    key: 'session_id',
                    id: 'codex-1'
                }
            }),
            ptyId: 'pty-1'
        })).toEqual({
            agent: 'codex',
            sessionId: 'codex-1',
            transcriptPath: null,
            ptyId: 'pty-1',
            paneKey
        });
    });
    it.each([
        'codex',
        'claude',
        'openclaude'
    ])('resolves supported title fallback %s when no hook or launch identity exists', (resolvedAgent)=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: null,
            resolvedAgent,
            ptyId: 'pty-1'
        })).toEqual({
            agent: resolvedAgent,
            sessionId: null,
            transcriptPath: null,
            ptyId: 'pty-1',
            paneKey
        });
    });
    it('does not resolve unsupported title fallback gemini', ()=>{
        expect(resolveNativeChatSession({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            launchAgent: null,
            resolvedAgent: 'gemini',
            ptyId: 'pty-1'
        })).toBeNull();
    });
    it('resolves Grok from title fallback once native chat supports its transcript', ()=>{
        expect(resolveNativeChatSession({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            launchAgent: null,
            resolvedAgent: 'grok',
            ptyId: 'pty-1'
        })).toMatchObject({
            agent: 'grok',
            sessionId: null,
            ptyId: 'pty-1'
        });
    });
    it('does not resolve an unsupported live status entry', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: null,
            agentStatusEntry: entry({
                paneKey,
                agentType: 'gemini',
                providerSession: {
                    key: 'session_id',
                    id: 'g-1'
                }
            }),
            ptyId: 'pty-1'
        })).toBeNull();
    });
    it('does not fall back to a supported title agent when live status is unsupported', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: null,
            agentStatusEntry: entry({
                paneKey,
                agentType: 'gemini',
                providerSession: {
                    key: 'session_id',
                    id: 'g-1'
                }
            }),
            resolvedAgent: 'codex',
            ptyId: 'pty-1'
        })).toBeNull();
    });
    it('does not fall back to a supported launch agent when live status is unsupported', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'codex',
            agentStatusEntry: entry({
                paneKey,
                agentType: 'gemini',
                providerSession: {
                    key: 'session_id',
                    id: 'g-1'
                }
            }),
            resolvedAgent: 'claude',
            ptyId: 'pty-1'
        })).toBeNull();
    });
    it('resolves a Grok launch agent', ()=>{
        expect(resolveNativeChatSession({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            launchAgent: 'grok',
            ptyId: 'pty-1'
        })).toMatchObject({
            agent: 'grok',
            sessionId: null,
            ptyId: 'pty-1'
        });
    });
    it('keeps Grok launch identity ahead of a different title agent', ()=>{
        expect(resolveNativeChatSession({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            launchAgent: 'grok',
            resolvedAgent: 'codex',
            ptyId: 'pty-1'
        })).toMatchObject({
            agent: 'grok',
            sessionId: null,
            ptyId: 'pty-1'
        });
    });
    it('keeps launch identity ahead of the title fallback', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'claude',
            resolvedAgent: 'codex',
            ptyId: 'pty-1'
        })?.agent).toBe('claude');
    });
    it('keeps live hook identity and provider session ahead of the title fallback', ()=>{
        const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111';
        expect(resolveNativeChatSession({
            paneKey,
            launchAgent: 'claude',
            agentStatusEntry: entry({
                paneKey,
                agentType: 'codex',
                providerSession: {
                    key: 'session_id',
                    id: 'codex-live'
                }
            }),
            resolvedAgent: 'claude',
            ptyId: 'pty-1'
        })).toEqual({
            agent: 'codex',
            sessionId: 'codex-live',
            transcriptPath: null,
            ptyId: 'pty-1',
            paneKey
        });
    });
    it('returns null for a non-agent pane (no launchAgent, no entry)', ()=>{
        expect(resolveNativeChatSession({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            launchAgent: null,
            ptyId: 'pty-1'
        })).toBeNull();
    });
});
