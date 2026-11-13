// A root the daemon listed wrong (host/remote.ts distrust): its tree ends,
// it is no longer served or listed by the daemon, also when its tree was
// still opening, until that host's connection ends (closeHost); another
// host's roots are left alone.
import { describe, it, expect, vi } from 'vitest'

const opened = []
vi.mock('../host/tree', async (orig) => {
  const actual = await orig()
  class FakeTree {
    constructor(path) {
      this.path = path
      this.ended = false
    }
    async expand() {
      return { entries: [{ name: Buffer.from('a').toString('base64'), kind: 'file' }], truncated: false, watched: true }
    }
    async end() {
      this.ended = true
    }
  }
  return {
    ...actual,
    Tree: {
      open: async (client, path) => {
        if (client.wait) await client.wait
        const t = new FakeTree(path)
        opened.push(t)
        return t
      }
    }
  }
})
const { createRemoteExplorer } = await import('../host/remote')

function explorer(client = {}) {
  return createRemoteExplorer({
    daemons: { client: () => client },
    send: () => {},
    childPath: (r, rel) => `${r}\\${rel}`,
    relativeTo: () => '',
    joinPath: (a, b) => `${a}/${b}`,
    sortEntries: (e) => e
  })
}

describe('a distrusted root', () => {
  it('ends its tree, is not served or listed, until its host reconnects', async () => {
    opened.length = 0
    const x = explorer()
    x.watch('ssh://h1/srv/app', 'h1', '/srv/app')
    expect(await x.list('ssh://h1/srv/app', '', true)).not.toBeNull()
    expect(x.served('ssh://h1/srv/app')).toBe(true)
    x.distrust('ssh://h1/srv/app', 'h1')
    expect(opened[0].ended).toBe(true)
    expect(x.served('ssh://h1/srv/app')).toBe(false)
    expect(await x.list('ssh://h1/srv/app', '', true)).toBeNull()
    expect(await x.list('ssh://h1/srv/app', 'sub', true)).toBeNull()
    // Watched again (another project shown, then this one): still not.
    x.unwatchAll()
    x.watch('ssh://h1/srv/app', 'h1', '/srv/app')
    expect(await x.list('ssh://h1/srv/app', '', true)).toBeNull()
    // Another host's connection ending: no change.
    x.closeHost('h2')
    expect(await x.list('ssh://h1/srv/app', '', true)).toBeNull()
    // This host's: served by the daemon again.
    x.closeHost('h1')
    expect(await x.list('ssh://h1/srv/app', '', true)).not.toBeNull()
    expect(x.served('ssh://h1/srv/app')).toBe(true)
  })

  it('a tree still opening when the root is distrusted is ended, not kept', async () => {
    opened.length = 0
    let go
    const x = explorer({ wait: new Promise((r) => (go = r)) })
    x.watch('ssh://h1/srv/app', 'h1', '/srv/app')
    const pending = x.list('ssh://h1/srv/app', '', true)
    await Promise.resolve()
    x.distrust('ssh://h1/srv/app', 'h1')
    go()
    await pending
    await new Promise((r) => setTimeout(r, 0))
    expect(opened).toHaveLength(1)
    expect(opened[0].ended).toBe(true)
    expect(x.served('ssh://h1/srv/app')).toBe(false)
  })
})
