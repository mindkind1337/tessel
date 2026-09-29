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
export function agentArgOptionTokens(tokens) {
    const terminator = tokens.indexOf('--');
    return terminator === -1 ? tokens : tokens.slice(0, terminator);
}
export function removeAgentArgOption(tokens, aliases) {
    const result = [];
    for(let index = 0; index < tokens.length; index += 1){
        const token = tokens[index];
        if (token === '--') {
            result.push(...tokens.slice(index));
            break;
        }
        const exact = aliases.includes(token);
        const matched = aliases.some((alias)=>token.startsWith(`${alias}=`) || alias.startsWith('-') && !alias.startsWith('--') && token.startsWith(alias) && token.length > alias.length);
        if (!exact && !matched) {
            result.push(token);
            continue;
        }
        if (exact && tokens[index + 1] && !tokens[index + 1].startsWith('-')) {
            index += 1;
        }
    }
    return result;
}
