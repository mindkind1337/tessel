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
import { DEFINITIONS_BY_ID, DIGIT_INDEX_KEY_PATTERN, isDigitIndexActionId } from "./definitions.js";
import { canonicalizeParsedKeybinding, isSafeBareKey, parseKeybinding } from "./parser.js";
export function normalizeKeybindingWithOptions(binding, options = {}) {
    const parsed = parseKeybinding(binding);
    if (!parsed) {
        return {
            ok: false,
            error: t("chat.orca.copy.use_a_shortcut_like_ctrl_shift_p_or_cmd_k", "Use a shortcut like Ctrl+Shift+P or Cmd+K.")
        };
    }
    if (parsed.mod && (parsed.meta || parsed.control)) {
        return {
            ok: false,
            error: t("chat.orca.copy.use_either_mod_or_a_platform_specific_modifier_not_both", "Use either Mod or a platform-specific modifier, not both.")
        };
    }
    if (parsed.doubleTapModifier) {
        return {
            ok: true,
            value: canonicalizeParsedKeybinding(parsed)
        };
    }
    const isShiftInsert = parsed.shift && parsed.key === 'Insert';
    const isBareAllowed = options.allowBareKeybindings === true && isSafeBareKey(parsed);
    const isShiftOnlyAllowed = options.allowShiftOnlyKeybindings === true && parsed.shift && !parsed.mod && !parsed.meta && !parsed.control && !parsed.alt;
    if (!parsed.mod && !parsed.meta && !parsed.control && !parsed.alt && !isShiftInsert && !isBareAllowed && !isShiftOnlyAllowed) {
        return {
            ok: false,
            error: t("chat.orca.copy.include_at_least_one_modifier_key", "Include at least one modifier key.")
        };
    }
    return {
        ok: true,
        value: canonicalizeParsedKeybinding(parsed)
    };
}
export function normalizeKeybinding(binding) {
    return normalizeKeybindingWithOptions(binding);
}
export function isDoubleTapBinding(binding) {
    return Boolean(parseKeybinding(binding)?.doubleTapModifier);
}
export function normalizeKeybindingListWithOptions(input, options = {}) {
    const trimmed = input.trim();
    if (!trimmed) {
        return [];
    }
    const normalized = [];
    for (const piece of trimmed.split(',')){
        const result = normalizeKeybindingWithOptions(piece, options);
        if (!result.ok) {
            return result;
        }
        if (!normalized.includes(result.value)) {
            normalized.push(result.value);
        }
    }
    return normalized;
}
export function normalizeKeybindingList(input) {
    return normalizeKeybindingListWithOptions(input);
}
export function normalizeKeybindingArrayWithOptions(input, options = {}) {
    const normalized = [];
    for (const binding of input){
        const piece = normalizeKeybindingListWithOptions(binding, options);
        if (!Array.isArray(piece)) {
            return piece;
        }
        for (const normalizedBinding of piece){
            if (!normalized.includes(normalizedBinding)) {
                normalized.push(normalizedBinding);
            }
        }
    }
    return normalized;
}
export function normalizeOptionsForAction(actionId) {
    const definition = DEFINITIONS_BY_ID.get(actionId);
    return {
        allowBareKeybindings: definition?.allowBareKeybindings === true,
        allowShiftOnlyKeybindings: definition?.allowShiftOnlyKeybindings === true
    };
}
export function canonicalizeDigitIndexBinding(binding) {
    const parsed = parseKeybinding(binding);
    if (!parsed || parsed.doubleTapModifier || !DIGIT_INDEX_KEY_PATTERN.test(parsed.key)) {
        return {
            ok: false,
            error: t("chat.orca.copy.pick_a_number_key_1_9_with_a_modifier_like_cmd_1_or_ctrl_1", "Pick a number key 1–9 with a modifier, like Cmd+1 or Ctrl+1.")
        };
    }
    return {
        ok: true,
        value: canonicalizeParsedKeybinding({
            ...parsed,
            key: '1'
        })
    };
}
export function finalizeDigitIndexBindings(actionId, result) {
    if (!isDigitIndexActionId(actionId) || !Array.isArray(result)) {
        return result;
    }
    const canonical = [];
    for (const binding of result){
        const normalized = canonicalizeDigitIndexBinding(binding);
        if (!normalized.ok) {
            return normalized;
        }
        if (!canonical.includes(normalized.value)) {
            canonical.push(normalized.value);
        }
    }
    return canonical;
}
export function normalizeKeybindingListForAction(actionId, input) {
    return finalizeDigitIndexBindings(actionId, normalizeKeybindingListWithOptions(input, normalizeOptionsForAction(actionId)));
}
export function normalizeKeybindingArrayForAction(actionId, input) {
    return finalizeDigitIndexBindings(actionId, normalizeKeybindingArrayWithOptions(input, normalizeOptionsForAction(actionId)));
}
