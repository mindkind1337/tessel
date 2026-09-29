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
import { assertJsonTextStructureWithinLimits } from "./json-text-structure-limit.js";
export const CLAUDE_MODEL_LIST_STDIN = `${JSON.stringify({
    type: 'control_request',
    request_id: 'orca-model-discovery',
    request: {
        subtype: 'list_models'
    }
})}\n`;
export const CLAUDE_MODEL_LIST_ARGS = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose'
];
const CLAUDE_MODEL_LIST_JSON_LIMITS = {
    structuralTokens: 64 * 1024,
    nestingDepth: 16
};
function toListedModel(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const raw = value;
    const id = typeof raw.value === 'string' ? raw.value.trim() : '';
    if (!id || raw.disabled === true) {
        return null;
    }
    const label = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id;
    const description = typeof raw.description === 'string' && raw.description.trim() ? raw.description : undefined;
    const effortLevels = raw.supportsEffort === true && Array.isArray(raw.supportedEffortLevels) ? raw.supportedEffortLevels.filter((level)=>typeof level === 'string') : [];
    return {
        id,
        label,
        ...description ? {
            description
        } : {},
        effortLevels,
        supportsFastMode: raw.supportsFastMode === true
    };
}
export function parseClaudeModelList(stdout) {
    for (const rawLine of stdout.split(/\r?\n/)){
        const line = rawLine.trim();
        if (!line.startsWith('{') || !line.includes('control_response')) {
            continue;
        }
        let parsed;
        try {
            assertJsonTextStructureWithinLimits(line, CLAUDE_MODEL_LIST_JSON_LIMITS);
            parsed = JSON.parse(line);
        } catch  {
            continue;
        }
        if (parsed.type !== 'control_response' || parsed.response?.subtype !== 'success') {
            continue;
        }
        const models = parsed.response.response?.models;
        if (!Array.isArray(models)) {
            continue;
        }
        const seen = new Set();
        const listed = [];
        for (const entry of models){
            const model = toListedModel(entry);
            if (!model || model.id === 'default' || seen.has(model.id)) {
                continue;
            }
            seen.add(model.id);
            listed.push(model);
        }
        if (listed.length > 0) {
            return listed;
        }
    }
    return [];
}
