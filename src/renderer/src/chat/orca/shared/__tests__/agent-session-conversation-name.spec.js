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
import { AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH, isAgentSessionConversationName, normalizeAgentSessionConversationName } from "../agent-session-conversation-name.js";
describe('normalizeAgentSessionConversationName', ()=>{
    it('keeps a plain single-line name unchanged', ()=>{
        expect(normalizeAgentSessionConversationName('Fix the flaky lease probe')).toBe('Fix the flaky lease probe');
    });
    it('flattens whitespace so a multi-line name cannot break the tab strip', ()=>{
        expect(normalizeAgentSessionConversationName('Fix  the\nlease\tprobe  ')).toBe('Fix the lease probe');
    });
    it('rejects an empty or whitespace-only name rather than blanking the label', ()=>{
        expect(normalizeAgentSessionConversationName('')).toBeNull();
        expect(normalizeAgentSessionConversationName('   \n ')).toBeNull();
    });
    it('rejects anything that is not a string', ()=>{
        expect(normalizeAgentSessionConversationName(undefined)).toBeNull();
        expect(normalizeAgentSessionConversationName(null)).toBeNull();
        expect(normalizeAgentSessionConversationName(42)).toBeNull();
        expect(normalizeAgentSessionConversationName({
            title: 'x'
        })).toBeNull();
    });
    it('bounds a pasted essay to the stored maximum', ()=>{
        const normalized = normalizeAgentSessionConversationName('a'.repeat(1000));
        expect(normalized).toHaveLength(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH);
        expect(isAgentSessionConversationName(normalized)).toBe(true);
    });
});
describe('isAgentSessionConversationName', ()=>{
    it('accepts only bounded canonical names', ()=>{
        expect(isAgentSessionConversationName('Fix the probe')).toBe(true);
        expect(isAgentSessionConversationName('')).toBe(false);
        expect(isAgentSessionConversationName('a'.repeat(201))).toBe(false);
        expect(isAgentSessionConversationName(' Fix the probe ')).toBe(false);
        expect(isAgentSessionConversationName('Fix\nthe probe')).toBe(false);
        expect(isAgentSessionConversationName('Fix\u202Egnp.exe probe')).toBe(false);
        expect(isAgentSessionConversationName(7)).toBe(false);
    });
});
describe('normalizeAgentSessionConversationName hostile text', ()=>{
    it('strips control characters and bidi overrides', ()=>{
        expect(normalizeAgentSessionConversationName('Fix\u202Egnp.exe probe')).toBe('Fix gnp.exe probe');
        expect(normalizeAgentSessionConversationName('Fix\u0007the probe')).toBe('Fix the probe');
        expect(normalizeAgentSessionConversationName('Fix\u200Bthe probe')).toBe('Fix the probe');
        expect(normalizeAgentSessionConversationName('\u202E\u200B ')).toBeNull();
    });
    it('never truncates through a surrogate pair', ()=>{
        const name = `${'a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1)}\u{1F600}tail`;
        const normalized = normalizeAgentSessionConversationName(name);
        expect(normalized).toBe('a'.repeat(AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH - 1));
        expect(normalized).not.toContain('\uFFFD');
    });
    it('keeps a legitimate non-ASCII name intact', ()=>{
        expect(normalizeAgentSessionConversationName('R\u00E9sum\u00E9 du fil \u2615')).toBe('R\u00E9sum\u00E9 du fil \u2615');
    });
});
describe('normalizeAgentSessionConversationName joiners', ()=>{
    const ZWJ = '\u200D';
    const ZWNJ = '\u200C';
    it.each([
        [
            'family emoji',
            `Fix \u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467} layout`
        ],
        [
            'flag emoji',
            `Ship \u{1F3F3}\uFE0F${ZWJ}\u{1F308} theme`
        ],
        [
            'profession emoji',
            `Add \u{1F469}${ZWJ}\u{1F4BB} avatar`
        ],
        [
            'Persian ZWNJ',
            `می${ZWNJ}خواهم تست`
        ],
        [
            'Hindi ZWNJ conjunct',
            `क्${ZWNJ}ष ठीक`
        ]
    ])('keeps the joiners in a %s name', (_label, name)=>{
        expect(normalizeAgentSessionConversationName(name)).toBe(name);
    });
    it.each([
        [
            'bidi override',
            'Fix\u202Egnp.exe probe',
            'Fix gnp.exe probe'
        ],
        [
            'isolate pair',
            'Fix\u2066the\u2069 probe',
            'Fix the probe'
        ],
        [
            'Arabic letter mark',
            'Fix\u061Cthe probe',
            'Fix the probe'
        ],
        [
            'soft hyphen',
            'Fix\u00ADthe probe',
            'Fix the probe'
        ],
        [
            'word joiner',
            'Fix\u2060the probe',
            'Fix the probe'
        ],
        [
            'zero-width space',
            'Fix\u200Bthe probe',
            'Fix the probe'
        ],
        [
            'byte order mark',
            'Fix\uFEFFthe probe',
            'Fix the probe'
        ]
    ])('still strips a %s', (_label, name, expected)=>{
        expect(normalizeAgentSessionConversationName(name)).toBe(expected);
    });
    it.each([
        [
            'invisible maths operators',
            '\u2061\u2062\u2063\u2064'
        ],
        [
            'tag characters',
            '\u{E0020}\u{E0041}\u{E007F}'
        ],
        [
            'a Mongolian vowel separator',
            '\u180E'
        ],
        [
            'interlinear annotation marks',
            '\uFFF9\uFFFA\uFFFB'
        ],
        [
            'deprecated format characters',
            '\u206A\u206B\u206C\u206D\u206E\u206F'
        ],
        [
            'Arabic number signs',
            '\u0600\u0601\u06DD'
        ],
        [
            'the joiners themselves',
            `${ZWNJ}${ZWJ}`
        ],
        [
            'a bidi and zero-width mix',
            '\u202E\u200B\u2060'
        ],
        [
            'joiners split by a tab',
            `${ZWJ}\t${ZWJ}`
        ],
        [
            'joiners split by a newline',
            `${ZWJ}\n${ZWJ}`
        ],
        [
            'joiners split by a byte order mark',
            `${ZWJ}\uFEFF${ZWJ}`
        ],
        [
            'joiners split by zero-width spaces',
            `\u200B${ZWJ}\u200B${ZWJ}`
        ],
        [
            'joiners split by literal spaces',
            ` ${ZWJ} ${ZWJ} `
        ],
        [
            'joiners split by a bidi override',
            `\u202E${ZWJ}\u202E${ZWJ}`
        ],
        [
            'mixed joiners split by a tab',
            `${ZWJ}\t${ZWNJ}`
        ],
        [
            'joiners wrapped in tag characters',
            `\u{E0020}${ZWJ}\u{E0041}${ZWJ}\u{E007F}`
        ]
    ])('rejects a name that is only %s', (_label, name)=>{
        expect(normalizeAgentSessionConversationName(name)).toBeNull();
    });
    it('drops a tag-character payload hidden after a real title', ()=>{
        const hidden = Array.from('ransom', (c)=>String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
        const normalized = normalizeAgentSessionConversationName(`Fix login bug${hidden}`);
        expect(normalized).toBe('Fix login bug');
        expect(Array.from(normalized ?? '', (c)=>c.codePointAt(0) ?? 0).every((c)=>c < 0x7f)).toBe(true);
    });
    it('never ends a truncated name on a dangling joiner', ()=>{
        const name = `${'A'.repeat(197)}\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
        const normalized = normalizeAgentSessionConversationName(name);
        expect(normalized?.endsWith(ZWJ)).toBe(false);
        expect(normalized).toBe(`${'A'.repeat(197)}\u{1F468}`);
        expect(normalized).not.toContain('\uFFFD');
    });
});
