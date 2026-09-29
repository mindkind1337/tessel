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
import { getKeybindingPlatform } from "./definitions.js";
import { hasModifier } from "./parser.js";
import { canFallBackToPhysicalCode, logicalKeyTokenFromInput, physicalCodeKeyTokenFromInput, numpadCodeKeyTokenFromInput, isPunctuationKeyToken } from "./input.js";
export function platformModifiers(parsed, platform) {
    const isMac = platform === 'darwin';
    return {
        meta: parsed.meta || parsed.mod && isMac,
        control: parsed.control || parsed.mod && !isMac,
        alt: parsed.alt,
        shift: parsed.shift
    };
}
export function modifierStateMatches(parsed, input, platform) {
    const expected = platformModifiers(parsed, platform);
    return hasModifier(input, 'meta') === expected.meta && hasModifier(input, 'control') === expected.control && hasModifier(input, 'alt') === expected.alt && hasModifier(input, 'shift') === expected.shift;
}
export function shouldUseMacOptionLetterPhysicalFallback(parsed, input, platform) {
    return getKeybindingPlatform(platform) === 'darwin' && parsed.alt && hasModifier(input, 'alt') && logicalKeyTokenFromInput(input) === null;
}
export function shouldUseMacOptionPunctuationPhysicalFallback(parsed, input, platform) {
    return getKeybindingPlatform(platform) === 'darwin' && parsed.alt && hasModifier(input, 'alt') && logicalKeyTokenFromInput(input) === null;
}
export function letterKeyMatches(input, letter, parsed, platform) {
    const logicalKey = logicalKeyTokenFromInput(input);
    if (logicalKey && logicalKey.length === 1 && logicalKey >= 'A' && logicalKey <= 'Z') {
        return logicalKey === letter.toUpperCase();
    }
    return (canFallBackToPhysicalCode(input, platform) || shouldUseMacOptionLetterPhysicalFallback(parsed, input, platform)) && input.code === `Key${letter.toUpperCase()}`; // i18n-ignore
}
export function digitKeyMatches(input, digit, platform) {
    const logicalKey = logicalKeyTokenFromInput(input);
    if (logicalKey && logicalKey.length === 1 && logicalKey >= '0' && logicalKey <= '9') {
        return logicalKey === digit;
    }
    return canFallBackToPhysicalCode(input, platform) && input.code === `Digit${digit}`; // i18n-ignore
}
export function semanticPunctuationKey(input) {
    const logicalKey = logicalKeyTokenFromInput(input);
    return isPunctuationKeyToken(logicalKey) ? logicalKey : null;
}
export function physicalPunctuationKey(input) {
    const physicalKey = physicalCodeKeyTokenFromInput(input);
    return isPunctuationKeyToken(physicalKey) ? physicalKey : null;
}
export function shouldUseSemanticPunctuation(parsed, input, platform) {
    if (getKeybindingPlatform(platform) !== 'darwin' && parsed.mod && parsed.alt && hasModifier(input, 'control') && hasModifier(input, 'alt') && !hasModifier(input, 'meta') && physicalPunctuationKey(input) === null) {
        return false;
    }
    return true;
}
export function keyMatches(parsedKey, input, parsed, platform) {
    if (parsedKey.length === 1 && parsedKey >= 'A' && parsedKey <= 'Z') {
        return letterKeyMatches(input, parsedKey, parsed, platform);
    }
    if (parsedKey.length === 1 && parsedKey >= '0' && parsedKey <= '9') {
        return digitKeyMatches(input, parsedKey, platform);
    }
    if (parsedKey === 'NumpadAdd' || parsedKey === 'NumpadSubtract') {
        return numpadCodeKeyTokenFromInput(input) === parsedKey || logicalKeyTokenFromInput(input) === parsedKey;
    }
    if (isPunctuationKeyToken(parsedKey)) {
        const semanticKey = semanticPunctuationKey(input);
        if (semanticKey !== null) {
            if (!shouldUseSemanticPunctuation(parsed, input, platform)) {
                return false;
            }
            return semanticKey === parsedKey;
        }
        return (canFallBackToPhysicalCode(input, platform) || shouldUseMacOptionPunctuationPhysicalFallback(parsed, input, platform)) && physicalPunctuationKey(input) === parsedKey;
    }
    const logicalKey = logicalKeyTokenFromInput(input);
    if (logicalKey !== null) {
        return logicalKey === parsedKey;
    }
    return canFallBackToPhysicalCode(input, platform) && physicalCodeKeyTokenFromInput(input) === parsedKey;
}
export function resolveModifierToken(modifier, platform) {
    switch(modifier){
        case 'Mod':
            return platform === 'darwin' ? 'meta' : 'control';
        case 'Cmd':
            return 'meta';
        case 'Ctrl':
            return 'control';
        case 'Alt':
            return 'alt';
        case 'Shift':
            return 'shift';
    }
}
