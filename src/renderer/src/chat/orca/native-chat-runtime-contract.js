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
import { t } from "../../i18n/index.js";
export const RUNTIME_NATIVE_CHAT_READ_ERROR = t("chat.orca.copy.couldn_t_read_agent_chat_from_the_remote_runtime", "Couldn't read agent chat from the remote runtime.");
export function parseRuntimeNativeChatTurnLifecycle(value) {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const record = value;
    if (record.state !== 'working' && record.state !== 'completed' && record.state !== 'interrupted' || typeof record.turnId !== 'string' || record.turnId.trim().length === 0 || record.timestamp !== null && record.timestamp !== undefined && (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp) || record.timestamp <= 0)) {
        return undefined;
    }
    return {
        state: record.state,
        turnId: record.turnId.trim(),
        timestamp: record.timestamp ?? null
    };
}
export function parseRuntimeNativeChatReadSessionResult(value) {
    if (typeof value !== 'object' || value === null) {
        return {
            error: RUNTIME_NATIVE_CHAT_READ_ERROR
        };
    }
    const record = value;
    if (Array.isArray(record.messages)) {
        const lifecycle = parseRuntimeNativeChatTurnLifecycle(record.lifecycle);
        return {
            messages: record.messages,
            ...lifecycle ? {
                lifecycle
            } : {}
        };
    }
    if (typeof record.error === 'string') {
        return {
            error: record.error,
            ...record.notFound === true ? {
                notFound: true
            } : {}
        };
    }
    return {
        error: RUNTIME_NATIVE_CHAT_READ_ERROR
    };
}
