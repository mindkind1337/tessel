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
import { parseExecutionHostId } from "../execution-host.js";
const HOST_SEPARATOR = '|';
export function getWorktreeHostIdentity(worktree) {
    return composeWorktreeHostIdentity(worktree.hostId, worktree.id);
}
export function composeWorktreeHostIdentity(hostId, worktreeId) {
    return `${hostId ?? ''}${HOST_SEPARATOR}${worktreeId}`;
}
export function getExecutionHostIdFromWorktreeHostIdentity(identity) {
    const separatorIndex = identity.indexOf(HOST_SEPARATOR);
    if (separatorIndex <= 0) {
        return undefined;
    }
    return parseExecutionHostId(identity.slice(0, separatorIndex))?.id;
}
export function getWorktreeIdFromHostIdentity(identity) {
    return identity.slice(identity.indexOf(HOST_SEPARATOR) + 1);
}
export function isWorktreeHostIdentity(identity) {
    const separator = identity.indexOf(HOST_SEPARATOR);
    return separator === 0 || separator > 0 && parseExecutionHostId(identity.slice(0, separator)) !== null;
}
