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
import { agentSessionPromptQuestions, legacyAgentSessionQuestionAnswers } from "./shared/agent-session-question-answer.js";
export function nativeChatReceiptAnswers(body) {
    if (body.resolution.state !== 'resolved') {
        return [];
    }
    const selected = body.resolution.selectedOptionId;
    if (body.kind === 'question') {
        const answers = body.resolution.answers ?? (selected ? legacyAgentSessionQuestionAnswers(body, selected) : null);
        return agentSessionPromptQuestions(body).map((question)=>{
            const answer = answers?.find((entry)=>entry.questionId === question.id);
            const labels = answer?.optionIds.map((id)=>question.options.find((option)=>option.id === id)?.label);
            const valid = labels?.every((label)=>label !== undefined);
            return {
                question: body.questions ? question.question : null,
                answer: valid ? [
                    ...labels ?? [],
                    ...answer?.other ? [
                        answer.other
                    ] : []
                ].join(' · ') || null : null
            };
        });
    }
    const option = body.options.find((option)=>option.id === selected);
    return [
        {
            question: null,
            answer: option?.label ?? null
        }
    ];
}
