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
// English fallback catalog; the renderer translates at the call site.
export const NATIVE_CHAT_TURN_STATUS_COPY = {
    thinking: 'Thinking',
    workingFor: 'Working for {{value0}}', // i18n-ignore
    workedFor: 'Worked for {{value0}}', // i18n-ignore
    toggleDetails: 'Toggle turn details', // i18n-ignore
    responding: 'Agent is responding' // i18n-ignore
};
export function formatNativeChatDuration(seconds) {
    const totalSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    if (minutes < 60) {
        return `${minutes}m ${remainingSeconds}s`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ${remainingSeconds}s`;
}
export function describeNativeChatTurnStatus({ thinking, workedSeconds, elapsedSeconds }) {
    if (workedSeconds != null) {
        return {
            key: 'workedFor',
            duration: formatNativeChatDuration(workedSeconds)
        };
    }
    if (thinking) {
        return {
            key: 'thinking',
            duration: null
        };
    }
    return {
        key: 'workingFor',
        duration: formatNativeChatDuration(elapsedSeconds)
    };
}
export function describeNativeChatActiveTurnLabel({ activityText, thinking, elapsedSeconds }) {
    const text = activityText?.trim();
    if (text) {
        return {
            source: 'activity',
            text
        };
    }
    return thinking ? {
        source: 'status',
        key: 'thinking',
        duration: null
    } : {
        source: 'status',
        key: 'workingFor',
        duration: formatNativeChatDuration(elapsedSeconds)
    };
}
export function formatNativeChatActiveTurnLabel(input) {
    const label = describeNativeChatActiveTurnLabel(input);
    if (label.source === 'activity') {
        return label.text;
    }
    const copy = NATIVE_CHAT_TURN_STATUS_COPY[label.key];
    return label.duration == null ? copy : copy.replaceAll('{{value0}}', label.duration);
}
export function formatNativeChatTurnStatusLabel(input) {
    const { key, duration } = describeNativeChatTurnStatus(input);
    const copy = NATIVE_CHAT_TURN_STATUS_COPY[key];
    return duration == null ? copy : copy.replaceAll('{{value0}}', duration);
}
export function reduceNativeChatTurnTiming(current, { activeTurnKey, previousActiveTurnKey, validTurnKeys, isWorking, workingStartedAt, now }) {
    const replacedTiming = previousActiveTurnKey !== undefined && previousActiveTurnKey !== activeTurnKey && !validTurnKeys.has(previousActiveTurnKey) && current[activeTurnKey] === undefined ? current[previousActiveTurnKey] : undefined;
    let retained = replacedTiming ? {
        ...current,
        [activeTurnKey]: replacedTiming
    } : current;
    for (const turnKey of Object.keys(retained)){
        if (turnKey !== activeTurnKey && !validTurnKeys.has(turnKey)) {
            if (retained === current) {
                retained = {
                    ...current
                };
            }
            delete retained[turnKey];
        }
    }
    const timing = retained[activeTurnKey];
    if (isWorking) {
        const startedAt = timing && timing.workedSeconds == null ? workingStartedAt === null || workingStartedAt === undefined ? timing.startedAt : Math.min(timing.startedAt, workingStartedAt) : workingStartedAt ?? now;
        if (timing?.startedAt === startedAt && timing.workedSeconds == null) {
            return retained;
        }
        return {
            ...retained,
            [activeTurnKey]: {
                startedAt,
                workedSeconds: null
            }
        };
    }
    if (timing?.workedSeconds != null) {
        return retained;
    }
    const startedAt = timing?.startedAt ?? workingStartedAt;
    if (startedAt == null) {
        return retained;
    }
    return {
        ...retained,
        [activeTurnKey]: {
            startedAt,
            workedSeconds: Math.max(0, Math.floor((now - startedAt) / 1000))
        }
    };
}
export function selectNativeChatTurnStatuses(timingByTurn, { activeTurnKey, isWorking, workingStartedAt, thinking, settledByTurn }) {
    const completedByTurn = Object.fromEntries(Object.entries(timingByTurn).filter(([, timing])=>timing.workedSeconds != null).map(([turnKey, timing])=>[
            turnKey,
            {
                startedAt: timing.startedAt,
                thinking: false,
                workedSeconds: timing.workedSeconds
            }
        ]));
    for (const [turnKey, settled] of settledByTurn ?? []){
        if (settled === null) {
            delete completedByTurn[turnKey];
            continue;
        }
        completedByTurn[turnKey] = {
            startedAt: settled.startedAt,
            thinking: false,
            workedSeconds: settled.workedSeconds
        };
    }
    return {
        active: isWorking ? {
            startedAt: timingByTurn[activeTurnKey]?.startedAt ?? workingStartedAt ?? null,
            thinking,
            workedSeconds: null
        } : completedByTurn[activeTurnKey] ?? null,
        completedByTurn
    };
}
export function nativeChatElapsedSeconds(startedAt, fallbackStartedAt, now) {
    return Math.max(0, Math.floor((now - (startedAt ?? fallbackStartedAt)) / 1000));
}
