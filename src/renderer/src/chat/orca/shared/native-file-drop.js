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
import { measureClipboardTextByteLength } from "./clipboard-text.js";
export const ORCA_INTERNAL_FILE_DRAG_TYPE = 'text/x-orca-file-path';
export const NATIVE_FILE_DROP_MAX_PATHS = 256;
export const NATIVE_FILE_DROP_MAX_PATH_BYTES = 256 * 1024;
export const NATIVE_FILE_DROP_TARGET = {
    editor: 'editor',
    terminal: 'terminal',
    composer: 'composer',
    fileExplorer: 'file-explorer',
    projectSidebar: 'project-sidebar'
};
function isNativeFileDropRejectedReason(reason) {
    return reason === 'paths-too-large' || reason === 'too-many-paths' || reason === 'unresolved-paths';
}
function isNativeFileDropTarget(target) {
    return Object.values(NATIVE_FILE_DROP_TARGET).includes(target) || target === 'rejected';
}
function isOptionalNativeFileDropString(value) {
    return value === undefined || typeof value === 'string';
}
function isNativeFileDropPathList(value) {
    return Array.isArray(value) && value.every((path)=>typeof path === 'string');
}
function isNonNegativeFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function getDataTransferTypes(types) {
    return types ? Array.from(types) : [];
}
export function hasNativeFileDragTypes(types) {
    const values = getDataTransferTypes(types);
    return values.includes('Files') && !values.includes(ORCA_INTERNAL_FILE_DRAG_TYPE);
}
export function resolveNativeFileDropPath(path) {
    let foundExplorer = false;
    let destinationDir;
    let terminalPaneLeafId;
    let composerScopeKey;
    for (const entry of path){
        terminalPaneLeafId ??= entry.terminalPaneLeafId;
        composerScopeKey ??= entry.composerScopeKey;
        const target = entry.nativeFileDropTarget;
        if (target === NATIVE_FILE_DROP_TARGET.terminal) {
            return {
                target,
                tabId: entry.terminalTabId,
                paneLeafId: terminalPaneLeafId
            };
        }
        if (target === NATIVE_FILE_DROP_TARGET.composer) {
            return {
                target,
                ...composerScopeKey ? {
                    scopeKey: composerScopeKey
                } : {}
            };
        }
        if (target === NATIVE_FILE_DROP_TARGET.editor) {
            return {
                target
            };
        }
        if (target === NATIVE_FILE_DROP_TARGET.projectSidebar) {
            return {
                target
            };
        }
        if (target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
            foundExplorer = true;
        }
        if (destinationDir === undefined && entry.nativeFileDropDir) {
            destinationDir = entry.nativeFileDropDir;
        }
    }
    if (foundExplorer) {
        if (!destinationDir) {
            return {
                target: 'rejected'
            };
        }
        return {
            target: NATIVE_FILE_DROP_TARGET.fileExplorer,
            destinationDir
        };
    }
    return null;
}
export function validateNativeFileDropPaths(paths, options = {}) {
    const pathCount = paths.length;
    const maxPaths = options.maxPaths ?? NATIVE_FILE_DROP_MAX_PATHS;
    if (pathCount > maxPaths) {
        return {
            byteLength: 0,
            pathCount,
            reason: 'too-many-paths',
            status: 'rejected'
        };
    }
    const maxPathBytes = options.maxPathBytes ?? NATIVE_FILE_DROP_MAX_PATH_BYTES;
    let byteLength = 0;
    for (const path of paths){
        const measurement = measureClipboardTextByteLength(path, {
            stopAfterBytes: maxPathBytes - byteLength
        });
        byteLength += measurement.byteLength;
        if (byteLength > maxPathBytes) {
            return {
                byteLength,
                pathCount,
                reason: 'paths-too-large',
                status: 'rejected'
            };
        }
    }
    return {
        byteLength,
        pathCount,
        status: 'accepted'
    };
}
export function createRejectedNativeFileDropPayload(validation) {
    return {
        byteLength: validation.byteLength,
        pathCount: validation.pathCount,
        reason: validation.reason,
        target: 'rejected'
    };
}
export function createNativeFileDropPayload(resolution, paths) {
    const validation = validateNativeFileDropPaths(paths);
    if (validation.status === 'rejected') {
        return createRejectedNativeFileDropPayload(validation);
    }
    if (resolution?.target === 'rejected') {
        return null;
    }
    if (resolution?.target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
        return {
            paths: [
                ...paths
            ],
            target: NATIVE_FILE_DROP_TARGET.fileExplorer,
            destinationDir: resolution.destinationDir
        };
    }
    if (resolution?.target === NATIVE_FILE_DROP_TARGET.composer) {
        return {
            paths: [
                ...paths
            ],
            target: resolution.target,
            ...resolution.scopeKey ? {
                scopeKey: resolution.scopeKey
            } : {}
        };
    }
    const target = resolution?.target ?? NATIVE_FILE_DROP_TARGET.editor;
    if (resolution?.target === NATIVE_FILE_DROP_TARGET.terminal) {
        return {
            paths: [
                ...paths
            ],
            target: resolution.target,
            ...resolution.tabId ? {
                tabId: resolution.tabId
            } : {},
            ...resolution.paneLeafId ? {
                paneLeafId: resolution.paneLeafId
            } : {}
        };
    }
    return {
        paths: [
            ...paths
        ],
        target
    };
}
export function isNativeFileDropPayload(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const payload = value;
    const { target } = payload;
    if (!isNativeFileDropTarget(target)) {
        return false;
    }
    if (target === 'rejected') {
        return isNonNegativeFiniteNumber(payload.byteLength) && isNonNegativeFiniteNumber(payload.pathCount) && isNativeFileDropRejectedReason(payload.reason);
    }
    if (!isNativeFileDropPathList(payload.paths)) {
        return false;
    }
    if (validateNativeFileDropPaths(payload.paths).status !== 'accepted') {
        return false;
    }
    if (target === NATIVE_FILE_DROP_TARGET.terminal) {
        return isOptionalNativeFileDropString(payload.tabId) && isOptionalNativeFileDropString(payload.paneLeafId);
    }
    if (target === NATIVE_FILE_DROP_TARGET.fileExplorer) {
        return typeof payload.destinationDir === 'string';
    }
    if (target === NATIVE_FILE_DROP_TARGET.composer) {
        return isOptionalNativeFileDropString(payload.scopeKey);
    }
    return target === NATIVE_FILE_DROP_TARGET.editor || target === NATIVE_FILE_DROP_TARGET.projectSidebar;
}
