// Explicit operations only: the renderer cannot supply GraphQL or gh argv.
import { createGithubService } from './githubService'
import { createLinearService } from './linearService'

export function registerIssueServices({ ipcMain, dir, safeStorage, github, linear, onPrCreated }) {
  const services = {
    github: github || createGithubService(),
    linear: linear || createLinearService({ dir, safeStorage })
  }
  const methods = {
    github: [
      'status',
      'list',
      'detail',
      'createIssue',
      'createPr',
      'checks',
      'action',
      'startPoint'
    ],
    linear: ['status', 'connect', 'disconnect', 'issues', 'teams', 'states', 'setState']
  }
  for (const [provider, names] of Object.entries(methods)) {
    for (const name of names) {
      ipcMain.handle(`${provider}:${name}`, async (_event, query) => {
        try {
          const result = await services[provider][name](query || {})
          if (provider === 'github' && name === 'createPr' && result?.ok && result.url) {
            // Statistics cannot turn a successfully created PR into a failure.
            try {
              await onPrCreated?.(result.url)
            } catch {
              /* Preserve the successful PR result. */
            }
          }
          return result
        } catch {
          return {
            ok: false,
            error: `${provider === 'github' ? 'GitHub' : 'Linear'} could not complete this request.`
          }
        }
      })
    }
  }
  return services
}
