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
// Internal parser diagnostics.
export class JsonTextStructureCapacityError extends Error {
    resource;
    limit;
    constructor(resource, limit){
        super(resource === 'structuralTokens' ? `JSON structure exceeds ${limit} tokens` : `JSON nesting exceeds ${limit} levels`), this.resource = resource, this.limit = limit; // i18n-ignore
        this.name = 'JsonTextStructureCapacityError';
    }
}
export function assertJsonTextStructureWithinLimits(content, limits) {
    assertLimit(limits.structuralTokens);
    assertLimit(limits.nestingDepth);
    let structuralTokens = 0;
    let depth = 0;
    for(let index = 0; index < content.length; index += 1){
        const character = content[index];
        if (character === '"') {
            let quote = content.indexOf('"', index + 1);
            if (quote !== -1) {
                let backslashes = 0;
                for(let at = quote - 1; at > index && content[at] === '\\'; at -= 1){
                    backslashes += 1;
                }
                if (backslashes % 2 !== 0) {
                    let escaped = false;
                    for(quote += 1; quote < content.length; quote += 1){
                        if (escaped) {
                            escaped = false;
                        } else if (content[quote] === '\\') {
                            escaped = true;
                        } else if (content[quote] === '"') {
                            break;
                        }
                    }
                    if (quote === content.length) {
                        quote = -1;
                    }
                }
            }
            if (quote === -1) {
                return;
            }
            index = quote;
            continue;
        }
        if (!isStructuralToken(character)) {
            continue;
        }
        structuralTokens += 1;
        if (structuralTokens > limits.structuralTokens) {
            throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens);
        }
        if (character === '{' || character === '[') {
            depth += 1;
            if (depth > limits.nestingDepth) {
                throw new JsonTextStructureCapacityError('nestingDepth', limits.nestingDepth);
            }
        } else if (character === '}' || character === ']') {
            depth = Math.max(0, depth - 1);
        }
    }
}
function assertLimit(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('JSON structure limits must be non-negative safe integers');
    }
}
function isStructuralToken(character) {
    return character === '{' || character === '}' || character === '[' || character === ']' || character === ',' || character === ':';
}
