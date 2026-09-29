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
import { agentJournalLinkageFields, isRootAgentJournalItem } from "../agent-session-journal-producer.js";
describe('isRootAgentJournalItem', ()=>{
    it("reads a row carrying no agent id as the session's own", ()=>{
        expect(isRootAgentJournalItem({})).toBe(true);
    });
    it('reads a row carrying one as a subagent’s', ()=>{
        expect(isRootAgentJournalItem({
            agentId: 'task-1'
        })).toBe(false);
    });
    it('reads an id that failed to resolve as a subagent’s, not as root', ()=>{
        expect(isRootAgentJournalItem({
            agentId: ''
        })).toBe(false);
    });
    it('reads a missing item as root rather than throwing', ()=>{
        expect(isRootAgentJournalItem(undefined)).toBe(true);
    });
});
describe('agentJournalLinkageFields', ()=>{
    it('omits absent members rather than writing them as undefined', ()=>{
        expect(agentJournalLinkageFields({
            agentId: 'task-1'
        })).toEqual({
            agentId: 'task-1'
        });
        expect(agentJournalLinkageFields(undefined)).toEqual({});
    });
    it('carries every member of the bundle through', ()=>{
        const linkage = {
            agentId: 'task-1',
            parentAgentId: 'task-parent',
            providerParentRef: 'toolu_1',
            producerKind: 'background',
            attempt: 3
        };
        expect(agentJournalLinkageFields(linkage)).toEqual(linkage);
    });
});
