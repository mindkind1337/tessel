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
const WINDOWS_DRIVE_PATH_PREFIX = /^\/[A-Za-z]:\//;
const UNC_PATH_PREFIX = /^(?:\\\\|\/\/)([^\\/]+)[\\/]+([^\\/]+)(?:[\\/](.*))?$/;
function encodePathSegments(path) {
    return path.split('/').map((segment, index)=>{
        if (index === 0 && /^[A-Za-z]:$/.test(segment)) {
            return segment;
        }
        return encodeURIComponent(segment);
    }).join('/');
}
export function filesystemPathToFileUri(filePath) {
    const uncMatch = UNC_PATH_PREFIX.exec(filePath);
    if (uncMatch) {
        const [, host, share, rest = ''] = uncMatch;
        const pathSegments = [
            share,
            ...rest.replaceAll('\\', '/').split('/').filter(Boolean)
        ];
        return `file://${encodeURIComponent(host)}/${pathSegments.map(encodeURIComponent).join('/')}`; // i18n-ignore
    }
    const normalizedPath = filePath.startsWith('/') ? filePath : filePath.replaceAll('\\', '/');
    const encodedPath = encodePathSegments(normalizedPath);
    return normalizedPath.startsWith('/') ? `file://${encodedPath}` : `file:///${encodedPath}`; // i18n-ignore
}
export function filesystemPathHrefToFileUri(filePathHref) {
    const suffixIndex = filePathHref.search(/[?#]/);
    if (suffixIndex === -1) {
        return filesystemPathToFileUri(filePathHref);
    }
    const pathPart = filePathHref.slice(0, suffixIndex);
    const suffix = filePathHref.slice(suffixIndex);
    const url = new URL(filesystemPathToFileUri(pathPart));
    if (suffix.startsWith('#')) {
        url.hash = suffix;
        return url.toString();
    }
    const hashIndex = suffix.indexOf('#');
    url.search = hashIndex === -1 ? suffix : suffix.slice(0, hashIndex);
    if (hashIndex !== -1) {
        url.hash = suffix.slice(hashIndex);
    }
    return url.toString();
}
export function fileUriToFilesystemPath(url) {
    if (url.protocol !== 'file:') {
        return null;
    }
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(url.pathname);
    } catch  {
        return null;
    }
    if (url.hostname && url.hostname !== 'localhost') {
        return `//${url.hostname}${decodedPath}`;
    }
    if (WINDOWS_DRIVE_PATH_PREFIX.test(decodedPath)) {
        return decodedPath.slice(1);
    }
    return decodedPath;
}
