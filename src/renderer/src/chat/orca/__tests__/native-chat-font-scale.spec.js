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
import { chatFontScaleActionForEvent, chatFontScaleShortcutLabels, clampChatFontScale, decreaseChatFontScale, DEFAULT_CHAT_FONT_SCALE, increaseChatFontScale, MAX_CHAT_FONT_SCALE, MIN_CHAT_FONT_SCALE } from "../native-chat-font-scale.js";
function combo(overrides) {
    return {
        key: '=',
        metaKey: false,
        ctrlKey: false,
        ...overrides
    };
}
describe('clampChatFontScale', ()=>{
    it('keeps a value inside the band untouched', ()=>{
        expect(clampChatFontScale(1.2)).toBe(1.2);
    });
    it('clamps below the minimum', ()=>{
        expect(clampChatFontScale(0.1)).toBe(MIN_CHAT_FONT_SCALE);
    });
    it('clamps above the maximum', ()=>{
        expect(clampChatFontScale(5)).toBe(MAX_CHAT_FONT_SCALE);
    });
    it('rounds away float drift to clean tenths', ()=>{
        expect(clampChatFontScale(0.7999999999)).toBe(0.8);
    });
});
describe('increase/decreaseChatFontScale', ()=>{
    it('steps up by a tenth without drift', ()=>{
        expect(increaseChatFontScale(1)).toBe(1.1);
        expect(increaseChatFontScale(1.1)).toBe(1.2);
    });
    it('steps down by a tenth without drift', ()=>{
        expect(decreaseChatFontScale(1)).toBe(0.9);
        expect(decreaseChatFontScale(0.9)).toBe(0.8);
    });
    it('does not exceed the max when stepping up at the ceiling', ()=>{
        expect(increaseChatFontScale(MAX_CHAT_FONT_SCALE)).toBe(MAX_CHAT_FONT_SCALE);
    });
    it('does not drop below the min when stepping down at the floor', ()=>{
        expect(decreaseChatFontScale(MIN_CHAT_FONT_SCALE)).toBe(MIN_CHAT_FONT_SCALE);
    });
});
describe('chatFontScaleActionForEvent', ()=>{
    it('maps Cmd+= to increase on Mac', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '=',
            metaKey: true
        }), true)).toBe('increase');
    });
    it('maps Cmd++ (shifted equals) to increase on Mac', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '+',
            metaKey: true
        }), true)).toBe('increase');
    });
    it('maps Cmd+- to decrease on Mac', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '-',
            metaKey: true
        }), true)).toBe('decrease');
    });
    it('maps Cmd+0 to reset on Mac', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '0',
            metaKey: true
        }), true)).toBe('reset');
    });
    it('maps Ctrl+= to increase on Windows/Linux', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '=',
            ctrlKey: true
        }), false)).toBe('increase');
    });
    it('ignores the wrong primary modifier on Mac', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '=',
            ctrlKey: true
        }), true)).toBeNull();
    });
    it('ignores Cmd+Ctrl chords', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '=',
            metaKey: true,
            ctrlKey: true
        }), true)).toBeNull();
    });
    it('returns null for an unrelated key', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: 'a',
            metaKey: true
        }), true)).toBeNull();
    });
    it('returns null without a primary modifier', ()=>{
        expect(chatFontScaleActionForEvent(combo({
            key: '='
        }), true)).toBeNull();
    });
});
describe('chatFontScaleShortcutLabels', ()=>{
    it('uses Cmd glyphs on Mac', ()=>{
        expect(chatFontScaleShortcutLabels(true)).toEqual({
            increase: '⌘+',
            decrease: '⌘-',
            reset: '⌘0'
        });
    });
    it('uses Ctrl+ text elsewhere', ()=>{
        expect(chatFontScaleShortcutLabels(false)).toEqual({
            increase: 'Ctrl++',
            decrease: 'Ctrl+-',
            reset: 'Ctrl+0'
        });
    });
});
it('default scale sits inside the band', ()=>{
    expect(DEFAULT_CHAT_FONT_SCALE).toBeGreaterThanOrEqual(MIN_CHAT_FONT_SCALE);
    expect(DEFAULT_CHAT_FONT_SCALE).toBeLessThanOrEqual(MAX_CHAT_FONT_SCALE);
});
