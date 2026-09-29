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
import { isInterruptedStatusMessage } from "./native-chat-types.js";
const QUESTION_TOOL_PARSERS = new Map();
export function nativeChatAskDismissKey(prompt) {
    return prompt ? `question:${JSON.stringify(prompt.questions)}` : null; // i18n-ignore
}
export function registerQuestionTool(toolName, parser) {
    QUESTION_TOOL_PARSERS.set(toolName, parser);
}
function parseCanonicalQuestionsInput(input) {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const rawQuestions = input.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return null;
    }
    const questions = [];
    for (const raw of rawQuestions){
        if (!raw || typeof raw !== 'object') {
            continue;
        }
        const question = raw;
        const text = typeof question.question === 'string' ? question.question : '';
        const options = parseOptions(question.options);
        if (text || options.length > 0) {
            questions.push({
                question: text,
                header: typeof question.header === 'string' ? question.header : undefined,
                multiSelect: question.multiSelect === true,
                options
            });
        }
    }
    return questions.length > 0 ? {
        questions
    } : null;
}
function parseOptions(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.map((option)=>{
        if (typeof option === 'string') {
            return {
                label: option
            };
        }
        if (option && typeof option === 'object' && typeof option.label === 'string') {
            const value = option;
            return {
                label: value.label,
                description: typeof value.description === 'string' ? value.description : undefined
            };
        }
        return null;
    }).filter((option)=>option !== null);
}
for (const name of [
    'AskUserQuestion',
    'ask_user_question',
    'askUserQuestion'
]){
    QUESTION_TOOL_PARSERS.set(name, parseCanonicalQuestionsInput);
}
function parseToolInput(toolName, input) {
    const parser = toolName ? QUESTION_TOOL_PARSERS.get(toolName) : undefined;
    return (parser ? parser(input) : null) ?? parseCanonicalQuestionsInput(input);
}
export function parseAskFromStatus(interactivePrompt, toolName) {
    if (!interactivePrompt) {
        return null;
    }
    try {
        return parseToolInput(toolName, JSON.parse(interactivePrompt));
    } catch  {
        return null;
    }
}
export function parseAskFromToolInput(toolName, input) {
    return typeof input === 'string' ? parseAskFromStatus(input, toolName) : parseToolInput(toolName, input);
}
export function extractPendingAsk(messages) {
    let pending = null;
    let outstanding = 0;
    let pendingDepth = -1;
    for (const message of messages){
        if (message.role === 'user' || isInterruptedStatusMessage(message)) {
            outstanding = 0;
            pendingDepth = -1;
            pending = null;
        }
        for (const block of message.blocks){
            if (block.type === 'tool-call') {
                const parsed = parseToolInput(block.name, block.input);
                if (parsed) {
                    pending = parsed;
                    pendingDepth = outstanding;
                }
                outstanding += 1;
            } else if (block.type === 'tool-result' && outstanding > 0) {
                outstanding -= 1;
                if (pendingDepth === 0) {
                    pending = null;
                    pendingDepth = -1;
                } else if (pendingDepth > 0) {
                    pendingDepth -= 1;
                }
            }
        }
    }
    return pending;
}
export function resolveNativeChatAsk(args) {
    return args.liveAsk ?? (args.transcriptSettled ? extractPendingAsk(args.messages) : null);
}
function isAnswered(sel) {
    return (sel?.indices.length ?? 0) > 0 || (sel?.other ?? '').trim().length > 0;
}
function answerLabels(question, sel) {
    const labels = (sel?.indices ?? []).map((i)=>question.options[i]?.label ?? '').filter((l)=>l.length > 0);
    const other = (sel?.other ?? '').trim();
    return other ? [
        ...labels,
        other
    ] : labels;
}
export function formatAskAnswer(prompt, selections) {
    return prompt.questions.map((q, i)=>answerLabels(q, selections[i]).join(', ')).join('\n');
}
const ASK_ENTER = '\r';
const ASK_NEXT_TAB = '\x1b[C';
const ASK_PREVIOUS_ROW = '\x1b[A';
const ASK_NEXT_ROW = '\x1b[B';
const ASK_NOTES = '\t';
export function buildAskAnswerKeys(prompt, selections) {
    const questions = prompt.questions;
    const multiQuestion = questions.length > 1;
    const groups = [];
    questions.forEach((q, qi)=>{
        const sel = selections[qi];
        const other = (sel?.other ?? '').trim();
        const typeSomething = String(q.options.length + 1);
        if (q.multiSelect) {
            for (const i of sel?.indices ?? []){
                groups.push({
                    raw: String(i + 1)
                });
            }
            if (other) {
                groups.push({
                    raw: typeSomething
                }, {
                    text: other
                }, {
                    raw: ASK_ENTER
                });
            }
            groups.push({
                raw: ASK_NEXT_TAB
            });
        } else if (other) {
            groups.push({
                raw: typeSomething
            }, {
                text: answerLabels(q, sel).join(', ')
            }, {
                raw: ASK_ENTER
            });
        } else if ((sel?.indices.length ?? 0) > 0) {
            groups.push({
                raw: String(sel.indices[0] + 1)
            });
        } else if (multiQuestion) {
            groups.push({
                raw: ASK_NEXT_TAB
            });
        }
    });
    const endsOnSubmitTab = multiQuestion || questions.length === 1 && questions[0].multiSelect === true;
    if (endsOnSubmitTab && groups.length > 0) {
        groups.push({
            raw: ASK_ENTER
        });
    }
    return groups;
}
export function buildCodexAskAnswerKeys(prompt, selections) {
    const groups = [];
    let hasUnanswered = false;
    prompt.questions.forEach((question, questionIndex)=>{
        const selection = selections[questionIndex];
        const selectedIndex = selection?.indices[0];
        const note = (selection?.other ?? '').trim();
        if (note) {
            const targetIndex = selectedIndex ?? question.options.length;
            const rowCount = question.options.length + 1;
            const nextSteps = targetIndex;
            const previousSteps = rowCount - targetIndex;
            const usePrevious = previousSteps < nextSteps;
            const navigationKey = usePrevious ? ASK_PREVIOUS_ROW : ASK_NEXT_ROW;
            const navigationSteps = usePrevious ? previousSteps : nextSteps;
            for(let index = 0; index < navigationSteps; index += 1){
                groups.push({
                    raw: navigationKey
                });
            }
            groups.push({
                raw: ASK_NOTES
            }, {
                text: note
            }, {
                raw: ASK_ENTER
            });
            return;
        }
        if (selectedIndex !== undefined) {
            groups.push({
                raw: String(selectedIndex + 1)
            });
            return;
        }
        hasUnanswered = true;
        groups.push({
            raw: '\x7f'
        });
        if (questionIndex < prompt.questions.length - 1) {
            groups.push({
                raw: ASK_NEXT_TAB
            });
        } else {
            groups.push({
                raw: ASK_ENTER
            });
        }
    });
    if (hasUnanswered) {
        groups.push({
            raw: ASK_ENTER
        });
    }
    return groups;
}
export function hasAskAnswer(prompt, selections) {
    return prompt.questions.some((_, i)=>isAnswered(selections[i]));
}
