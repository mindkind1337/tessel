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
import { MAX_EDIT_DIFF_CELLS, splitEditContent } from "./native-chat-edit-model.js";
export function editLinesFromContents(originalContent, modifiedContent) {
    const original = splitEditContent(originalContent);
    const modified = splitEditContent(modifiedContent);
    const lines = original.lines.length * modified.lines.length <= MAX_EDIT_DIFF_CELLS ? lcsLines(original.lines, modified.lines) : prefixSuffixLines(original.lines, modified.lines);
    return {
        lines,
        truncated: original.truncated || modified.truncated
    };
}
function context(text, oldNo, newNo) {
    return {
        kind: 'context',
        text,
        oldLineNumber: oldNo,
        newLineNumber: newNo
    };
}
function removal(text, oldNo) {
    return {
        kind: 'del',
        text,
        oldLineNumber: oldNo,
        newLineNumber: null
    };
}
function addition(text, newNo) {
    return {
        kind: 'add',
        text,
        oldLineNumber: null,
        newLineNumber: newNo
    };
}
function lcsLines(original, modified) {
    const width = modified.length + 1;
    const dp = new Uint32Array((original.length + 1) * width);
    for(let i = original.length - 1; i >= 0; i -= 1){
        for(let j = modified.length - 1; j >= 0; j -= 1){
            dp[i * width + j] = original[i] === modified[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
        }
    }
    const lines = [];
    let oldIndex = 0;
    let newIndex = 0;
    while(oldIndex < original.length && newIndex < modified.length){
        if (original[oldIndex] === modified[newIndex]) {
            lines.push(context(original[oldIndex] ?? '', oldIndex + 1, newIndex + 1));
            oldIndex += 1;
            newIndex += 1;
        } else if (dp[(oldIndex + 1) * width + newIndex] >= dp[oldIndex * width + newIndex + 1]) {
            lines.push(removal(original[oldIndex] ?? '', oldIndex + 1));
            oldIndex += 1;
        } else {
            lines.push(addition(modified[newIndex] ?? '', newIndex + 1));
            newIndex += 1;
        }
    }
    for(; oldIndex < original.length; oldIndex += 1){
        lines.push(removal(original[oldIndex] ?? '', oldIndex + 1));
    }
    for(; newIndex < modified.length; newIndex += 1){
        lines.push(addition(modified[newIndex] ?? '', newIndex + 1));
    }
    return lines;
}
function prefixSuffixLines(original, modified) {
    let prefix = 0;
    while(prefix < original.length && prefix < modified.length && original[prefix] === modified[prefix]){
        prefix += 1;
    }
    let suffix = 0;
    while(suffix + prefix < original.length && suffix + prefix < modified.length && original[original.length - suffix - 1] === modified[modified.length - suffix - 1]){
        suffix += 1;
    }
    const lines = [];
    for(let i = 0; i < prefix; i += 1){
        lines.push(context(original[i] ?? '', i + 1, i + 1));
    }
    for(let i = prefix; i < original.length - suffix; i += 1){
        lines.push(removal(original[i] ?? '', i + 1));
    }
    for(let i = prefix; i < modified.length - suffix; i += 1){
        lines.push(addition(modified[i] ?? '', i + 1));
    }
    for(let i = original.length - suffix; i < original.length; i += 1){
        const newIndex = modified.length - suffix + (i - (original.length - suffix));
        lines.push(context(original[i] ?? '', i + 1, newIndex + 1));
    }
    return lines;
}
