// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import { join, resolve, relative, sep } from 'path'
import { createProviderLogin } from '../providerLogin'

describe('private login process with a local inert CLI fixture', () => {
  it('collects a browser link from a real PTY and verifies status in the same disposable home', async () => {
    const root = await fs.mkdtemp(join(os.tmpdir(), 'tessel-account-login-'))
    try {
      const script = join(root, 'fake cli.cjs')
      await fs.writeFile(
        script,
        `const fs=require('fs'); const path=require('path');
if(process.argv.includes('status')) {
  process.stdout.write(JSON.stringify({loggedIn:true,email:'fixture@test.invalid', config:process.env.CLAUDE_CONFIG_DIR}));
} else {
  fs.writeFileSync(path.join(process.env.HOME,'fixture-env.json'), JSON.stringify({home:process.env.HOME,profile:process.env.USERPROFILE,config:process.env.CLAUDE_CONFIG_DIR,key:process.env.ANTHROPIC_API_KEY||null,args:process.argv.slice(2)}));
  process.stdout.write('https://claude.ai/oauth/authorize?state=INERT-FIXTURE\\r\\n');
  setTimeout(()=>process.exit(0),150);
}`
      )
      const links = []
      const login = createProviderLogin({
        env: { ...process.env, ANTHROPIC_API_KEY: 'fixture-secret' },
        resolveCommand: () => ({ file: process.execPath, pre: [script] }),
        timeoutMs: 10000
      })
      const result = await login({
        provider: 'claude',
        home: root,
        onProgress: (data) => links.push(data)
      })
      expect(result.ok).toBe(true)
      expect(result.status).toMatchObject({ email: 'fixture@test.invalid', config: root })
      expect(links).toEqual([{ url: 'https://claude.ai/oauth/authorize?state=INERT-FIXTURE' }])
      expect(JSON.parse(await fs.readFile(join(root, 'fixture-env.json'), 'utf8'))).toEqual({
        home: root,
        profile: root,
        config: root,
        key: null,
        args: ['auth', 'login', '--claudeai']
      })
    } finally {
      const rel = relative(resolve(os.tmpdir()), resolve(root))
      if (rel.startsWith('tessel-account-login-') && !rel.includes(sep))
        await fs.rm(root, { recursive: true })
    }
  }, 20000)
})
