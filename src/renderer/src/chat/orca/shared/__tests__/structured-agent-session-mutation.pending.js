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
import { structuredAgentSessionDomainFingerprint, structuredAgentSessionPayloadFingerprint } from "../structured-agent-session-mutation.js";
import { computeAgentSessionPayloadFingerprint } from "../agent-session-mutation-envelope.js";
describe('structured agent session client mutations', ()=>{
    it('canonicalizes payload fields before hashing', ()=>{
        const first = structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: 'session-1',
            fields: {
                body: {
                    role: 'user',
                    kind: 'message'
                },
                omitted: undefined
            }
        });
        const second = structuredAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId: 'session-1',
            fields: {
                body: {
                    kind: 'message',
                    role: 'user'
                }
            }
        });
        expect(first).toBe(second);
        expect(first).toMatch(/^[a-f0-9]{64}$/);
    });
    it('matches host code-unit ordering for mixed-case and non-ASCII keys', ()=>{
        const input = {
            method: 'agentSession.send',
            sessionId: 'session-1',
            fields: {
                a: 1,
                A: 2,
                é: 3,
                中: 4
            }
        };
        expect(structuredAgentSessionPayloadFingerprint(input)).toBe(computeAgentSessionPayloadFingerprint(input));
    });
    it('preserves the digest when a local fingerprint domain is not an RPC method', ()=>{
        const fields = {
            text: 'hello'
        };
        expect(structuredAgentSessionDomainFingerprint({
            domain: 'mobile.agentSession.send.intent',
            sessionId: 'session-1',
            fields
        })).toBe(structuredAgentSessionPayloadFingerprint({
            method: 'mobile.agentSession.send.intent',
            sessionId: 'session-1',
            fields
        }));
    });
});
