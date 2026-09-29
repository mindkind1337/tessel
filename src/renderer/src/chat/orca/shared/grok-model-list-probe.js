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
// CLI output marker used for parsing.
import { labelFromModelId } from "./model-id-label.js";
export const GROK_MODEL_LIST_ARGS = [
    'models'
];
const AVAILABLE_MODELS_HEADER = 'Available models:'; // i18n-ignore
const MODEL_BULLET = /^\s*[*-]\s+([^\s(]+)(.*)$/;
const DEFAULT_MARKER = /\(default\)/;
export function parseGrokModelList(stdout) {
    const lines = stdout.split(/\r?\n/);
    const headerIndex = lines.findIndex((line)=>line.trim() === AVAILABLE_MODELS_HEADER);
    if (headerIndex === -1) {
        return [];
    }
    const byId = new Map();
    for (const line of lines.slice(headerIndex + 1)){
        if (line.trim() === '' && byId.size > 0) {
            break;
        }
        const match = MODEL_BULLET.exec(line);
        const id = match?.[1];
        if (!id) {
            continue;
        }
        const model = byId.get(id) ?? {
            id,
            label: labelFromModelId(id)
        };
        if (DEFAULT_MARKER.test(match[2])) {
            model.isDefault = true;
        }
        byId.set(id, model);
    }
    return [
        ...byId.values()
    ];
}
