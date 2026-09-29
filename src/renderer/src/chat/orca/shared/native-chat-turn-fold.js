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
export const NATIVE_CHAT_EMPTY_TURN_FOLD = {
    foldedRows: new Set(),
    foldableTurnKeys: new Set()
};
export function nativeChatTurnAnswerRows(rows) {
    const answers = new Map();
    for (const [index, row] of rows.entries()){
        if (row.turnKey !== undefined && row.role === 'assistant' && row.rendersProse) {
            answers.set(row.turnKey, index);
        }
    }
    return answers;
}
export function nativeChatTurnFold({ rows, settledTurnKeys, expandedTurnKeys }) {
    const answers = nativeChatTurnAnswerRows(rows);
    const foldedRows = new Set();
    const foldableTurnKeys = new Set();
    for (const [index, row] of rows.entries()){
        const { turnKey } = row;
        if (turnKey === undefined || row.role === 'user' || row.outlivesTurn || !settledTurnKeys.has(turnKey)) {
            continue;
        }
        if (index === answers.get(turnKey)) {
            continue;
        }
        foldableTurnKeys.add(turnKey);
        if (!expandedTurnKeys.has(turnKey)) {
            foldedRows.add(index);
        }
    }
    return {
        foldedRows,
        foldableTurnKeys
    };
}
