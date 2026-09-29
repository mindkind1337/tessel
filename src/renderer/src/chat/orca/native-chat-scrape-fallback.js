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
import { assembleNativeChatSession } from "./native-chat-session-assembler.js";
const ESC = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g');
const SINGLE_ESCAPE_PATTERN = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g');
function stripUnsupportedControlCharacters(value) {
    let result = '';
    for (const char of value){
        const code = char.charCodeAt(0);
        if (code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code === 127) {
            continue;
        }
        result += char;
    }
    return result;
}
export function stripScrollbackAnsi(value) {
    return stripUnsupportedControlCharacters(value.replace(OSC_SEQUENCE_PATTERN, '').replace(ANSI_ESCAPE_PATTERN, '').replace(SINGLE_ESCAPE_PATTERN, '')).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
const USER_PROMPT_MARKERS = [
    '$',
    '%',
    '>',
    '#',
    '❯',
    '➜',
    '»'
];
function looksLikeUserPrompt(segment) {
    const firstLine = segment.split('\n', 1)[0]?.trimStart() ?? '';
    if (firstLine.length === 0) {
        return false;
    }
    const firstChar = firstLine[0];
    return USER_PROMPT_MARKERS.includes(firstChar);
}
export function scrapeScrollbackToMessages(rawScrollback) {
    const cleaned = stripScrollbackAnsi(rawScrollback);
    if (cleaned.trim().length === 0) {
        return [];
    }
    const segments = cleaned.split(/\n[ \t]*\n+/).map((segment)=>segment.replace(/\s+$/g, '').replace(/^\n+/, '')).filter((segment)=>segment.trim().length > 0);
    return segments.map((segment, index)=>({
            id: `scrape-${index}`, // i18n-ignore
            role: looksLikeUserPrompt(segment) ? 'user' : 'assistant',
            blocks: [
                {
                    type: 'text',
                    text: segment
                }
            ],
            timestamp: null,
            source: 'scrape'
        }));
}
export function scrapeNativeChatSession(rawScrollback, agent) {
    const messages = scrapeScrollbackToMessages(rawScrollback);
    const session = assembleNativeChatSession({
        sources: {
            scrape: messages
        },
        sessionId: null,
        agent
    });
    return {
        session,
        isApproximate: true
    };
}
