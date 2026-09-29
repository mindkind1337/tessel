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
import { applySlashSuggestion, filterSlashCommands, getAgentSlashCommands, isSlashCommandDraft, sessionReportedSkillNames, sessionSlashCommandSuggestions, slashCommandDispatchText } from "../native-chat-slash-commands.js";
describe('getAgentSlashCommands', ()=>{
    it('returns Codex-specific commands (e.g. /model, /resume) for codex', ()=>{
        const names = getAgentSlashCommands('codex').map((c)=>c.name);
        expect(names).toContain('model');
        expect(names).toContain('resume');
        expect(names).toContain('diff');
    });
    it('returns Claude commands for claude (no Codex-only /model)', ()=>{
        const names = getAgentSlashCommands('claude').map((c)=>c.name);
        expect(names).toContain('clear');
        expect(names).toContain('compact');
        expect(names).not.toContain('model');
    });
    it('falls back to a small common set for an unknown agent (never empty)', ()=>{
        const names = getAgentSlashCommands('some-other-agent').map((c)=>c.name);
        expect(names).toEqual([
            'clear',
            'help'
        ]);
    });
});
describe('isSlashCommandDraft', ()=>{
    it('is true for a leading slash, even with leading whitespace', ()=>{
        expect(isSlashCommandDraft('/clear')).toBe(true);
        expect(isSlashCommandDraft('  /model')).toBe(true);
    });
    it('is false for ordinary prose or a mid-line slash', ()=>{
        expect(isSlashCommandDraft('fix the bug')).toBe(false);
        expect(isSlashCommandDraft('run a/b test')).toBe(false);
        expect(isSlashCommandDraft('')).toBe(false);
    });
});
describe('filterSlashCommands', ()=>{
    const codex = getAgentSlashCommands('codex');
    it('returns all commands for an empty query (bare /)', ()=>{
        expect(filterSlashCommands(codex, '')).toHaveLength(codex.length);
    });
    it('prefix-matches case-insensitively', ()=>{
        const names = filterSlashCommands(codex, 'mod').map((c)=>c.name);
        expect(names).toEqual([
            'model'
        ]);
        expect(filterSlashCommands(codex, 'MOD').map((c)=>c.name)).toEqual([
            'model'
        ]);
    });
});
describe('dispatch vs completion text', ()=>{
    it('dispatch text has no trailing space (Enter dispatches the command)', ()=>{
        expect(slashCommandDispatchText({
            name: 'clear'
        })).toBe('/clear');
    });
    it('completion text has a trailing space (Tab completes for arguments)', ()=>{
        expect(applySlashSuggestion({
            name: 'model'
        })).toBe('/model ');
    });
});
describe('a session that reports its own command surface', ()=>{
    const reported = [
        {
            name: 'clear',
            kind: 'command'
        },
        {
            name: 'opsx:apply',
            kind: 'command'
        },
        {
            name: 'ref-oss',
            kind: 'skill'
        }
    ];
    it('offers exactly the reported commands, described from the curated catalog', ()=>{
        expect(sessionSlashCommandSuggestions('claude', reported)).toEqual([
            {
                name: 'clear',
                description: 'Clear conversation history'
            },
            {
                name: 'opsx:apply'
            }
        ]);
    });
    it('does not resurrect a curated command the session never reported', ()=>{
        const names = sessionSlashCommandSuggestions('claude', reported).map((c)=>c.name);
        expect(names).not.toContain('compact');
    });
    it('splits skills out for the picker to group on its own', ()=>{
        expect(sessionReportedSkillNames(reported)).toEqual([
            'ref-oss'
        ]);
    });
    it('prefers the description the session reported over the curated one', ()=>{
        expect(sessionSlashCommandSuggestions('claude', [
            {
                name: 'clear',
                kind: 'command',
                description: 'Wipe the transcript'
            },
            {
                name: 'goal',
                kind: 'command',
                description: 'Set or view the goal'
            },
            {
                name: 'compact',
                kind: 'command'
            }
        ])).toEqual([
            {
                name: 'clear',
                description: 'Wipe the transcript'
            },
            {
                name: 'goal',
                description: 'Set or view the goal'
            },
            {
                name: 'compact',
                description: 'Summarize and compact the conversation'
            }
        ]);
    });
    it('keeps a reported description and argument hint the curated catalog never claims', ()=>{
        expect(sessionSlashCommandSuggestions('codex', [
            {
                name: 'opsx:apply',
                kind: 'command',
                description: 'Apply the plan',
                argumentHint: '<plan-id>',
                kindUnspecified: true
            }
        ])).toEqual([
            {
                name: 'opsx:apply',
                description: 'Apply the plan',
                argumentHint: '<plan-id>',
                kindUnspecified: true
            }
        ]);
    });
});
