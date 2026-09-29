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
import { sessionOptionValueIsValid } from "./agent-session-option-catalog.js";
import { encodeStructuredAgentSessionOptionValue } from "./structured-agent-session-option-codec.js";
export function resolveNativeChatSessionOptionDefaults(persisted, agent) {
    const entry = persisted?.[agent];
    const modelId = typeof entry?.model === 'string' && entry.model.trim() ? entry.model : undefined;
    if (!modelId) {
        return undefined;
    }
    const values = {
        model: modelId
    };
    const storedValues = entry?.valuesByModel?.[modelId];
    if (storedValues && typeof storedValues === 'object') {
        for (const [id, value] of Object.entries(storedValues)){
            if (sessionOptionValueIsValid(value)) {
                values[id] = value;
            }
        }
    }
    return values;
}
export const STRUCTURED_LAUNCH_SEED_OPTION_IDS = [
    'model',
    'effort',
    'fastMode'
];
export function narrowStructuredLaunchSeedOptions(values) {
    const seeded = {};
    for (const id of STRUCTURED_LAUNCH_SEED_OPTION_IDS){
        const value = values?.[id];
        if ((id === 'model' || id === 'effort') && !(typeof value === 'string' && value.trim())) {
            continue;
        }
        if (typeof value === 'string' || typeof value === 'boolean') {
            const encoded = encodeStructuredAgentSessionOptionValue(id, value);
            if (encoded !== null) {
                seeded[id] = encoded;
            }
        }
    }
    return Object.keys(seeded).length > 0 ? seeded : undefined;
}
export function resolveStructuredLaunchSeedOptions(persisted, agent) {
    return narrowStructuredLaunchSeedOptions(resolveNativeChatSessionOptionDefaults(persisted, agent));
}
export function applyNativeChatSessionOptionPicks(args) {
    let persisted = args.persisted ?? {};
    for (const pick of args.picks){
        persisted = updateNativeChatSessionOptionDefaults({
            persisted,
            agent: args.agent,
            ...pick
        });
    }
    return persisted;
}
export function applyNativeChatSessionOptionSettingsMutation(persisted, mutation) {
    if (mutation.type === 'apply-picks') {
        return applyNativeChatSessionOptionPicks({
            persisted,
            agent: mutation.agent,
            picks: mutation.picks
        });
    }
    const modelId = persisted?.[mutation.agent]?.model;
    if (!modelId || mutation.availableModelIds.includes(modelId)) {
        return null;
    }
    return clearNativeChatSessionOptionModel(persisted, mutation.agent);
}
export function clearNativeChatSessionOptionModel(persisted, agent) {
    const currentAgent = persisted?.[agent];
    if (!currentAgent?.model) {
        return {
            ...persisted
        };
    }
    const { model: _dropped, ...rest } = currentAgent;
    return {
        ...persisted,
        [agent]: rest
    };
}
export function updateNativeChatSessionOptionDefaults(args) {
    const currentAgent = args.persisted?.[args.agent];
    const currentModelValues = currentAgent?.valuesByModel?.[args.modelId] ?? {};
    const valuesByModel = {
        ...currentAgent?.valuesByModel,
        ...args.optionId === 'model' ? {} : {
            [args.modelId]: {
                ...currentModelValues,
                [args.optionId]: args.value
            }
        }
    };
    return {
        ...args.persisted,
        [args.agent]: {
            ...currentAgent,
            ...args.adoptModelAsLaunchDefault === false ? {} : {
                model: args.optionId === 'model' ? String(args.value) : args.modelId
            },
            valuesByModel
        }
    };
}
