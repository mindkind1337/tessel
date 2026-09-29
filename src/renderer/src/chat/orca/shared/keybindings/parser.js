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
export function hasModifier(input, modifier) {
    if (modifier === 'alt') {
        return Boolean(input.alt ?? input.altKey);
    }
    if (modifier === 'meta') {
        return Boolean(input.meta ?? input.metaKey);
    }
    if (modifier === 'control') {
        return Boolean(input.control ?? input.ctrlKey);
    }
    return Boolean(input.shift ?? input.shiftKey);
}
const SIMPLE_KEY_TOKENS = new Map(Object.entries({
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '-': 'Minus',
    _: 'Underscore',
    '=': 'Equal',
    '+': 'Plus',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '`': 'Backquote',
    RETURN: 'Enter',
    ESC: 'Escape',
    SPACEBAR: 'Space',
    PGUP: 'PageUp',
    PGDN: 'PageDown',
    PLUS: 'Plus',
    MINUS: 'Minus',
    EQUAL: 'Equal',
    UNDERSCORE: 'Underscore',
    ARROWLEFT: 'ArrowLeft',
    LEFT: 'ArrowLeft',
    ARROWRIGHT: 'ArrowRight',
    RIGHT: 'ArrowRight',
    ARROWUP: 'ArrowUp',
    UP: 'ArrowUp',
    ARROWDOWN: 'ArrowDown',
    DOWN: 'ArrowDown',
    PAGEUP: 'PageUp',
    PAGEDOWN: 'PageDown',
    BACKSPACE: 'Backspace',
    DELETE: 'Delete',
    DEL: 'Delete',
    INSERT: 'Insert',
    INS: 'Insert',
    ENTER: 'Enter',
    TAB: 'Tab',
    ESCAPE: 'Escape',
    SPACE: 'Space',
    BRACKETLEFT: 'BracketLeft',
    BRACKETRIGHT: 'BracketRight',
    NUMPADADD: 'NumpadAdd',
    NUMPADSUBTRACT: 'NumpadSubtract',
    ADD: 'NumpadAdd',
    SUBTRACT: 'NumpadSubtract',
    COMMA: 'Comma',
    PERIOD: 'Period',
    SLASH: 'Slash',
    BACKSLASH: 'Backslash',
    SEMICOLON: 'Semicolon',
    QUOTE: 'Quote',
    BACKQUOTE: 'Backquote'
}));
function isFunctionKeyToken(key) {
    return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}
export function normalizeKeyToken(token) {
    if (token === ' ') {
        return 'Space';
    }
    const trimmed = token.trim();
    if (!trimmed) {
        return null;
    }
    const upper = trimmed.toUpperCase();
    if (upper.length === 1 && upper >= 'A' && upper <= 'Z') {
        return upper;
    }
    if (upper.length === 1 && upper >= '0' && upper <= '9') {
        return upper;
    }
    if (isFunctionKeyToken(upper)) {
        return upper;
    }
    return SIMPLE_KEY_TOKENS.get(upper) ?? null;
}
export function parseModifierToken(rawPart) {
    const part = rawPart.toLowerCase();
    if (part === 'mod' || part === 'cmdorctrl' || part === 'commandorcontrol') {
        return 'Mod';
    }
    if (part === 'cmd' || part === 'command' || part === 'meta' || rawPart === '⌘') {
        return 'Cmd';
    }
    if (part === 'ctrl' || part === 'control' || rawPart === '⌃') {
        return 'Ctrl';
    }
    if (part === 'alt' || part === 'option' || part === 'opt' || rawPart === '⌥') {
        return 'Alt';
    }
    if (part === 'shift' || rawPart === '⇧') {
        return 'Shift';
    }
    return null;
}
export function applyModifierToken(parsed, modifier) {
    if (modifier === 'Mod') {
        parsed.mod = true;
    } else if (modifier === 'Cmd') {
        parsed.meta = true;
    } else if (modifier === 'Ctrl') {
        parsed.control = true;
    } else if (modifier === 'Alt') {
        parsed.alt = true;
    } else {
        parsed.shift = true;
    }
}
export function emptyParsedKeybinding() {
    return {
        mod: false,
        meta: false,
        control: false,
        alt: false,
        shift: false,
        key: ''
    };
}
export function parseDoubleTapKeybinding(rawParts) {
    const modifiers = [];
    let sawDoubleTap = false;
    for (const rawPart of rawParts){
        if (rawPart.toLowerCase() === 'doubletap') {
            if (sawDoubleTap) {
                return null;
            }
            sawDoubleTap = true;
            continue;
        }
        const modifier = parseModifierToken(rawPart);
        if (!modifier) {
            return null;
        }
        modifiers.push(modifier);
    }
    if (modifiers.length === 0) {
        return null;
    }
    const parsed = emptyParsedKeybinding();
    for (const modifier of modifiers){
        applyModifierToken(parsed, modifier);
    }
    if (parsed.mod && (parsed.meta || parsed.control)) {
        parsed.doubleTapModifier = 'Mod';
        return parsed;
    }
    if (modifiers.length > 1) {
        return null;
    }
    parsed.doubleTapModifier = modifiers[0];
    return parsed;
}
const PARSE_CACHE_LIMIT = 512;
const parseCache = new Map();
export function parseKeybinding(binding) {
    if (parseCache.has(binding)) {
        return parseCache.get(binding) ?? null;
    }
    const parsed = parseKeybindingUncached(binding);
    if (parseCache.size >= PARSE_CACHE_LIMIT) {
        parseCache.clear();
    }
    parseCache.set(binding, parsed ? Object.freeze(parsed) : null);
    return parsed;
}
function parseKeybindingUncached(binding) {
    const rawParts = binding.split('+').map((part)=>part.trim()).filter(Boolean);
    if (rawParts.length === 0) {
        return null;
    }
    if (rawParts.some((part)=>part.toLowerCase() === 'doubletap')) {
        return parseDoubleTapKeybinding(rawParts);
    }
    const parsed = emptyParsedKeybinding();
    for (const rawPart of rawParts){
        const modifier = parseModifierToken(rawPart);
        if (modifier) {
            applyModifierToken(parsed, modifier);
            continue;
        }
        if (parsed.key) {
            return null;
        }
        const key = normalizeKeyToken(rawPart);
        if (!key) {
            return null;
        }
        parsed.key = key;
    }
    return parsed.key ? parsed : null;
}
export function canonicalizeParsedKeybinding(parsed) {
    if (parsed.doubleTapModifier) {
        return `DoubleTap+${parsed.doubleTapModifier}`; // i18n-ignore
    }
    const parts = [];
    if (parsed.mod) {
        parts.push('Mod');
    }
    if (parsed.meta) {
        parts.push('Cmd');
    }
    if (parsed.control) {
        parts.push('Ctrl');
    }
    if (parsed.alt) {
        parts.push('Alt');
    }
    if (parsed.shift) {
        parts.push('Shift');
    }
    parts.push(parsed.key);
    return parts.join('+');
}
export function isSafeBareKey(parsed) {
    if (parsed.mod || parsed.meta || parsed.control || parsed.alt) {
        return false;
    }
    if (parsed.shift) {
        return isFunctionKeyToken(parsed.key);
    }
    return isFunctionKeyToken(parsed.key) || [
        'Backspace',
        'Delete',
        'Enter',
        'Escape',
        'Tab',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown'
    ].includes(parsed.key);
}
