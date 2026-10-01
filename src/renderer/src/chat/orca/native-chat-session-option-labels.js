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
export function nativeChatSessionOptionLabel(descriptor) {
    switch(descriptor.id){
        case 'model':
            return t('chat.orca.composer.model', 'Model');
        case 'effort':
            return t('chat.orca.composer.effort', descriptor.label);
        case 'fastMode':
            return t('chat.orca.composer.fastMode', 'Fast mode');
        case 'thinking':
            return t('chat.orca.composer.thinking', 'Thinking');
        default:
            return descriptor.label;
    }
}
export function nativeChatSessionChoiceLabel(choice) {
    switch(choice.value){
        case 'none':
            return t('chat.orca.composer.optionValue.none', 'None');
        case 'minimal':
            return t('chat.orca.composer.optionValue.minimal', 'Minimal');
        case 'low':
            return t('chat.orca.composer.optionValue.low', 'Low');
        case 'medium':
            return t('chat.orca.composer.optionValue.medium', 'Medium');
        case 'high':
            return t('chat.orca.composer.optionValue.high', 'High');
        case 'xhigh':
            return t('chat.orca.composer.optionValue.xhigh', 'Extra high');
        case 'max':
            return t('chat.orca.composer.optionValue.max', 'Max');
        case 'ultra':
            return t('chat.orca.composer.optionValue.ultra', 'Ultra');
        default:
            return choice.label;
    }
}
export function nativeChatSessionOptionDisabledReason(reason) {
    switch(reason){
        case 'set-when-session-starts':
            return t('chat.orca.composer.setWhenSessionStarts', 'Set when the session starts.');
        case 'available-after-session-start':
            return t('chat.orca.composer.availableAfterSessionStarts', 'Available after the session starts.');
        case undefined:
            return null;
    }
}
export function nativeChatModelPillLabel(descriptor) {
    if (descriptor.valueSource === 'unknown' || descriptor.kind.type !== 'select' || !descriptor.kind.currentValue) {
        return t('chat.orca.composer.model', 'Model');
    }
    return nativeChatSessionChoiceLabel(descriptor.kind.choices.find((choice)=>choice.value === descriptor.kind.currentValue) ?? {
        value: descriptor.kind.currentValue,
        label: descriptor.kind.currentValue
    });
}
export function nativeChatOptionsPillTitle(descriptors) {
    const effort = descriptors.find((descriptor)=>descriptor.id === 'effort');
    return effort ? nativeChatSessionOptionLabel(effort) : t('chat.orca.composer.sessionOptions', 'Session options');
}
export function nativeChatOptionsPillLabel(descriptors) {
    const effort = descriptors.find((descriptor)=>descriptor.id === 'effort');
    const labels = [];
    for (const descriptor of descriptors){
        if (descriptor.valueSource === 'unknown') {
            continue;
        }
        if (descriptor.kind.type === 'select' && descriptor.kind.currentValue) {
            const choice = descriptor.kind.choices.find((candidate)=>candidate.value === descriptor.kind.currentValue);
            labels.push(nativeChatSessionChoiceLabel(choice ?? {
                value: descriptor.kind.currentValue,
                label: descriptor.kind.currentValue
            }));
        } else if (descriptor.kind.type === 'boolean' && descriptor.kind.currentValue === true) {
            labels.push(descriptor.id === 'fastMode' ? t('chat.orca.composer.optionValue.fast', 'Fast') : nativeChatSessionOptionLabel(descriptor));
        }
    }
    if (labels.length > 0) {
        return labels.join(' · ');
    }
    if (effort) {
        return nativeChatSessionOptionLabel(effort);
    }
    return t('chat.orca.composer.options', 'Options');
}
