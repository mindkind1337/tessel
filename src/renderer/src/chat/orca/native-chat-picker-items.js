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
import { isSafeDisplayCharacter, stripUnsafeDisplayCharacters } from "./shared/skill-display-text.js";
import { compareBaseSensitivityLocaleText } from '@/lib/locale-text-collators';
export { classifyNativeChatSend } from "./shared/native-chat-slash-commands.js";
const PICKER_RESULT_LIMIT = 50;
const SCOPE_PRIORITY = {
    repo: 0,
    home: 1,
    bundled: 2,
    plugin: 3
};
export function buildNativeChatPickerItems(commands, skills, query, skillSigil, sessionSkillNames) {
    const sharedSigil = skillSigil === '/';
    const unclassifiedNames = new Set(commands.filter((command)=>command.kindUnspecified).map((command)=>command.name));
    const mergedSkills = mergeNativeChatSkills(skills, sessionSkillNames, unclassifiedNames, skillSigil);
    const skillNames = new Set(mergedSkills.map((skill)=>skill.name));
    const resolvedCommands = commands.filter((command)=>!(sharedSigil && command.kindUnspecified && skillNames.has(command.name)));
    const commandNames = new Set(resolvedCommands.map((command)=>command.name));
    const commandItems = rankItems(resolvedCommands.map((command, index)=>({
            item: {
                kind: 'command',
                id: `command:${command.name}`, // i18n-ignore
                name: command.name,
                token: `/${command.name}`,
                description: command.description ? sanitizePickerText(command.description, 240) : undefined,
                argumentHint: command.argumentHint ? sanitizePickerText(command.argumentHint, 80) : undefined,
                skillCollision: sharedSigil && skillNames.has(command.name)
            },
            stableOrder: index
        })), query);
    const skillItems = rankItems(mergedSkills.filter((skill)=>!(sharedSigil && commandNames.has(skill.name))).map((item, index)=>({
            item,
            stableOrder: index
        })), query);
    return [
        ...commandItems.slice(0, PICKER_RESULT_LIMIT),
        ...skillItems.slice(0, PICKER_RESULT_LIMIT)
    ];
}
function mergeNativeChatSkills(skills, sessionSkillNames, unclassifiedNames, skillSigil) {
    const exactPaths = new Map();
    for (const skill of skills){
        if (skill.installed && !exactPaths.has(skill.skillFilePath)) {
            exactPaths.set(skill.skillFilePath, skill);
        }
    }
    const byName = new Map();
    for (const skill of exactPaths.values()){
        const safeName = getSafeSkillName(skill);
        if (!safeName) {
            continue;
        }
        byName.set(safeName, [
            ...byName.get(safeName) ?? [],
            {
                ...skill,
                name: safeName
            }
        ]);
    }
    const discovered = new Map([
        ...byName.entries()
    ].map(([name, namedSkills])=>[
            name,
            pickerSkill(name, namedSkills, skillSigil)
        ]));
    const names = sessionSkillNames !== undefined ? [
        ...sessionSkillNames.filter(isTokenSafe),
        ...[
            ...discovered.keys()
        ].filter((name)=>unclassifiedNames.has(name))
    ] : [
        ...discovered.keys()
    ];
    return [
        ...new Set(names)
    ].map((name)=>discovered.get(name) ?? pickerSkill(name, [], skillSigil)).sort(comparePickerSkills);
}
function pickerSkill(name, namedSkills, skillSigil) {
    const sorted = [
        ...namedSkills
    ].sort(compareDiscoveredSkills);
    return {
        kind: 'skill',
        id: `skill:${name}`, // i18n-ignore
        name,
        token: `${skillSigil}${name}`,
        description: sorted[0]?.description ? sanitizePickerText(sorted[0].description, 240) : null,
        sources: sorted.map((skill)=>({
                sourceKind: skill.sourceKind,
                skillFilePath: skill.skillFilePath
            }))
    };
}
function rankItems(entries, query) {
    if (!query) {
        return entries.map((entry)=>entry.item);
    }
    return entries.map((entry)=>({
            ...entry,
            rank: getMatchRank(entry.item, query)
        })).filter((entry)=>entry.rank !== null).sort((a, b)=>a.rank - b.rank || a.stableOrder - b.stableOrder).map((entry)=>entry.item);
}
function getMatchRank(item, query) {
    const normalizedQuery = query.toLocaleLowerCase();
    const name = item.name.toLocaleLowerCase();
    if (name === normalizedQuery) {
        return 0;
    }
    if (name.startsWith(normalizedQuery)) {
        return 1;
    }
    if (name.includes(normalizedQuery)) {
        return 2;
    }
    if (isSubsequence(normalizedQuery, name)) {
        return 3;
    }
    if (item.description?.toLocaleLowerCase().includes(normalizedQuery)) {
        return 4;
    }
    return null;
}
function isSubsequence(query, value) {
    let queryIndex = 0;
    for (const character of value){
        if (character === query[queryIndex]) {
            queryIndex += 1;
        }
        if (queryIndex === query.length) {
            return true;
        }
    }
    return false;
}
const MAX_TOKEN_SAFE_NAME_LENGTH = 200;
function getSafeSkillName(skill) {
    if (isTokenSafe(skill.name)) {
        return skill.name;
    }
    const directoryName = skill.directoryPath.split(/[\\/]/).findLast(Boolean) ?? '';
    return isTokenSafe(directoryName) ? directoryName : null;
}
function isTokenSafe(value) {
    return value.length > 0 && value.length <= MAX_TOKEN_SAFE_NAME_LENGTH && !/\s/u.test(value) && [
        ...value
    ].every(isSafeDisplayCharacter);
}
function sanitizePickerText(value, maxLength) {
    return stripUnsafeDisplayCharacters(value).slice(0, maxLength);
}
function compareDiscoveredSkills(a, b) {
    return SCOPE_PRIORITY[a.sourceKind] - SCOPE_PRIORITY[b.sourceKind] || compareBaseSensitivityLocaleText(a.name, b.name) || a.skillFilePath.localeCompare(b.skillFilePath);
}
const UNLOCATED_SCOPE_PRIORITY = Object.keys(SCOPE_PRIORITY).length;
function skillScopePriority(item) {
    const sourceKind = item.sources[0]?.sourceKind;
    return sourceKind === undefined ? UNLOCATED_SCOPE_PRIORITY : SCOPE_PRIORITY[sourceKind];
}
function comparePickerSkills(a, b) {
    return skillScopePriority(a) - skillScopePriority(b) || compareBaseSensitivityLocaleText(a.name, b.name);
}
export const LEADING_SLASH_TRIGGER = /^\/(\S*)$/;
export const MID_PROMPT_SLASH_TRIGGER = /\s\/([^\s/]*)$/;
export function applyPickerSuggestion(draft, caret, item) {
    const before = draft.slice(0, caret);
    const after = draft.slice(caret);
    const match = before.match(LEADING_SLASH_TRIGGER) ?? before.match(MID_PROMPT_SLASH_TRIGGER);
    if (!match) {
        return {
            draft,
            caret,
            insertedToken: ''
        };
    }
    const query = match.at(-1) ?? '';
    const tokenStart = before.length - query.length - 1;
    const nextBefore = `${before.slice(0, tokenStart)}${item.token} `;
    return {
        draft: nextBefore + after,
        caret: nextBefore.length,
        insertedToken: item.token
    };
}
