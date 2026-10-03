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
import { isMacPlatform } from "./native-chat-shortcut.js";
export const MIN_CHAT_FONT_SCALE = 0.8;
export const MAX_CHAT_FONT_SCALE = 1.6;
export const DEFAULT_CHAT_FONT_SCALE = 1;
export const CHAT_FONT_SCALE_STEP = 0.1;
export function clampChatFontScale(scale) {
    const clamped = Math.min(MAX_CHAT_FONT_SCALE, Math.max(MIN_CHAT_FONT_SCALE, scale));
    return Math.round(clamped * 100) / 100;
}
export function increaseChatFontScale(scale) {
    return clampChatFontScale(scale + CHAT_FONT_SCALE_STEP);
}
export function decreaseChatFontScale(scale) {
    return clampChatFontScale(scale - CHAT_FONT_SCALE_STEP);
}
export function chatFontScaleActionForEvent(e, isMac) {
    const primary = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!primary) {
        return null;
    }
    // Tessel: the key's place (code) for 0 and the keypad, so AZERTY's top
    // row works (Ctrl+0 gives "à"); "_" only from the minus key itself (on
    // AZERTY it is Ctrl+8).
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'Digit0' || code === 'Numpad0') return 'reset';
    if (code === 'NumpadAdd') return 'increase';
    if (code === 'NumpadSubtract') return 'decrease';
    switch(e.key){
        case '=':
        case '+':
            return 'increase';
        case '-':
            return 'decrease';
        case '_':
            return !code || code === 'Minus' ? 'decrease' : null;
        case '0':
            return 'reset';
        default:
            return null;
    }
}
export function chatFontScaleShortcutLabels(isMac = isMacPlatform()) {
    const mod = isMac ? '⌘' : 'Ctrl+';
    return {
        increase: `${mod}+`,
        decrease: `${mod}-`,
        reset: `${mod}0`
    };
}
