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
import { agentInputLineCleared, planNativeChatLaunchDraftSend, resolveNativeChatLaunchDraftSend } from "../native-chat-launch-draft-send.js";
import { AGENT_TUI_CLEAR_INPUT_LINE, buildAgentTuiClearInputForText } from "../shared/agent-tui-input-clear.js";
const SEEDED = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123';
const screenHoldingDraft = [
    '  ▘▘ ▝▝    ~/repo',
    '────────────────────────────────────────',
    '❯ Linked Linear issue: ABC-123',
    '  https://linear.app/x/issue/ABC-123',
    '────────────────────────────────────────'
].join('\n');
const screenPlaceholder = [
    '  ▘▘ ▝▝    ~/repo',
    '────────────────────────────────────────',
    '❯ Try "create a util logging.py that..."',
    '────────────────────────────────────────'
].join('\n');
const plan = (over = {})=>planNativeChatLaunchDraftSend({
        seededText: SEEDED,
        ...over
    });
describe('planNativeChatLaunchDraftSend', ()=>{
    it('replaces the parked draft even when the composer copy is unchanged', ()=>{
        expect(plan()).toEqual({
            kind: 'replace-draft',
            clearInput: buildAgentTuiClearInputForText(SEEDED),
            seededText: SEEDED
        });
    });
    it('does not submit a terminal-side edit that preserves the old short prefix', ()=>{
        const samePrefixEdit = [
            '────────────────────────────────────────',
            '❯ Linked Linear but terminal-side text changed',
            '────────────────────────────────────────'
        ].join('\n');
        const result = resolveNativeChatLaunchDraftSend({
            launchDraft: {
                agent: 'codex',
                text: SEEDED
            },
            launchDraftResolved: false,
            agent: 'codex',
            readScreen: ()=>samePrefixEdit
        });
        expect(result.plan.kind).toBe('replace-draft');
    });
    it('keeps the ordinary send path when nothing is parked on the line', ()=>{
        expect(plan({
            seededText: null
        })).toEqual({
            kind: 'default'
        });
        expect(plan({
            seededText: '   '
        })).toEqual({
            kind: 'default'
        });
    });
    it('sizes a multi-line clear well past a single Ctrl+U', ()=>{
        const result = plan();
        expect(result.kind === 'replace-draft' && result.clearInput.length).toBeGreaterThan(AGENT_TUI_CLEAR_INPUT_LINE.length);
    });
});
describe('agentInputLineCleared', ()=>{
    it('confirms only an observably empty prompt', ()=>{
        expect(agentInputLineCleared('› \n  gpt-5.6 · ~/repo')).toBe(true);
    });
    it('does not call a different nonempty prompt cleared', ()=>{
        const edited = [
            '────────────────────────────────────────',
            '❯ issue: ABC-123 residue after a cursor-middle clear',
            '────────────────────────────────────────'
        ].join('\n');
        expect(agentInputLineCleared(edited)).toBe(false);
    });
    it('does not ignore nonempty continuation rows after an empty prompt row', ()=>{
        const residue = [
            '────────────────────────────────────────',
            '❯ ',
            '  suffix after a cursor-middle clear',
            '────────────────────────────────────────'
        ].join('\n');
        expect(agentInputLineCleared(residue)).toBe(false);
    });
    it('treats placeholders and parked drafts as unconfirmed', ()=>{
        expect(agentInputLineCleared(screenPlaceholder)).toBe(false);
        expect(agentInputLineCleared(screenHoldingDraft)).toBe(false);
    });
    it('treats an unreadable screen as unconfirmed', ()=>{
        expect(agentInputLineCleared(null)).toBe(false);
        expect(agentInputLineCleared('unparseable')).toBe(false);
    });
    it('reads an empty prompt through serializer ANSI', ()=>{
        expect(agentInputLineCleared(`[2m❯[0m `)).toBe(true);
    });
});
