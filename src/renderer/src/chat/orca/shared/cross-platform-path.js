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
import { isWslUncPath, parseWslUncPath, toWindowsWslPath } from "./wsl-paths.js";
const SLASH_CHAR_CODE = '/'.charCodeAt(0);
export function isWindowsAbsolutePathLike(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('//');
}
export function isCaseInsensitiveRuntimeRoot(rootPath) {
    return isWindowsAbsolutePathLike(rootPath) && !isWslUncPath(rootPath);
}
export function normalizeRuntimePathSeparators(value) {
    const normalized = collapseRuntimePathSlashes(value.includes('\\') ? value.replace(/\\/g, '/') : value);
    if (value.startsWith('\\\\') || value.startsWith('//')) {
        return `//${normalized.replace(/^\/+/, '')}`;
    }
    return normalized;
}
function collapseRuntimePathSlashes(value) {
    return value.includes('//') ? value.replace(/\/+/g, '/') : value;
}
export function normalizeRuntimePathForComparison(rawValue) {
    const value = rawValue.normalize('NFC');
    const isWindowsPath = isWindowsAbsolutePathLike(value);
    const normalized = trimRuntimePathTrailingSlash(isWindowsPath ? normalizeRuntimePathSeparators(value) : collapseRuntimePathSlashes(value));
    const wslUnc = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/[\s\S]*)?$/i);
    if (wslUnc) {
        return `//wsl/${wslUnc[1].toLowerCase()}${wslUnc[2] ?? ''}`;
    }
    return isWindowsPath ? normalized.toLowerCase() : normalized;
}
export function isWslUncPathForCallerLinuxPath(uncPath, linuxPath, callerDistro) {
    const parsed = parseWslUncPath(uncPath);
    if (!parsed) {
        return false;
    }
    return parsed.distro.toLowerCase() === callerDistro.toLowerCase() && normalizeRuntimePathForComparison(parsed.linuxPath) === normalizeRuntimePathForComparison(linuxPath);
}
export function isWslUncPathForLinuxMountedPath(uncPath, linuxPath) {
    const parsed = parseWslUncPath(uncPath);
    if (!parsed || !/^\/mnt\/[A-Za-z](?:\/|$)/.test(parsed.linuxPath)) {
        return false;
    }
    if (!/^\/mnt\/[A-Za-z](?:\/|$)/.test(linuxPath)) {
        return false;
    }
    return normalizeRuntimePathForComparison(toWindowsWslPath(parsed.linuxPath, parsed.distro)) === normalizeRuntimePathForComparison(toWindowsWslPath(linuxPath, parsed.distro));
}
export function areLocalWindowsWslPathAliases(left, right) {
    const leftIdentity = getLocalWindowsWslPathIdentity(left);
    const rightIdentity = getLocalWindowsWslPathIdentity(right);
    return (leftIdentity.isWslUnc || rightIdentity.isWslUnc) && leftIdentity.aliasComparisonPath === rightIdentity.aliasComparisonPath;
}
export function getLocalWindowsWslPathIdentity(value) {
    const wslPath = parseWslUncPath(value);
    const normalizedPath = normalizeRuntimePathForComparison(value);
    return {
        normalizedPath,
        aliasComparisonPath: wslPath ? normalizeRuntimePathForComparison(toWindowsWslPath(wslPath.linuxPath, wslPath.distro)) : normalizedPath,
        isWslUnc: wslPath !== null
    };
}
export function isRuntimePathAbsolute(value, pathFlavor = isWindowsPathFlavor(value) ? 'windows' : 'posix') {
    if (pathFlavor === 'windows') {
        return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\') || value.startsWith('/');
    }
    return value.startsWith('/');
}
export function resolveRuntimePath(basePath, targetPath) {
    const pathFlavor = isWindowsPathFlavor(basePath) || isWindowsPathFlavor(targetPath) ? 'windows' : 'posix';
    if (isRuntimePathAbsolute(targetPath, pathFlavor)) {
        return normalizeRuntimePathDots(targetPath, pathFlavor);
    }
    return normalizeRuntimePathDots(`${trimRuntimePathTrailingSlash(normalizeRuntimePathSeparators(basePath))}/${targetPath}`, pathFlavor);
}
export function getRuntimePathBasename(value) {
    const trimmed = value.replace(/[\\/]+$/g, '');
    if (!trimmed) {
        return '';
    }
    const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return trimmed.slice(separator + 1);
}
export function createNormalizedPathInsideOrEqualMatcher(rootPath) {
    const root = normalizeRuntimePathForComparison(rootPath);
    const rootWithBoundary = root === '/' || /^[a-z]:\/$/i.test(root) ? root : `${root.replace(/\/+$/, '')}/`;
    return (normalizedCandidate)=>normalizedCandidate === root || normalizedCandidate.startsWith(rootWithBoundary);
}
export function isPathInsideOrEqual(rootPath, candidatePath) {
    return createNormalizedPathInsideOrEqualMatcher(rootPath)(normalizeRuntimePathForComparison(candidatePath));
}
export function relativePathInsideRoot(rootPath, candidatePath) {
    const normalizedCandidate = trimRuntimePathTrailingSlash(isWindowsAbsolutePathLike(candidatePath.normalize('NFC')) ? normalizeRuntimePathSeparators(candidatePath) : collapseRuntimePathSlashes(candidatePath));
    const comparisonRoot = normalizeRuntimePathForComparison(rootPath);
    const comparisonCandidate = normalizeRuntimePathForComparison(candidatePath);
    if (comparisonCandidate === comparisonRoot) {
        return '';
    }
    const isRoot = comparisonRoot === '/' || /^[a-z]:\/$/i.test(comparisonRoot);
    const comparisonPrefix = isRoot ? comparisonRoot : `${comparisonRoot}/`;
    if (!comparisonCandidate.startsWith(comparisonPrefix)) {
        return null;
    }
    return sliceCandidatePastRootSegments(comparisonRoot, normalizedCandidate);
}
function sliceCandidatePastRootSegments(root, candidate) {
    let remainingRootSegments = 0;
    let inRootSegment = false;
    for(let index = 0; index < root.length; index++){
        if (root.charCodeAt(index) === SLASH_CHAR_CODE) {
            inRootSegment = false;
        } else if (!inRootSegment) {
            inRootSegment = true;
            remainingRootSegments++;
        }
    }
    let inSegment = false;
    for(let index = 0; index < candidate.length; index++){
        if (candidate.charCodeAt(index) === SLASH_CHAR_CODE) {
            inSegment = false;
            continue;
        }
        if (!inSegment) {
            inSegment = true;
            if (remainingRootSegments-- === 0) {
                return candidate.slice(index);
            }
        }
    }
    return '';
}
function trimRuntimePathTrailingSlash(value) {
    if (!value.endsWith('/')) {
        return value;
    }
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    return value.replace(/\/+$/, '');
}
function isWindowsPathFlavor(value) {
    return /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\') || value.startsWith('//');
}
function normalizeRuntimePathDots(value, pathFlavor) {
    const normalized = normalizeRuntimePathSeparators(value);
    const { root, rest } = splitRuntimePathRoot(normalized, pathFlavor);
    const segments = [];
    for (const segment of rest.split('/')){
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            if (segments.length > 0 && segments.at(-1) !== '..') {
                segments.pop();
            } else if (!root) {
                segments.push(segment);
            }
            continue;
        }
        segments.push(segment);
    }
    const suffix = segments.join('/');
    if (!root) {
        return suffix || '.';
    }
    return suffix ? `${root}${suffix}` : trimRuntimePathTrailingSlash(root);
}
function splitRuntimePathRoot(value, pathFlavor) {
    if (pathFlavor === 'windows') {
        const drive = value.match(/^([A-Za-z]:)(?:\/|$)/);
        if (drive) {
            return {
                root: `${drive[1]}/`,
                rest: value.slice(drive[0].length)
            };
        }
        if (value.startsWith('//')) {
            const parts = value.slice(2).split('/');
            if (parts.length >= 2 && parts[0] && parts[1]) {
                const root = `//${parts[0]}/${parts[1]}/`;
                return {
                    root,
                    rest: parts.slice(2).join('/')
                };
            }
            return {
                root: '//',
                rest: value.slice(2)
            };
        }
        if (value.startsWith('/')) {
            return {
                root: '/',
                rest: value.slice(1)
            };
        }
    }
    if (value.startsWith('/')) {
        return {
            root: '/',
            rest: value.slice(1)
        };
    }
    return {
        root: '',
        rest: value
    };
}
