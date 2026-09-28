import { installedUsageProviders } from '../../shared/usageProviders'
// Version-skew fallback uses only known collectors and installed agents.
export async function loadUsageProviders() {
  if (window.shellApi?.providerUsage?.capabilities) {
    const result = await window.shellApi.providerUsage.capabilities()
    if (!result?.ok || !Array.isArray(result.providers))
      throw new Error('Could not detect usage providers.')
    return result.providers
  }
  if (!window.shellApi?.listAgents)
    throw new Error('Usage provider detection is unavailable. Restart Tessel.')
  return installedUsageProviders(await window.shellApi.listAgents())
    .filter((p) => p.report)
    .map((p) => ({ ...p, quota: true }))
}
