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
import { labelFromModelId } from "./model-id-label.js";
export const OMP_MODEL_LIST_ARGS = [
    'models',
    '--json'
];
function parseJsonObject(stdout) {
    const trimmed = stdout.trim();
    try {
        return JSON.parse(trimmed);
    } catch  {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');
        if (start === -1 || end <= start) {
            return null;
        }
        try {
            return JSON.parse(trimmed.slice(start, end + 1));
        } catch  {
            return null;
        }
    }
}
export function parseOmpModelList(stdout) {
    const parsed = parseJsonObject(stdout);
    if (!parsed || typeof parsed !== 'object' || !('models' in parsed)) {
        return [];
    }
    const rows = parsed.models;
    if (!Array.isArray(rows)) {
        return [];
    }
    const byId = new Map();
    for (const row of rows){
        const value = row;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        const provider = 'provider' in value && typeof value.provider === 'string' ? value.provider.trim() : '';
        const bareId = 'id' in value && typeof value.id === 'string' ? value.id.trim() : '';
        const selector = 'selector' in value && typeof value.selector === 'string' ? value.selector.trim() : '';
        const id = selector || (provider && bareId ? `${provider}/${bareId}` : '');
        if (!id || byId.has(id)) {
            continue;
        }
        const name = 'name' in value && typeof value.name === 'string' ? value.name.trim() : '';
        byId.set(id, {
            id,
            label: name || labelFromModelId(id),
            ...provider ? {
                description: provider
            } : {}
        });
    }
    return [
        ...byId.values()
    ];
}
