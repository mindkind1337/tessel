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
import { decodeAgentSessionQuestionAnswers, encodeAgentSessionQuestionAnswers, isValidAgentSessionQuestionAnswers } from "../agent-session-question-answer.js";
const GROUP_ANSWER_PREFIX = 'question-group:';
function decodeWithOriginalPercentDecoder(encoded) {
    return JSON.parse(decodeURIComponent(encoded.slice(GROUP_ANSWER_PREFIX.length)));
}
describe('agent-session grouped question answers', ()=>{
    const answers = [
        {
            questionId: 'q1',
            optionIds: [
                'target-web',
                'target-mobile'
            ]
        },
        {
            questionId: 'q2',
            optionIds: [],
            other: 'SSH host'
        }
    ];
    it('round-trips grouped multi-select and free-text answers', ()=>{
        expect(decodeAgentSessionQuestionAnswers(encodeAgentSessionQuestionAnswers(answers))).toEqual(answers);
    });
    it('keeps compact answers readable by the original percent-decoding contract', ()=>{
        expect(decodeWithOriginalPercentDecoder(encodeAgentSessionQuestionAnswers(answers))).toEqual(answers);
    });
    it('accepts the previous fully percent-encoded representation', ()=>{
        const encoded = `${GROUP_ANSWER_PREFIX}${encodeURIComponent(JSON.stringify(answers))}`;
        expect(decodeAgentSessionQuestionAnswers(encoded)).toEqual(answers);
    });
    it('round-trips percent signs and Unicode through the compact representation', ()=>{
        const unicodeAnswers = [
            {
                questionId: '進捗%',
                optionIds: [
                    '100%:完了',
                    '🚀'
                ],
                other: 'café 東京 50%'
            }
        ];
        expect(decodeAgentSessionQuestionAnswers(encodeAgentSessionQuestionAnswers(unicodeAnswers))).toEqual(unicodeAnswers);
    });
    it("fits Claude's maximum choice group within a 512-character host response bound", ()=>{
        const maximumSelections = Array.from({
            length: 4
        }, (_, questionIndex)=>({
                questionId: `q${questionIndex + 1}`,
                optionIds: Array.from({
                    length: 4
                }, (_, optionIndex)=>`q${questionIndex + 1}:choice-${optionIndex + 1}`)
            }));
        expect(encodeAgentSessionQuestionAnswers(maximumSelections).length).toBeLessThanOrEqual(512);
    });
    it('validates each grouped answer against its question shape', ()=>{
        const questions = [
            {
                id: 'q1',
                question: 'Targets',
                multiSelect: true,
                options: [
                    {
                        id: 'target-web',
                        label: 'Web'
                    },
                    {
                        id: 'target-mobile',
                        label: 'Mobile'
                    }
                ]
            },
            {
                id: 'q2',
                question: 'Host',
                multiSelect: false,
                options: [],
                freeTextQuestionId: 'q2'
            }
        ];
        expect(isValidAgentSessionQuestionAnswers(questions, answers)).toBe(true);
        expect(isValidAgentSessionQuestionAnswers(questions, [
            {
                questionId: 'q1',
                optionIds: [
                    'unknown'
                ]
            },
            answers[1]
        ])).toBe(false);
    });
});
