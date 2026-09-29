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
export function isAskUserQuestionTool(toolName) {
    const normalized = toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();
    return normalized === 'askuserquestion' || normalized === 'requestuserinput';
}
const QUESTION_ANSWER_ENTER_INPUTS = new Set([
    '\r',
    '\n',
    '\r\n',
    '\x1b[13u',
    '\x1b[13;1u'
]);
const QUESTION_ANSWER_DIGIT_INPUTS = new Set('123456789');
export function isPotentialQuestionAnsweredSubmitInput(data) {
    return QUESTION_ANSWER_ENTER_INPUTS.has(data) || QUESTION_ANSWER_DIGIT_INPUTS.has(data);
}
function readSingleSelectOptionCount(interactivePrompt) {
    if (!interactivePrompt) {
        return null;
    }
    try {
        const parsed = JSON.parse(interactivePrompt);
        if (!Array.isArray(parsed.questions) || parsed.questions.length !== 1) {
            return -1;
        }
        const [question] = parsed.questions;
        if (!question || question.multiSelect === true || !Array.isArray(question.options)) {
            return -1;
        }
        return question.options.length;
    } catch  {
        return -1;
    }
}
export function isQuestionAnsweredSubmitInput(data, interactivePrompt) {
    if (!isPotentialQuestionAnsweredSubmitInput(data)) {
        return false;
    }
    const optionCount = readSingleSelectOptionCount(interactivePrompt);
    if (optionCount === -1) {
        return false;
    }
    if (QUESTION_ANSWER_ENTER_INPUTS.has(data)) {
        return true;
    }
    if (optionCount === null) {
        return false;
    }
    return Number(data) <= optionCount;
}
