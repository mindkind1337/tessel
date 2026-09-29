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
export const LOCAL_COMMIT_MESSAGE_HOST_KEY = 'local';
export const UNKNOWN_COMMIT_MESSAGE_HOST_KEY = 'unknown';
export const RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX = 'runtime:';
export function getCommitMessageModelDiscoveryHostKeyForLocalRuntime(wslDistro) {
    const distro = wslDistro?.trim();
    return distro ? `wsl:${distro}` : LOCAL_COMMIT_MESSAGE_HOST_KEY;
}
export function getCommitMessageModelDiscoveryHostKey(connectionId) {
    if (connectionId === undefined) {
        return UNKNOWN_COMMIT_MESSAGE_HOST_KEY;
    }
    return connectionId ? `ssh:${connectionId}` : LOCAL_COMMIT_MESSAGE_HOST_KEY; // i18n-ignore
}
export function getCommitMessageModelDiscoveryHostKeyForScope(scope) {
    if (scope === undefined) {
        return UNKNOWN_COMMIT_MESSAGE_HOST_KEY;
    }
    if (!scope) {
        return LOCAL_COMMIT_MESSAGE_HOST_KEY;
    }
    if (scope.startsWith(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX)) {
        return scope;
    }
    return getCommitMessageModelDiscoveryHostKey(scope);
}
