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
import { scrapeScrollbackToMessages, scrapeNativeChatSession, stripScrollbackAnsi } from "../native-chat-scrape-fallback.js";
const ESC = String.fromCharCode(27);
describe('scrapeScrollbackToMessages', ()=>{
    it('strips ANSI escapes and segments into >1 ordered messages', ()=>{
        const raw = [
            `${ESC}[32m$ run the build${ESC}[0m`,
            '',
            `${ESC}[1mBuilding project...${ESC}[0m`,
            'Done in 2s.'
        ].join('\n');
        const messages = scrapeScrollbackToMessages(raw);
        expect(messages.length).toBeGreaterThan(1);
        for (const message of messages){
            for (const block of message.blocks){
                if (block.type === 'text') {
                    expect(block.text).not.toContain(ESC);
                }
            }
        }
        expect(messages[0].id).toBe('scrape-0');
        expect(messages[1].id).toBe('scrape-1');
    });
    it('returns an empty list for empty / whitespace scrollback without throwing', ()=>{
        expect(scrapeScrollbackToMessages('')).toEqual([]);
        expect(scrapeScrollbackToMessages('   \n\t  \n')).toEqual([]);
    });
    it('marks every produced message with source "scrape" and a null timestamp', ()=>{
        const raw = '$ hello\n\nworld output\n\nmore output';
        const messages = scrapeScrollbackToMessages(raw);
        expect(messages.length).toBeGreaterThan(0);
        for (const message of messages){
            expect(message.source).toBe('scrape');
            expect(message.timestamp).toBeNull();
        }
    });
    it('assigns roles per the prompt-marker heuristic', ()=>{
        const raw = [
            '$ deploy to staging',
            '',
            'Deploying to staging environment...',
            'Deployed.'
        ].join('\n');
        const messages = scrapeScrollbackToMessages(raw);
        expect(messages[0].role).toBe('user');
        expect(messages[1].role).toBe('assistant');
    });
});
describe('stripScrollbackAnsi', ()=>{
    it('removes escape sequences and normalizes carriage returns', ()=>{
        const raw = `${ESC}[31mred\r\nnext`;
        expect(stripScrollbackAnsi(raw)).toBe('red\nnext');
    });
});
describe('scrapeNativeChatSession', ()=>{
    it('builds a ready, approximate session from non-empty scrollback', ()=>{
        const { session, isApproximate } = scrapeNativeChatSession('$ ls\n\noutput here', 'claude');
        expect(isApproximate).toBe(true);
        expect(session.status).toBe('ready');
        expect(session.sessionId).toBeNull();
        expect(session.agent).toBe('claude');
        expect(session.messages.length).toBeGreaterThan(0);
        expect(session.messages.every((message)=>message.source === 'scrape')).toBe(true);
    });
    it('builds an empty session from blank scrollback', ()=>{
        const { session, isApproximate } = scrapeNativeChatSession('   \n  ', 'claude');
        expect(isApproximate).toBe(true);
        expect(session.status).toBe('empty');
        expect(session.messages).toEqual([]);
    });
});
