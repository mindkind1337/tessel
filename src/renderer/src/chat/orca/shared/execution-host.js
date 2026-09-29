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
import { t } from "../../../i18n/index.js";
export const LOCAL_EXECUTION_HOST_ID = 'local';
export const ALL_EXECUTION_HOSTS_SCOPE = 'all';
function getCurrentLocalPlatform() {
    const globalNavigator = globalThis.navigator;
    const userAgent = globalNavigator?.userAgent || globalNavigator?.platform || '';
    if (/Windows/i.test(userAgent)) {
        return 'win32';
    }
    if (/Mac/i.test(userAgent)) {
        return 'darwin';
    }
    if (/Linux|X11/i.test(userAgent)) {
        return 'linux';
    }
    return typeof process === 'undefined' ? null : process.platform;
}
export function getLocalExecutionHostLabel(platform = null) {
    const localPlatform = platform ?? getCurrentLocalPlatform();
    if (localPlatform === 'darwin') {
        return t("chat.orca.copy.local_mac", "Local Mac");
    }
    if (localPlatform === 'win32') {
        return t("chat.orca.copy.local_windows", "Local Windows");
    }
    if (localPlatform === 'linux') {
        return t("chat.orca.copy.local_linux", "Local Linux");
    }
    return t("chat.orca.copy.this_computer", "This computer");
}
function normalizeHostPart(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
export function toSshExecutionHostId(targetId) {
    return `ssh:${encodeURIComponent(targetId)}`; // i18n-ignore
}
export function toRuntimeExecutionHostId(environmentId) {
    return `runtime:${encodeURIComponent(environmentId)}`; // i18n-ignore
}
export const RUNTIME_OWNED_SSH_TARGET_ID_PREFIX = 'runtime-ssh-';
export function isRuntimeOwnedSshTargetId(targetId) {
    return typeof targetId === 'string' && targetId.startsWith(RUNTIME_OWNED_SSH_TARGET_ID_PREFIX);
}
export function parseExecutionHostId(value) {
    const normalized = normalizeHostPart(value);
    if (!normalized) {
        return null;
    }
    if (normalized === LOCAL_EXECUTION_HOST_ID) {
        return {
            kind: 'local',
            id: LOCAL_EXECUTION_HOST_ID
        };
    }
    if (normalized.startsWith('ssh:')) {
        const encoded = normalized.slice('ssh:'.length);
        if (!encoded) {
            return null;
        }
        if (encoded.includes('|')) {
            return null;
        }
        try {
            const targetId = decodeURIComponent(encoded);
            return targetId ? {
                kind: 'ssh',
                id: `ssh:${encoded}`, // i18n-ignore
                targetId
            } : null;
        } catch  {
            return null;
        }
    }
    if (normalized.startsWith('runtime:')) {
        const encoded = normalized.slice('runtime:'.length);
        if (!encoded) {
            return null;
        }
        if (encoded.includes('|')) {
            return null;
        }
        try {
            const environmentId = decodeURIComponent(encoded);
            return environmentId ? {
                kind: 'runtime',
                id: `runtime:${encoded}`, // i18n-ignore
                environmentId
            } : null;
        } catch  {
            return null;
        }
    }
    return null;
}
export function normalizeExecutionHostId(value) {
    return parseExecutionHostId(value)?.id ?? null;
}
export function normalizeExecutionHostScope(value) {
    const normalized = normalizeHostPart(value);
    if (!normalized || normalized === ALL_EXECUTION_HOSTS_SCOPE) {
        return ALL_EXECUTION_HOSTS_SCOPE;
    }
    return normalizeExecutionHostId(normalized) ?? ALL_EXECUTION_HOSTS_SCOPE;
}
export function requestedExecutionHostScope(value) {
    return normalizeExecutionHostScope(value ?? LOCAL_EXECUTION_HOST_ID);
}
export function normalizeVisibleExecutionHostIds(value) {
    if (!Array.isArray(value)) {
        return null;
    }
    const ids = [];
    const seen = new Set();
    for (const raw of value){
        const id = normalizeExecutionHostId(raw);
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        ids.push(id);
    }
    return ids.length > 0 ? ids : null;
}
export function normalizeExecutionHostOrder(value) {
    const normalized = normalizeVisibleExecutionHostIds(value);
    return normalized ?? [];
}
export function getRepoExecutionHostId(repo) {
    const executionHostId = normalizeExecutionHostId(repo.executionHostId);
    if (executionHostId) {
        return executionHostId;
    }
    const connectionId = normalizeHostPart(repo.connectionId);
    return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID;
}
export function getSshTargetIdForExecutionHost(executionHostId) {
    const parsed = parseExecutionHostId(executionHostId);
    return parsed?.kind === 'ssh' ? parsed.targetId : null;
}
export function getRepoSshConnectionId(repo) {
    const host = parseExecutionHostId(getRepoExecutionHostId(repo));
    if (host?.kind === 'ssh') {
        return host.targetId;
    }
    return host?.kind === 'runtime' ? normalizeHostPart(repo.connectionId) : null;
}
export function getWorktreeExecutionHostId(worktree, repo, defaultHostId = LOCAL_EXECUTION_HOST_ID) {
    return worktree.hostId ?? (repo?.connectionId || repo?.executionHostId ? getRepoExecutionHostId(repo) : defaultHostId);
}
export function getSettingsFocusedExecutionHostId(settings) {
    const runtimeEnvironmentId = normalizeHostPart(settings?.activeRuntimeEnvironmentId);
    return runtimeEnvironmentId ? toRuntimeExecutionHostId(runtimeEnvironmentId) : LOCAL_EXECUTION_HOST_ID;
}
export function getExecutionHostLabel(id) {
    if (id === ALL_EXECUTION_HOSTS_SCOPE) {
        return t("chat.orca.copy.all_hosts", "All hosts");
    }
    const parsed = parseExecutionHostId(id);
    if (!parsed) {
        return t("chat.orca.copy.unknown_host", "Unknown host");
    }
    switch(parsed.kind){
        case 'local':
            return getLocalExecutionHostLabel();
        case 'ssh':
            return parsed.targetId;
        case 'runtime':
            return parsed.environmentId;
    }
}
