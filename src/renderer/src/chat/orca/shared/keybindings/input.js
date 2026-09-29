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
import { t } from "../../../../i18n/index.js";
import { getKeybindingPlatform, isDigitIndexActionId } from "./definitions.js";
import { canonicalizeDigitIndexBinding, normalizeKeybindingWithOptions, normalizeOptionsForAction } from "./normalization.js";
import { hasModifier, normalizeKeyToken } from "./parser.js";
const MODIFIER_KEYS = new Set([
    'Alt',
    'AltGraph',
    'Control',
    'Meta',
    'Shift',
    'OS',
    'Fn',
    'FnLock',
    'Hyper',
    'Super',
    'Symbol',
    'SymbolLock'
]);
export const PUNCTUATION_KEY_TOKENS = new Set([
    'BracketLeft',
    'BracketRight',
    'Minus',
    'Underscore',
    'Equal',
    'Plus',
    'Comma',
    'Period',
    'Slash',
    'Backslash',
    'Semicolon',
    'Quote',
    'Backquote'
]);
export function isPunctuationKeyToken(token) {
    return token !== null && PUNCTUATION_KEY_TOKENS.has(token);
}
const PHYSICAL_CODE_FALLBACK_KEYS = new Set([
    '',
    'Dead',
    'Unidentified'
]);
const SHIFTED_PUNCTUATION_KEY_TOKENS = {
    '<': 'Comma',
    '>': 'Period',
    '?': 'Slash',
    '|': 'Backslash',
    ':': 'Semicolon',
    '"': 'Quote',
    '~': 'Backquote'
};
export function logicalKeyTokenFromInput(input) {
    const key = input.key ?? '';
    if (MODIFIER_KEYS.has(key)) {
        return null;
    }
    const normalizedKey = normalizeKeyToken(key);
    if (normalizedKey) {
        return normalizedKey;
    }
    if (hasModifier(input, 'shift')) {
        return SHIFTED_PUNCTUATION_KEY_TOKENS[key] ?? null;
    }
    return null;
}
export function canUsePhysicalCodeFallback(input) {
    return PHYSICAL_CODE_FALLBACK_KEYS.has(input.key ?? '');
}
export function isLatinShortcutKey(key) {
    if (key.length !== 1) {
        return false;
    }
    const upper = key.toUpperCase();
    return upper >= 'A' && upper <= 'Z' || key >= '0' && key <= '9';
}
export function shouldUseNonLatinShortcutPhysicalFallback(input, platform) {
    if (getKeybindingPlatform(platform) === 'darwin') {
        return false;
    }
    const hasPrimaryModifier = hasModifier(input, 'control') || hasModifier(input, 'meta');
    if (!hasPrimaryModifier) {
        return false;
    }
    if (hasModifier(input, 'control') && hasModifier(input, 'alt')) {
        return false;
    }
    if (logicalKeyTokenFromInput(input) !== null) {
        return false;
    }
    const key = input.key ?? '';
    return key !== '' && !MODIFIER_KEYS.has(key) && !isLatinShortcutKey(key);
}
export function canFallBackToPhysicalCode(input, platform) {
    return canUsePhysicalCodeFallback(input) || shouldUseNonLatinShortcutPhysicalFallback(input, platform);
}
export function physicalCodeKeyTokenFromInput(input) {
    const code = input.code ?? '';
    if (code.startsWith('Key') && code.length === 4) {
        return code.slice(3).toUpperCase();
    }
    if (code.startsWith('Digit') && code.length === 6) {
        return code.slice(5);
    }
    return normalizeKeyToken(code);
}
export function numpadCodeKeyTokenFromInput(input) {
    const code = input.code ?? '';
    return code === 'NumpadAdd' || code === 'NumpadSubtract' ? normalizeKeyToken(code) : null;
}
export function shouldUseMacOptionComposedCaptureFallback(input, platform) {
    if (getKeybindingPlatform(platform) !== 'darwin' || !hasModifier(input, 'alt') || MODIFIER_KEYS.has(input.key ?? '')) {
        return false;
    }
    const physicalToken = physicalCodeKeyTokenFromInput(input);
    if (!physicalToken) {
        return false;
    }
    return physicalToken.length === 1 && physicalToken >= 'A' && physicalToken <= 'Z' || isPunctuationKeyToken(physicalToken);
}
export function keyTokenFromInput(input, platform) {
    const numpadKey = numpadCodeKeyTokenFromInput(input);
    if (numpadKey) {
        return numpadKey;
    }
    const logicalKey = logicalKeyTokenFromInput(input);
    if (logicalKey) {
        return logicalKey;
    }
    if (!canUsePhysicalCodeFallback(input) && !shouldUseMacOptionComposedCaptureFallback(input, platform) && !shouldUseNonLatinShortcutPhysicalFallback(input, platform)) {
        return null;
    }
    return physicalCodeKeyTokenFromInput(input);
}
export function canonicalDoubleTapToken(modifier, platform) {
    const isMac = platform === 'darwin';
    if (modifier === 'Cmd' && isMac) {
        return 'Mod';
    }
    if (modifier === 'Ctrl' && !isMac) {
        return 'Mod';
    }
    return modifier;
}
export function keybindingFromInputWithOptions(input, platform, options = {}) {
    if (input.doubleTapModifier) {
        return normalizeKeybindingWithOptions(`DoubleTap+${canonicalDoubleTapToken(input.doubleTapModifier, platform)}`, options); // i18n-ignore
    }
    const key = keyTokenFromInput(input, platform);
    if (!key) {
        return {
            ok: false,
            error: t("chat.orca.copy.press_a_key_not_only_a_modifier", "Press a key, not only a modifier.")
        };
    }
    const isMac = getKeybindingPlatform(platform) === 'darwin';
    const parts = [];
    const primaryModifierPressed = isMac ? hasModifier(input, 'meta') : hasModifier(input, 'control');
    if (primaryModifierPressed) {
        parts.push('Mod');
    }
    if (isMac && hasModifier(input, 'control')) {
        parts.push('Ctrl');
    }
    if (!isMac && hasModifier(input, 'meta')) {
        parts.push('Cmd');
    }
    if (hasModifier(input, 'alt')) {
        parts.push('Alt');
    }
    if (hasModifier(input, 'shift')) {
        parts.push('Shift');
    }
    parts.push(key);
    return normalizeKeybindingWithOptions(parts.join('+'), options);
}
export function keybindingFromInput(input, platform) {
    return keybindingFromInputWithOptions(input, platform);
}
export function keybindingFromInputForAction(actionId, input, platform) {
    const result = keybindingFromInputWithOptions(input, platform, normalizeOptionsForAction(actionId));
    if (!result.ok || !isDigitIndexActionId(actionId)) {
        return result;
    }
    return canonicalizeDigitIndexBinding(result.value);
}
