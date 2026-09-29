// After Orca's native-chat-provider-frame-summary.ts (MIT, Copyright (c) 2026 Lovecast Inc.)

export function nativeChatProviderFrameSummary(block) {
  const frame = block.providerFrame
  if (!frame) {
    return block.text
  }
  return block.text === `${frame.provider} · ${frame.kind}` ? frame.kind : block.text
}
