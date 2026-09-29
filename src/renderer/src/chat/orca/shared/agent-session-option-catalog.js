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
import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from "./agent-session-option-catalog-antigravity.js";
import { CLAUDE_SESSION_OPTION_CATALOG, CODEX_SESSION_OPTION_CATALOG, createClaudeCatalogOptions } from "./agent-session-option-catalog-claude-codex.js";
import { CURSOR_SESSION_OPTION_CATALOG, GEMINI_SESSION_OPTION_CATALOG } from "./agent-session-option-catalog-gemini-cursor.js";
import { GROK_SESSION_OPTION_CATALOG } from "./agent-session-option-catalog-grok.js";
import { MUSE_SESSION_OPTION_CATALOG } from "./agent-session-option-catalog-muse.js";
import { OMP_SESSION_OPTION_CATALOG } from "./agent-session-option-catalog-omp.js";
export { createClaudeCatalogOptions };
const CATALOGS = {
    antigravity: ANTIGRAVITY_SESSION_OPTION_CATALOG,
    claude: CLAUDE_SESSION_OPTION_CATALOG,
    codex: CODEX_SESSION_OPTION_CATALOG,
    gemini: GEMINI_SESSION_OPTION_CATALOG,
    cursor: CURSOR_SESSION_OPTION_CATALOG,
    grok: GROK_SESSION_OPTION_CATALOG,
    muse: MUSE_SESSION_OPTION_CATALOG,
    omp: OMP_SESSION_OPTION_CATALOG
};
export function getAgentSessionOptionCatalog(agent) {
    return CATALOGS[agent] ?? null;
}
export function findCatalogModel(catalog, modelId) {
    return catalog.models.find((model)=>model.id === modelId);
}
export function findCatalogOption(model, optionId) {
    return model?.options.find((option)=>option.id === optionId);
}
export function mergeCatalogModels(seed, discovered) {
    const discoveredById = new Map(discovered.map((model)=>[
            model.id,
            model
        ]));
    const merged = seed.map((model)=>{
        const live = discoveredById.get(model.id);
        if (!live) {
            return model;
        }
        discoveredById.delete(model.id);
        return {
            ...model,
            ...live,
            options: model.options
        };
    });
    return [
        ...merged,
        ...discoveredById.values()
    ];
}
export function mergeDiscoveredAuthoritativeModels(seed, discovered) {
    const inheritedOptions = (seed.find((model)=>model.isDefault) ?? seed[0])?.options ?? [];
    return discovered.map((disc)=>{
        const seedMatch = seed.find((model)=>model.id === disc.id);
        const { isDefault: _seeded, ...merged } = seedMatch ? {
            ...seedMatch,
            ...disc,
            options: seedMatch.options
        } : {
            ...disc,
            options: inheritedOptions
        };
        return disc.isDefault ? {
            ...merged,
            isDefault: true
        } : merged;
    });
}
export function sessionOptionValueIsValid(value) {
    return typeof value === 'string' || typeof value === 'boolean';
}
