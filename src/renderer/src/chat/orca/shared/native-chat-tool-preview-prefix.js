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
export const MAX_TOOL_PREVIEW_LENGTH = 80;
const SHORT_INPUT_LENGTH = 160;
export function collapsedToolInputPrefix(input) {
    if (input.length <= SHORT_INPUT_LENGTH) {
        return input.replace(/\s+/g, ' ').trim();
    }
    let collapsed = '';
    let pendingSpace = false;
    const whitespace = /\s+/y;
    for(let index = 0; index < input.length;){
        whitespace.lastIndex = index;
        if (whitespace.test(input)) {
            index = whitespace.lastIndex;
            pendingSpace = collapsed.length > 0;
            continue;
        }
        if (pendingSpace) {
            collapsed += ' ';
            pendingSpace = false;
        }
        collapsed += input[index++];
        if (collapsed.length > MAX_TOOL_PREVIEW_LENGTH) {
            return collapsed;
        }
    }
    return collapsed;
}
const LOGIN_SHELL_COMMAND = /^\s*(?:.*[\\/])?(?:ba|z|k|da|fi)?sh(?:\.exe)?\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/;
export function unwrapLoginShellCommand(command) {
    return LOGIN_SHELL_COMMAND.exec(command)?.[2] ?? command;
}
