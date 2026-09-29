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
export const AGENT_TUI_CLEAR_INPUT_LINE = '\x15';
export const AGENT_TUI_CLEAR_INPUT_FORWARD = '\x0b';
export function buildAgentTuiClearInput(lineCount) {
    const lines = Math.max(1, Math.min(AGENT_TUI_CLEAR_MAX_LINES, Math.floor(lineCount)));
    const repetitions = 2 * lines - 1;
    return AGENT_TUI_CLEAR_INPUT_LINE.repeat(repetitions) + AGENT_TUI_CLEAR_INPUT_FORWARD.repeat(repetitions);
}
export const AGENT_TUI_CLEAR_LINE_SLACK = 8;
export const AGENT_TUI_CLEAR_MAX_LINES = 40;
export const AGENT_TUI_CLEAR_INPUT_MAX = buildAgentTuiClearInput(AGENT_TUI_CLEAR_MAX_LINES);
export function countAgentTuiInputLines(text) {
    return text.split(/\r\n|\r|\n/).length;
}
export function buildAgentTuiClearInputForText(text) {
    return buildAgentTuiClearInput(countAgentTuiInputLines(text) + AGENT_TUI_CLEAR_LINE_SLACK);
}
