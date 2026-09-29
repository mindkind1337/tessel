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
const SLASH_CHAR_CODE = '/'.charCodeAt(0);
const BACKSLASH_CHAR_CODE = '\\'.charCodeAt(0);
function isPathSeparatorCharCode(charCode) {
    return charCode === SLASH_CHAR_CODE || charCode === BACKSLASH_CHAR_CODE;
}
export function parseWslUncPath(path) {
    if (!isPathSeparatorCharCode(path.charCodeAt(0)) || !isPathSeparatorCharCode(path.charCodeAt(1))) {
        return null;
    }
    const normalized = path.includes('\\') ? path.replace(/\\/g, '/') : path;
    const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
    if (!match) {
        return null;
    }
    return {
        distro: match[2],
        linuxPath: match[3] || '/'
    };
}
export function isWslUncPath(path) {
    return parseWslUncPath(path) !== null;
}
export function toLinuxPath(windowsPath) {
    const info = process.platform === 'win32' ? parseWslUncPath(windowsPath) : null;
    if (info) {
        return info.linuxPath;
    }
    const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)$/);
    if (!driveMatch) {
        return windowsPath;
    }
    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/');
    return `/mnt/${driveLetter}/${rest}`; // i18n-ignore
}
export function toWindowsWslPath(linuxPath, distro) {
    return toWindowsWslDrivePath(linuxPath) ?? toWindowsWslUncPath(linuxPath, distro);
}
export function toWindowsWslUncPath(linuxPath, distro) {
    return `\\\\wsl.localhost\\${distro}${linuxPath === '/' ? '\\' : linuxPath.replace(/\//g, '\\')}`; // i18n-ignore
}
export function resolveWslRepoWorktreeBasePath(repoPath, basePath) {
    const repoWsl = parseWslUncPath(repoPath);
    if (!repoWsl || !/^\/(?!\/)/.test(basePath)) {
        return basePath;
    }
    const collapsed = collapsePosixDotSegments(basePath);
    return toWindowsWslUncPath(collapsed, repoWsl.distro);
}
function collapsePosixDotSegments(absolutePosixPath) {
    const segments = [];
    for (const segment of absolutePosixPath.split('/')){
        if (!segment || segment === '.') {
            continue;
        }
        if (segment === '..') {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return `/${segments.join('/')}`;
}
export function foldWslUncPathCaseInsensitiveParts(path) {
    const parsed = parseWslUncPath(path);
    if (!parsed) {
        return null;
    }
    const linuxPath = /^\/mnt\/[a-zA-Z](?:\/|$)/.test(parsed.linuxPath) ? parsed.linuxPath.toLowerCase() : parsed.linuxPath;
    return `//wsl.localhost/${parsed.distro.toLowerCase()}${linuxPath === '/' ? '' : linuxPath}`; // i18n-ignore
}
export function toWslExecutionSpace(path) {
    return parseWslUncPath(path)?.linuxPath ?? path;
}
const DRVFS_LINUX_PATH = /^\/mnt\/[a-z](?:\/|$)/;
export function isDrvfsLinuxPath(linuxPath) {
    return DRVFS_LINUX_PATH.test(linuxPath);
}
export function toWindowsWslDrivePath(linuxPath) {
    const match = linuxPath.match(/^\/mnt\/([a-z])(\/.*)?$/);
    if (!match) {
        return null;
    }
    const tail = (match[2] ?? '').replace(/\//g, '\\');
    return `${match[1].toUpperCase()}:${tail || '\\'}`;
}
export function getWslFilesystemBoundaryDistro(args) {
    const wsl = parseWslUncPath(args.projectPath);
    if (wsl) {
        return isDrvfsLinuxPath(wsl.linuxPath) ? wsl.distro : null;
    }
    if (!/^[A-Za-z]:[\\/]/.test(args.projectPath)) {
        return null;
    }
    return args.wslRuntimeDistro || null;
}
