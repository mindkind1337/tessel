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
import { z } from 'zod';
import { AgentSessionContextUsageSchema } from "./agent-session-context-usage-schema.js";
const BoundedPayload = z.object({
    head: z.string(),
    byteLength: z.number(),
    digest: z.string(),
    truncated: z.boolean()
});
const ProviderFrame = z.object({
    provider: z.string(),
    kind: z.string(),
    payload: BoundedPayload
});
const ToolMetadata = {
    mcpIdentity: z.object({
        server: z.string(),
        tool: z.string()
    }).optional(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().nonnegative().optional(),
    webSearchResults: z.array(z.object({
        title: z.string(),
        url: z.string()
    })).optional()
};
const KNOWN_BLOCK_TYPES = new Set([
    'text',
    'tool-call',
    'tool-result',
    'image-ref',
    'subagent-group',
    'background-task'
]);
const ProviderCallId = z.string().refine((value)=>value.trim().length > 0, 'callId must contain a non-whitespace character');
const SubagentEntry = z.object({
    id: z.string(),
    label: z.string(),
    state: z.string().min(1),
    tokens: z.number().optional(),
    startedAt: z.number().optional(),
    settledAt: z.number().optional()
});
const Block = z.union([
    z.discriminatedUnion('type', [
        z.object({
            type: z.literal('text'),
            text: z.string(),
            presentation: z.string().optional(),
            tone: z.string().optional(),
            action: z.string().optional(),
            providerFrame: ProviderFrame.optional()
        }),
        z.object({
            type: z.literal('tool-call'),
            name: z.string(),
            input: z.unknown().optional(),
            callId: ProviderCallId.optional(),
            ...ToolMetadata
        }),
        z.object({
            type: z.literal('tool-result'),
            output: z.string(),
            isError: z.boolean().optional()
        }),
        z.object({
            type: z.literal('image-ref'),
            path: z.string().optional(),
            url: z.string().optional(),
            alt: z.string().optional()
        }),
        z.object({
            type: z.literal('subagent-group'),
            groupId: z.string(),
            agents: z.array(SubagentEntry)
        }),
        z.object({
            type: z.literal('background-task'),
            taskId: z.string().min(1),
            kind: z.string().min(1),
            label: z.string(),
            state: z.string().min(1),
            parentToolUseId: z.string().optional(),
            summary: z.string().optional(),
            error: z.string().optional(),
            outputFile: z.string().optional(),
            tokens: z.number().optional(),
            startedAt: z.number().optional(),
            settledAt: z.number().optional()
        })
    ]),
    z.object({
        type: z.string()
    }).refine((block)=>!KNOWN_BLOCK_TYPES.has(block.type))
]);
const PromptOption = z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional()
}).strict();
const Question = z.object({
    id: z.string(),
    question: z.string(),
    header: z.string().optional(),
    multiSelect: z.boolean(),
    options: z.array(PromptOption),
    freeTextQuestionId: z.string().optional()
}).strict();
const Resolution = z.object({
    state: z.string().min(1),
    selectedOptionId: z.string().nullable(),
    answers: z.array(z.object({
        questionId: z.string(),
        optionIds: z.array(z.string()),
        other: z.string().optional()
    })).optional(),
    resolvedBy: z.string().nullable(),
    resolvedAt: z.number().nullable()
});
const ApprovalMatchedAskRule = z.object({
    source: z.string(),
    toolName: z.string(),
    ruleContent: z.string().optional()
});
const ApprovalSubject = z.object({
    kind: z.literal('plan'),
    text: z.string().min(1),
    filePath: z.string().optional()
});
const MessageBody = z.object({
    kind: z.literal('message'),
    role: z.string().min(1),
    blocks: z.array(Block),
    sentAs: z.string().min(1).optional()
});
const ThreadGoal = z.object({
    objective: z.string(),
    status: z.string().min(1),
    tokenBudget: z.number().finite().nullable(),
    tokensUsed: z.number().finite(),
    timeUsedSeconds: z.number().finite(),
    createdAt: z.number().finite(),
    updatedAt: z.number().finite()
});
const ThreadGoalState = z.union([
    z.discriminatedUnion('state', [
        z.object({
            state: z.literal('set'),
            goal: ThreadGoal
        }),
        z.object({
            state: z.literal('cleared')
        })
    ]),
    z.object({
        state: z.string()
    }).refine((value)=>![
            'set',
            'cleared'
        ].includes(value.state))
]);
export const AgentJournalItemBodySchema = z.discriminatedUnion('kind', [
    MessageBody,
    z.object({
        kind: z.literal('tool-call'),
        ...ToolMetadata,
        name: z.string(),
        input: z.unknown().optional(),
        callId: ProviderCallId.optional(),
        state: z.string().min(1),
        output: BoundedPayload.optional()
    }),
    z.object({
        kind: z.literal('diff'),
        path: z.string(),
        patch: BoundedPayload
    }),
    z.object({
        kind: z.literal('approval'),
        title: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        decisionReason: z.string().optional(),
        blockedPath: z.string().optional(),
        matchedAskRule: ApprovalMatchedAskRule.optional(),
        subject: ApprovalSubject.optional(),
        detail: z.string().nullable(),
        options: z.array(PromptOption),
        resolution: Resolution
    }),
    z.object({
        kind: z.literal('question'),
        question: z.string(),
        options: z.array(PromptOption),
        questions: z.array(Question).optional(),
        freeTextQuestionId: z.string().optional(),
        resolution: Resolution
    }),
    z.object({
        kind: z.literal('status'),
        text: z.string(),
        presentation: z.string().optional(),
        tone: z.string().optional(),
        action: z.string().optional(),
        turnLifecycle: z.object({
            turnId: z.string(),
            state: z.string().min(1),
            outcome: z.string().min(1).optional(),
            userItemId: z.string().min(1).optional(),
            startedAt: z.number().finite().positive().optional(),
            requestedAt: z.number().finite().positive().optional(),
            completedAt: z.number().finite().positive().optional(),
            durationMs: z.number().finite().nonnegative().optional()
        }).optional(),
        providerFrame: ProviderFrame.optional(),
        threadGoal: ThreadGoalState.optional()
    }),
    z.object({
        kind: z.literal('turn'),
        turnId: z.string(),
        state: z.string().min(1),
        outcome: z.string().min(1).optional(),
        userItemId: z.string().min(1).optional(),
        startedAt: z.number().finite().positive().optional(),
        requestedAt: z.number().finite().positive().optional(),
        completedAt: z.number().finite().positive().optional(),
        durationMs: z.number().finite().nonnegative().optional(),
        contextUsage: AgentSessionContextUsageSchema.optional()
    })
]);
export const AgentJournalProducerLinkageFields = {
    agentId: z.string().min(1).optional(),
    parentAgentId: z.string().min(1).optional(),
    providerParentRef: z.string().min(1).optional(),
    producerKind: z.string().min(1).optional(),
    attempt: z.number().int().optional()
};
export const AgentJournalRenderItemSchema = z.object({
    itemId: z.string().min(1),
    revision: z.number().int(),
    body: AgentJournalItemBodySchema,
    sequence: z.number().int(),
    observedAt: z.number(),
    recovered: z.literal(true).optional(),
    recoveredAt: z.number().optional(),
    ...AgentJournalProducerLinkageFields
});
export const AgentJournalSubmissionSchema = z.object({
    clientMessageId: z.string().min(1),
    fence: z.number().int(),
    payloadFingerprint: z.string(),
    dispatchState: z.string().min(1),
    providerItemId: z.string().nullable(),
    reason: z.string().nullable(),
    submittedAt: z.number(),
    resolvedAt: z.number().nullable(),
    recovered: z.literal(true).optional()
});
export function isAdmissibleAgentJournalItemBody(value) {
    return AgentJournalItemBodySchema.safeParse(value).success;
}
export function isAdmissibleAgentJournalMessageBody(value) {
    return MessageBody.safeParse(value).success;
}
export function isAdmissibleAgentJournalRenderItem(value) {
    return AgentJournalRenderItemSchema.safeParse(value).success;
}
export function isAdmissibleAgentJournalSubmission(value) {
    return AgentJournalSubmissionSchema.safeParse(value).success;
}
