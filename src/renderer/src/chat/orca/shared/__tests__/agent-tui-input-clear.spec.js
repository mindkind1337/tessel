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
import { describe, expect, it } from 'vitest';
import { AGENT_TUI_CLEAR_INPUT_FORWARD, AGENT_TUI_CLEAR_INPUT_LINE, AGENT_TUI_CLEAR_INPUT_MAX, AGENT_TUI_CLEAR_LINE_SLACK, AGENT_TUI_CLEAR_MAX_LINES, buildAgentTuiClearInput, buildAgentTuiClearInputForText, countAgentTuiInputLines } from "../agent-tui-input-clear.js";
const countCtrlU = (bytes)=>bytes.split('').filter((char)=>char === AGENT_TUI_CLEAR_INPUT_LINE).length;
const countCtrlK = (bytes)=>bytes.split('').filter((char)=>char === AGENT_TUI_CLEAR_INPUT_FORWARD).length;
describe('buildAgentTuiClearInput', ()=>{
    it.each([
        [
            1,
            1
        ],
        [
            2,
            3
        ],
        [
            3,
            5
        ],
        [
            4,
            7
        ],
        [
            10,
            19
        ]
    ])('clears %i logical lines with %i Ctrl+U', (lines, expected)=>{
        const clearInput = buildAgentTuiClearInput(lines);
        expect(countCtrlU(clearInput)).toBe(expected);
        expect(countCtrlK(clearInput)).toBe(expected);
    });
    it('clears before the cursor before clearing the suffix after it', ()=>{
        expect(buildAgentTuiClearInput(4)).toBe(AGENT_TUI_CLEAR_INPUT_LINE.repeat(7) + AGENT_TUI_CLEAR_INPUT_FORWARD.repeat(7));
    });
    it('still clears one line for a zero or negative count', ()=>{
        expect(countCtrlU(buildAgentTuiClearInput(0))).toBe(1);
        expect(countCtrlU(buildAgentTuiClearInput(-5))).toBe(1);
    });
    it('caps the burst so a pathological draft cannot emit an unbounded write', ()=>{
        expect(countCtrlU(buildAgentTuiClearInput(10_000))).toBe(2 * AGENT_TUI_CLEAR_MAX_LINES - 1);
        expect(AGENT_TUI_CLEAR_INPUT_MAX).toBe(buildAgentTuiClearInput(AGENT_TUI_CLEAR_MAX_LINES));
    });
});
describe('countAgentTuiInputLines', ()=>{
    it.each([
        [
            'one line',
            1
        ],
        [
            'a\nb',
            2
        ],
        [
            'a\r\nb\r\nc',
            3
        ],
        [
            'a\rb',
            2
        ],
        [
            'trailing\n',
            2
        ]
    ])('counts %j as %i logical lines', (text, expected)=>{
        expect(countAgentTuiInputLines(text)).toBe(expected);
    });
    it('ignores visual wrapping — only logical newlines cost a Ctrl+U', ()=>{
        expect(countAgentTuiInputLines('x'.repeat(5_000))).toBe(1);
    });
});
describe('buildAgentTuiClearInputForText', ()=>{
    it('sizes the burst from the text plus slack for TUI-side edits', ()=>{
        expect(countCtrlU(buildAgentTuiClearInputForText('a\nb'))).toBe(2 * (2 + AGENT_TUI_CLEAR_LINE_SLACK) - 1);
    });
    it('clears strictly more than the draft needs, never less', ()=>{
        const draft = 'Linked Linear issue: ABC-123\nhttps://linear.app/x/issue/ABC-123\n';
        expect(countCtrlU(buildAgentTuiClearInputForText(draft))).toBeGreaterThan(2 * countAgentTuiInputLines(draft) - 1);
    });
    it('a long wrapped single line does not inflate the burst', ()=>{
        expect(buildAgentTuiClearInputForText('y'.repeat(5_000))).toBe(buildAgentTuiClearInputForText('y'));
    });
});
