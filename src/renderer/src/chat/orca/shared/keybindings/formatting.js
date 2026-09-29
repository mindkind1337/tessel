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
import { KEYBINDING_DEFINITIONS, isDigitIndexActionId, isKeybindingActionId } from "./definitions.js";
import { parseKeybinding } from "./parser.js";
import { getEffectiveKeybindingsForAction, getEffectiveKeybindingsForDefinition } from "./effective.js";
import { isDoubleTapBinding } from "./normalization.js";
import { getKeybindingConflictIdentity, keybindingConflictIdentities } from "./matching.js";
function formatModifierGlyph(modifier, isMac) {
    switch(modifier){
        case 'Mod':
            return isMac ? '⌘' : 'Ctrl';
        case 'Cmd':
            return isMac ? '⌘' : 'Cmd';
        case 'Ctrl':
            return isMac ? '⌃' : 'Ctrl';
        case 'Alt':
            return isMac ? '⌥' : 'Alt';
        case 'Shift':
            return isMac ? '⇧' : 'Shift';
    }
}
export function formatKeybinding(binding, platform) {
    const parsed = parseKeybinding(binding);
    if (!parsed) {
        return [
            binding
        ];
    }
    const isMac = platform === 'darwin';
    if (parsed.doubleTapModifier) {
        const glyph = formatModifierGlyph(parsed.doubleTapModifier, isMac);
        return [
            glyph,
            glyph
        ];
    }
    const parts = [];
    if (parsed.mod) {
        parts.push(isMac ? '⌘' : 'Ctrl');
    }
    if (parsed.meta) {
        parts.push(isMac ? '⌘' : 'Cmd');
    }
    if (parsed.control) {
        parts.push(isMac ? '⌃' : 'Ctrl');
    }
    if (parsed.alt) {
        parts.push(isMac ? '⌥' : 'Alt');
    }
    if (parsed.shift) {
        parts.push(isMac ? '⇧' : 'Shift');
    }
    parts.push(formatKeyToken(parsed.key, isMac));
    return parts;
}
export function formatKeybindingList(bindings, platform) {
    if (bindings.length === 0) {
        return 'Unassigned';
    }
    return bindings.map((binding)=>{
        const separator = isDoubleTapBinding(binding) ? ' ' : platform === 'darwin' ? '' : '+';
        return formatKeybinding(binding, platform).join(separator);
    }).join(', ');
}
export function findKeybindingActionsForBinding(binding, platform, overrides, scopes = [
    'global',
    'tabs'
]) {
    const identity = getKeybindingConflictIdentity(binding, platform);
    const allowedScopes = new Set(scopes);
    return KEYBINDING_DEFINITIONS.filter((definition)=>allowedScopes.has(definition.scope) && getEffectiveKeybindingsForAction(definition.id, platform, overrides).some((candidate)=>keybindingConflictIdentities(definition.id, candidate, platform).includes(identity))).map((definition)=>definition.id);
}
const KEY_TOKEN_LABELS = {
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Underscore: '_',
    Equal: '=',
    Plus: '+',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    NumpadAdd: 'Numpad +',
    NumpadSubtract: 'Numpad -',
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Tab: 'Tab',
    Escape: 'Esc',
    Space: 'Space'
};
const MAC_KEY_TOKEN_LABELS = {
    ...KEY_TOKEN_LABELS,
    Backspace: '⌫'
};
function formatKeyToken(token, isMac) {
    return (isMac ? MAC_KEY_TOKEN_LABELS : KEY_TOKEN_LABELS)[token] ?? token;
}
export function findKeybindingConflicts(platform, overrides, options = {}) {
    return findKeybindingConflictsForDefinitions(KEYBINDING_DEFINITIONS, platform, overrides, options);
}
export function findKeybindingConflictsForDefinitions(definitions, platform, overrides, options = {}) {
    const owners = new Map();
    const ignoredActionIds = new Set(options.ignoredActionIds ?? []);
    const customizedActions = new Set(Object.keys(overrides ?? {}).filter((actionId)=>isKeybindingActionId(actionId) && !ignoredActionIds.has(actionId)));
    for (const actionId of options.relevantActionIds ?? []){
        if (!ignoredActionIds.has(actionId)) {
            customizedActions.add(actionId);
        }
    }
    for (const definition of definitions){
        if (ignoredActionIds.has(definition.id)) {
            continue;
        }
        for (const binding of getEffectiveKeybindingsForDefinition(definition, platform, overrides)){
            const groups = new Set([
                definition.conflictGroup ?? definition.scope
            ]);
            if (definition.conflictGroup) {
                groups.add(definition.scope);
            }
            for (const group of groups){
                for (const identity of keybindingConflictIdentities(definition.id, binding, platform)){
                    const conflictKey = `${group}\u0000${identity}`;
                    const current = owners.get(conflictKey) ?? {
                        binding,
                        actionIds: new Set()
                    };
                    if (!isDigitIndexActionId(definition.id) && Array.from(current.actionIds).some((actionId)=>isDigitIndexActionId(actionId))) {
                        current.binding = binding;
                    }
                    current.actionIds.add(definition.id);
                    owners.set(conflictKey, current);
                }
            }
        }
    }
    const seenConflictKeys = new Set();
    return Array.from(owners.values()).filter(({ actionIds })=>actionIds.size > 1 && setIntersects(actionIds, customizedActions)).map(({ binding, actionIds })=>({
            binding,
            actionIds: Array.from(actionIds)
        })).filter((conflict)=>{
        const key = `${conflict.binding}\u0000${conflict.actionIds.join('\u0000')}`;
        if (seenConflictKeys.has(key)) {
            return false;
        }
        seenConflictKeys.add(key);
        return true;
    });
}
function setIntersects(left, right) {
    for (const value of left){
        if (right.has(value)) {
            return true;
        }
    }
    return false;
}
