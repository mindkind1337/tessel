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
import { DEFINITIONS_BY_ID, getKeybindingPlatform, isDigitIndexActionId } from "./definitions.js";
import { normalizeKeybindingWithOptions, normalizeOptionsForAction, canonicalizeDigitIndexBinding } from "./normalization.js";
export function getDefaultBindings(definition, platform) {
    return definition.defaultBindings[getKeybindingPlatform(platform)].map((binding)=>{
        const normalized = normalizeKeybindingWithOptions(binding, {
            allowBareKeybindings: definition.allowBareKeybindings === true,
            allowShiftOnlyKeybindings: definition.allowShiftOnlyKeybindings === true
        });
        return normalized.ok ? normalized.value : binding;
    });
}
export function getEffectiveKeybindingsForAction(actionId, platform, overrides) {
    const definition = DEFINITIONS_BY_ID.get(actionId);
    const override = overrides?.[actionId];
    if (Array.isArray(override)) {
        if (isDigitIndexActionId(actionId)) {
            const canonical = [];
            for (const binding of override){
                const normalized = canonicalizeDigitIndexBinding(binding);
                if (normalized.ok && !canonical.includes(normalized.value)) {
                    canonical.push(normalized.value);
                }
            }
            return canonical;
        }
        return override.flatMap((binding)=>{
            const normalized = normalizeKeybindingWithOptions(binding, normalizeOptionsForAction(actionId));
            return normalized.ok ? [
                normalized.value
            ] : [];
        });
    }
    return definition ? getDefaultBindings(definition, platform) : [];
}
export function getEffectiveKeybindingsForDefinition(definition, platform, overrides) {
    const override = overrides?.[definition.id];
    if (Array.isArray(override)) {
        return getEffectiveKeybindingsForAction(definition.id, platform, overrides);
    }
    return getDefaultBindings(definition, platform);
}
export function normalizeTerminalShortcutPolicy(policy) {
    return policy === 'terminal-first' ? 'terminal-first' : 'orca-first';
}
export function isKeybindingAllowedInTerminal(definition) {
    return definition.scope === 'terminal' || definition.allowInTerminal === true;
}
export function isKeybindingPotentialTerminalConflict(definition) {
    return definition.scope !== 'terminal' && definition.allowInTerminal !== true;
}
export function keybindingIsActiveInContext(definition, options = {}) {
    if (options.context !== 'terminal') {
        return true;
    }
    if (normalizeTerminalShortcutPolicy(options.terminalShortcutPolicy) === 'orca-first') {
        return true;
    }
    return isKeybindingAllowedInTerminal(definition);
}
