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
import { getAgentSessionOptionCatalog, mergeCatalogModels, mergeDiscoveredAuthoritativeModels } from "./shared/agent-session-option-catalog.js";
import { resolveNativeChatSessionOptionDefaults } from "./shared/native-chat-session-option-defaults.js";
const enrichmentByAgentHost = new Map();
export const NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES = 256;
function retainEnrichmentEntry(key, entry) {
    enrichmentByAgentHost.delete(key);
    enrichmentByAgentHost.set(key, entry);
    while(enrichmentByAgentHost.size > NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES){
        const evictable = [
            ...enrichmentByAgentHost
        ].find(([, candidate])=>candidate.listeners.size === 0 && candidate.state !== 'pending');
        if (!evictable) {
            return;
        }
        enrichmentByAgentHost.delete(evictable[0]);
    }
}
function enrichmentKey(agent, hostKey) {
    return JSON.stringify([
        agent,
        hostKey
    ]);
}
export function readNativeChatEnrichedModels(agent, hostKey) {
    const models = enrichmentByAgentHost.get(enrichmentKey(agent, hostKey))?.models;
    return models ? [
        ...models
    ] : null;
}
export function subscribeNativeChatEnrichedModels(agent, hostKey, listener) {
    const key = enrichmentKey(agent, hostKey);
    const entry = enrichmentByAgentHost.get(key) ?? {
        agent,
        state: 'idle',
        models: null,
        listeners: new Set()
    };
    entry.listeners.add(listener);
    retainEnrichmentEntry(key, entry);
    return ()=>entry.listeners.delete(listener);
}
export function resolveNativeChatLaunchSessionOptions(persisted, agent) {
    const values = resolveNativeChatSessionOptionDefaults(persisted, agent);
    if (!values || !getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative) {
        return values;
    }
    let probed = false;
    for (const entry of enrichmentByAgentHost.values()){
        if (entry.agent === agent && entry.models) {
            probed = true;
            if (entry.models.some((model)=>model.id === values.model)) {
                return values;
            }
        }
    }
    return probed ? undefined : values;
}
export function ensureNativeChatModelEnrichment(args) {
    const catalog = getAgentSessionOptionCatalog(args.agent);
    if (!catalog?.listModels) {
        return;
    }
    const key = enrichmentKey(args.agent, args.hostKey);
    const existing = enrichmentByAgentHost.get(key);
    if (existing?.state === 'pending' || existing?.state === 'settled') {
        return;
    }
    const entry = existing ?? {
        agent: args.agent,
        state: 'idle',
        models: null,
        listeners: new Set()
    };
    entry.state = 'pending';
    retainEnrichmentEntry(key, entry);
    void args.discover().then((discovered)=>{
        entry.state = 'settled';
        retainEnrichmentEntry(key, entry);
        if (!discovered || discovered.length === 0) {
            return;
        }
        entry.models = args.agent === 'claude' ? [
            ...discovered
        ] : catalog.discoveredModelsAreAuthoritative ? mergeDiscoveredAuthoritativeModels(catalog.models, discovered) : mergeCatalogModels(catalog.models, discovered);
        for (const listener of entry.listeners){
            listener([
                ...entry.models
            ]);
        }
    }).catch(()=>{
        entry.state = 'settled';
        retainEnrichmentEntry(key, entry);
    });
}
export function clearNativeChatModelEnrichmentForTests() {
    enrichmentByAgentHost.clear();
}
export function getNativeChatModelEnrichmentEntryCountForTests() {
    return enrichmentByAgentHost.size;
}
