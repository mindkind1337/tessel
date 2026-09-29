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
import { isAskUserQuestionTool } from "./shared/agent-question-answered-intent.js";
import { parseAskFromToolInput } from "./shared/native-chat-ask.js";
import { projectStructuredItemToNativeChat } from "./shared/structured-agent-session-projection.js";
import { readAgentJournalTurn } from "./shared/agent-session-turn-record.js";
const projections = new WeakMap();
const pendingGroups = new WeakMap();
function pendingGroupBody(bodies) {
    const first = bodies[0];
    if (bodies.length === 1) {
        return first;
    }
    const cached = pendingGroups.get(first);
    if (cached?.bodies.length === bodies.length && bodies.every((body, index)=>body === cached.bodies[index])) {
        return cached.body;
    }
    const body = {
        ...first,
        questions: bodies.flatMap((question, index)=>question.questions?.length ? question.questions : [
                {
                    id: String(index),
                    question: question.question,
                    options: question.options,
                    multiSelect: false
                }
            ])
    };
    pendingGroups.set(first, {
        bodies,
        body
    });
    return body;
}
function questionKey(questions) {
    const texts = questions.map(({ question })=>question.trim());
    return texts.length > 0 && texts.every(Boolean) ? JSON.stringify(texts.sort()) : null;
}
function projectItem(item) {
    const cached = projections.get(item);
    if (cached) {
        return cached;
    }
    const { body } = item;
    let message = projectStructuredItemToNativeChat(item);
    let key = null;
    if (body.kind === 'question') {
        const questions = body.questions?.length ? body.questions : [
            {
                question: body.question
            }
        ];
        key = questionKey(questions);
        if (body.resolution.state === 'pending') {
            message = {
                id: item.itemId,
                role: 'system',
                timestamp: item.observedAt,
                source: 'transcript',
                blocks: [
                    {
                        type: 'text',
                        text: body.question
                    }
                ]
            };
        }
    } else if (body.kind === 'tool-call' && isAskUserQuestionTool(body.name) && body.state !== 'failed') {
        const prompt = parseAskFromToolInput(body.name, body.input);
        key = prompt ? questionKey(prompt.questions) : null;
    }
    const projection = {
        message,
        questionKey: key
    };
    projections.set(item, projection);
    return projection;
}
function projectQuestions(items) {
    const questionsByTurn = new Map();
    const rows = [];
    let turn = '';
    for (const item of items){
        if (item.body.kind === 'message' && item.body.role === 'user') {
            turn = item.itemId;
        }
        const lifecycle = readAgentJournalTurn(item.body);
        if (lifecycle) {
            turn = lifecycle.turnId;
        }
        const projection = projectItem(item);
        rows.push({
            item,
            projection,
            turn
        });
        if (turn && item.body.kind === 'question' && projection.questionKey) {
            let questions = questionsByTurn.get(turn);
            if (!questions) {
                questionsByTurn.set(turn, questions = new Map());
            }
            questions.set(projection.questionKey, (questions.get(projection.questionKey) ?? 0) + 1);
        }
    }
    const messages = [];
    const receipts = new Map();
    let pendingGroup = null;
    const finishGroup = ()=>{
        if (!pendingGroup) {
            return;
        }
        receipts.set(pendingGroup.id, pendingGroupBody(pendingGroup.bodies));
        pendingGroup = null;
    };
    for (const { item, projection, turn: rowTurn } of rows){
        if (item.body.kind === 'tool-call' && projection.questionKey && (questionsByTurn.get(rowTurn)?.get(projection.questionKey) ?? 0) > 0) {
            const questions = questionsByTurn.get(rowTurn);
            const remaining = questions.get(projection.questionKey) - 1;
            if (remaining === 0) {
                questions.delete(projection.questionKey);
            } else {
                questions.set(projection.questionKey, remaining);
            }
            continue;
        }
        if (item.body.kind === 'question' && item.body.resolution.state === 'pending') {
            if (pendingGroup) {
                pendingGroup.bodies.push(item.body);
                continue;
            }
            pendingGroup = {
                id: item.itemId,
                bodies: [
                    item.body
                ]
            };
        } else {
            finishGroup();
            if ((item.body.kind === 'question' || item.body.kind === 'approval') && item.body.resolution.state !== 'pending') {
                receipts.set(item.itemId, item.body);
            }
        }
        if (projection.message) {
            messages.push(projection.message);
        }
    }
    finishGroup();
    return {
        messages,
        receipts
    };
}
const histories = new WeakMap();
export function structuredQuestionTranscript(items) {
    let projection = histories.get(items);
    if (!projection) {
        projection = projectQuestions(items);
        histories.set(items, projection);
    }
    return projection;
}
export function projectStructuredQuestionMessages(items) {
    return structuredQuestionTranscript(items).messages;
}
