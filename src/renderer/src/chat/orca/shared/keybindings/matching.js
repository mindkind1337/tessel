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
import { DEFINITIONS_BY_ID, DIGIT_INDEX_KEY_PATTERN, isDigitIndexActionId } from "./definitions.js";
import { canonicalizeParsedKeybinding, parseKeybinding } from "./parser.js";
import { platformModifiers, modifierStateMatches, keyMatches, digitKeyMatches, resolveModifierToken } from "./matching-key.js";
import { getEffectiveKeybindingsForAction, keybindingIsActiveInContext } from "./effective.js";
export function keybindingMatchesInput(binding, input, platform) {
    const parsed = parseKeybinding(binding);
    if (!parsed) {
        return false;
    }
    if (parsed.doubleTapModifier) {
        return input.doubleTapModifier !== undefined && resolveModifierToken(parsed.doubleTapModifier, platform) === resolveModifierToken(input.doubleTapModifier, platform);
    }
    if (input.doubleTapModifier !== undefined) {
        return false;
    }
    return modifierStateMatches(parsed, input, platform) && keyMatches(parsed.key, input, parsed, platform);
}
export function keybindingConflictIdentityForParsed(parsed, platform) {
    if (parsed.doubleTapModifier) {
        return `DoubleTap:${resolveModifierToken(parsed.doubleTapModifier, platform)}`; // i18n-ignore
    }
    const modifiers = platformModifiers(parsed, platform);
    return [
        modifiers.meta ? 'Meta' : '',
        modifiers.control ? 'Control' : '',
        modifiers.alt ? 'Alt' : '',
        modifiers.shift ? 'Shift' : '',
        parsed.key
    ].join('+');
}
export function getKeybindingConflictIdentity(binding, platform) {
    const parsed = parseKeybinding(binding);
    return parsed ? keybindingConflictIdentityForParsed(parsed, platform) : binding;
}
export function keybindingConflictIdentities(actionId, binding, platform) {
    const exact = getKeybindingConflictIdentity(binding, platform);
    if (!isDigitIndexActionId(actionId)) {
        return [
            exact
        ];
    }
    const parsed = parseKeybinding(binding);
    if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
        return [
            exact
        ];
    }
    return Array.from({
        length: 9
    }, (_, index)=>keybindingConflictIdentityForParsed({
            ...parsed,
            key: String(index + 1)
        }, platform));
}
export function keybindingMatchesAction(actionId, input, platform, overrides, options = {}) {
    const definition = DEFINITIONS_BY_ID.get(actionId);
    if (!definition) {
        return false;
    }
    if (!keybindingIsActiveInContext(definition, options)) {
        return false;
    }
    return getEffectiveKeybindingsForAction(actionId, platform, overrides).some((binding)=>keybindingMatchesInput(binding, input, platform));
}
export function digitFromInput(input, platform) {
    for(let value = 1; value <= 9; value++){
        const digit = String(value);
        if (digitKeyMatches(input, digit, platform)) {
            return digit;
        }
    }
    return null;
}
export function matchKeybindingDigitIndex(actionId, input, platform, overrides, options = {}) {
    const definition = DEFINITIONS_BY_ID.get(actionId);
    if (!definition || !keybindingIsActiveInContext(definition, options)) {
        return null;
    }
    const digit = digitFromInput(input, platform);
    if (!digit) {
        return null;
    }
    for (const binding of getEffectiveKeybindingsForAction(actionId, platform, overrides)){
        const parsed = parseKeybinding(binding);
        if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
            continue;
        }
        const candidate = canonicalizeParsedKeybinding({
            ...parsed,
            key: digit
        });
        if (keybindingMatchesInput(candidate, input, platform)) {
            return Number(digit) - 1;
        }
    }
    return null;
}
