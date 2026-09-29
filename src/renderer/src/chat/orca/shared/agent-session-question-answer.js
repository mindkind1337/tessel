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
const GROUP_ANSWER_PREFIX = 'question-group:';
const SINGLE_QUESTION_ID = 'q1';
export const AGENT_SESSION_RESPONSE_OPTION_ID_MAX_LENGTH = 1024;
export const AGENT_SESSION_QUESTION_ANSWER_MAX_BYTES = 64 * 1024;
export function agentSessionPromptQuestions(body) {
    if (body.questions) {
        return body.questions;
    }
    return [
        {
            id: body.freeTextQuestionId ?? SINGLE_QUESTION_ID,
            question: body.question,
            options: body.options,
            multiSelect: false,
            ...body.freeTextQuestionId ? {
                freeTextQuestionId: body.freeTextQuestionId
            } : {}
        }
    ];
}
function encodeLegacyFreeTextAnswer(questionId, answer) {
    return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`;
}
function decodeLegacyFreeTextAnswer(optionId) {
    const separator = optionId.indexOf(':');
    if (separator <= 0) {
        return null;
    }
    try {
        return {
            questionId: decodeURIComponent(optionId.slice(0, separator)),
            answer: decodeURIComponent(optionId.slice(separator + 1))
        };
    } catch  {
        return null;
    }
}
export function legacyAgentSessionSelectedOptionId(body, answers) {
    if (body.questions) {
        return encodeAgentSessionQuestionAnswers(answers);
    }
    const [answer] = answers;
    if (!answer || answers.length !== 1) {
        return null;
    }
    const other = answer.other?.trim();
    return answer.optionIds[0] ?? (other ? encodeLegacyFreeTextAnswer(answer.questionId, other) : null);
}
export function legacyAgentSessionQuestionAnswers(body, optionId) {
    const grouped = body.questions ? decodeAgentSessionQuestionAnswers(optionId) : null;
    if (grouped) {
        return grouped;
    }
    const questions = agentSessionPromptQuestions(body);
    const questionId = questions.length === 1 ? questions[0].id : null;
    if (!questionId) {
        return null;
    }
    if (body.options.some((option)=>option.id === optionId)) {
        return [
            {
                questionId,
                optionIds: [
                    optionId
                ]
            }
        ];
    }
    const freeText = decodeLegacyFreeTextAnswer(optionId);
    return body.freeTextQuestionId && freeText?.questionId === body.freeTextQuestionId && freeText.answer.trim().length > 0 ? [
        {
            questionId,
            optionIds: [],
            other: freeText.answer
        }
    ] : null;
}
export function encodeAgentSessionQuestionAnswers(answers) {
    return `${GROUP_ANSWER_PREFIX}${JSON.stringify(answers).replaceAll('%', '%25')}`;
}
export function decodeAgentSessionQuestionAnswers(encoded) {
    if (!encoded.startsWith(GROUP_ANSWER_PREFIX)) {
        return null;
    }
    try {
        const parsed = JSON.parse(decodeURIComponent(encoded.slice(GROUP_ANSWER_PREFIX.length)));
        if (!Array.isArray(parsed)) {
            return null;
        }
        const answers = parsed.flatMap((value)=>{
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return [];
            }
            const record = value;
            if (typeof record.questionId !== 'string' || !Array.isArray(record.optionIds) || !record.optionIds.every((optionId)=>typeof optionId === 'string') || record.other !== undefined && typeof record.other !== 'string') {
                return [];
            }
            return [
                {
                    questionId: record.questionId,
                    optionIds: record.optionIds,
                    ...typeof record.other === 'string' ? {
                        other: record.other
                    } : {}
                }
            ];
        });
        return answers.length === parsed.length ? answers : null;
    } catch  {
        return null;
    }
}
export function isValidAgentSessionQuestionAnswers(questions, answers) {
    if (answers.length !== questions.length) {
        return false;
    }
    const byId = new Map(answers.map((answer)=>[
            answer.questionId,
            answer
        ]));
    if (byId.size !== answers.length) {
        return false;
    }
    return questions.every((question)=>{
        const answer = byId.get(question.id);
        if (!answer) {
            return false;
        }
        const offered = new Set(question.options.map((option)=>option.id));
        if (answer.optionIds.some((optionId)=>!offered.has(optionId))) {
            return false;
        }
        const other = answer.other?.trim() ?? '';
        if (other && !question.freeTextQuestionId) {
            return false;
        }
        const answerCount = answer.optionIds.length + (other ? 1 : 0);
        return answerCount > 0 && (question.multiSelect || answerCount === 1);
    });
}
