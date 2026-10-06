// After Orca's use-native-chat-file-link-click.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { renderHook } from './withSetup.js'
import { useNativeChatFileLinkClick } from '../use-native-chat-file-link-click.js'
import { createNativeChatFileHref } from '../../shared/native-chat-href-routing.js'
import { forgetHostHomes } from '../../../remoteChatLinks.js'

const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
const exists = (kind = 'file') => vi.fn(async () => kind)

function setup(context, options) {
  return renderHook(() => useNativeChatFileLinkClick(context, options)).result
}

describe('useNativeChatFileLinkClick', () => {
  // Tessel: a chat on an SSH host whose project was saved as "~/app": a full
  // host path inside it opens once the host's home folder is known.
  it('a "~/…" host project: a full path inside it opens by the project\'s path', async () => {
    forgetHostHomes()
    const remoteHome = vi.fn(async () => ({ ok: true, home: '/home/me' }))
    const had = window.shellApi
    window.shellApi = { remoteHome }
    try {
      const openFile = vi.fn()
      const root = 'ssh://ssh-box1/~/app'
      const result = setup({ worktreePath: root, roots: [root], remote: true, remoteRoot: root }, { openFile })
      await result.current(event(), '/home/me/app/src/a.js:3')
      expect(remoteHome).toHaveBeenCalledWith('ssh-box1')
      expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ file: 'ssh://ssh-box1/~/app/src/a.js', line: 3 }), expect.anything())
      // Outside the project: still refused, the home asked once.
      const onOpenFailure = vi.fn()
      const other = setup({ worktreePath: root, roots: [root], remote: true, remoteRoot: root }, { openFile, onOpenFailure })
      await other.current(event(), '/home/me/other/b.js')
      expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'outside' }))
      expect(remoteHome).toHaveBeenCalledTimes(1)
    } finally {
      window.shellApi = had
    }
  })

  it.each([
    ['docs/deck.md', '/repo/docs/deck.md', null, null],
    ['/repo/src/app.ts:12', '/repo/src/app.ts', 12, null],
    ['README.md:5:3', '/repo/README.md', 5, 3],
    ['../other/file.md', '/other/file.md', null, null],
    ['docs/plan.md#L7', '/repo/docs/plan.md', 7, null],
    ['docs/release%20notes.md', '/repo/docs/release notes.md', null, null],
    ['file:///repo/docs/release%20notes.md#L4', '/repo/docs/release notes.md', 4, null],
    [createNativeChatFileHref('My C# App/Program.cs'), '/repo/My C# App/Program.cs', null, null],
    ['C:\\repo\\app.js:6', 'C:/repo/app.js', 6, null],
    ['src/main/index.js', '/repo/src/main/index.js', null, null],
  ])('resolves %s through the viewer', async (href, file, line, col) => {
    const openFile = vi.fn()
    const statPath = exists()
    const confirmOpen = vi.fn()
    // Tessel: the pane's folders (here also /other and the C: drive repo): no question asked.
    const result = setup({ worktreePath: '/repo', roots: ['/repo', '/other', 'C:\\repo'] }, { openFile, statPath, confirmOpen })
    const click = event()
    await result.current(click, href)
    expect(statPath).toHaveBeenCalledWith(file)
    expect(confirmOpen).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenCalledWith({ file, line, col }, click)
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
  })

  describe('outside the chat folders', () => {
    it.each([
      ['../other/file.md', '/other/file.md'],
      ['C:\\Windows\\system.ini', 'C:/Windows/system.ini'],
      ['/repo/../etc/passwd', '/etc/passwd'],
      ['file:///etc/hosts', '/etc/hosts'],
    ])('asks before opening %s', async (href, file) => {
      const openFile = vi.fn()
      const confirmOpen = vi.fn(async () => true)
      const result = setup({ worktreePath: '/repo', roots: ['/repo'] }, { openFile, statPath: exists(), confirmOpen })
      await result.current(event(), href)
      expect(confirmOpen).toHaveBeenCalledWith({ path: file, kind: 'file' })
      expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ file }), expect.anything())
    })

    it('opens nothing when the question is cancelled', async () => {
      const openFile = vi.fn()
      const openSystem = vi.fn()
      const onOpenFailure = vi.fn()
      const confirmOpen = vi.fn(async () => false)
      const result = setup(
        { worktreePath: '/repo', roots: ['/repo'] },
        { openFile, openSystem, onOpenFailure, statPath: exists(), confirmOpen },
      )
      await result.current(event(), 'C:\\Users\\me\\Documents\\notes.txt')
      await result.current(event(), 'C:\\Users\\me\\Documents\\clip.mp4')
      expect(confirmOpen).toHaveBeenCalledTimes(2)
      expect(openFile).not.toHaveBeenCalled()
      expect(openSystem).not.toHaveBeenCalled()
      expect(onOpenFailure).not.toHaveBeenCalled()
    })

    it('a folder goes to the file manager, media to the system app, after the question', async () => {
      const openSystem = vi.fn(async () => ({ ok: true }))
      const confirmOpen = vi.fn(async () => true)
      const openFile = vi.fn()
      const statPath = vi.fn(async (p) => (p.endsWith('video') ? 'dir' : 'file'))
      const result = setup({ worktreePath: '/repo', roots: ['/repo'] }, { openFile, openSystem, statPath, confirmOpen })
      await result.current(event(), 'C:\\Users\\me\\Documents\\tessel-icons\\video\\')
      expect(confirmOpen).toHaveBeenLastCalledWith({ path: 'C:/Users/me/Documents/tessel-icons/video', kind: 'dir' })
      expect(openSystem).toHaveBeenLastCalledWith('C:/Users/me/Documents/tessel-icons/video')
      await result.current(event(), 'C:\\Users\\me\\Documents\\tessel-icons\\video\\tessel-logo.mp4')
      expect(openSystem).toHaveBeenLastCalledWith('C:/Users/me/Documents/tessel-icons/video/tessel-logo.mp4')
      expect(openFile).not.toHaveBeenCalled()
    })

    it("uses Tessel's own dialog (askConfirm) by default", async () => {
      const askConfirm = vi.fn(async () => true)
      const viewFile = vi.fn()
      let click
      const wrapper = mount(
        defineComponent({
          setup() {
            click = useNativeChatFileLinkClick({ worktreePath: '/repo', roots: ['/repo'] }, { statPath: exists() })
            return () => null
          },
        }),
        { global: { provide: { panelCtx: { viewFile }, askConfirm } } },
      )
      try {
        await click.value(event(), 'C:\\elsewhere\\notes.md')
        expect(askConfirm).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Open this file outside the project?', text: 'C:/elsewhere/notes.md', confirmLabel: 'Open' }),
        )
        expect(viewFile).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:/elsewhere/notes.md' }), expect.anything())
      } finally {
        wrapper.unmount()
      }
    })
  })

  it('media and documents inside the folders go to the system app', async () => {
    const openSystem = vi.fn(async () => ({ ok: true }))
    const openFile = vi.fn()
    const result = setup({ worktreePath: '/repo' }, { openFile, openSystem, statPath: exists() })
    for (const name of ['a.mp4', 'b.PNG', 'c.pdf', 'd.docx', 'e.zip', 'f.svg']) await result.current(event(), `assets/${name}`)
    expect(openSystem).toHaveBeenCalledTimes(6)
    expect(openFile).not.toHaveBeenCalled()
  })

  describe('images', () => {
    const PNG = 'C:\\Users\\me\\AppData\\Local\\Temp\\tessel-paste\\image-1.png'
    const PNG_ABS = 'C:/Users/me/AppData/Local/Temp/tessel-paste/image-1.png'
    it("open in Tessel's lightbox when there is one (after the question, outside)", async () => {
      const viewImage = vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,AAAA' }))
      const showImage = vi.fn()
      const openSystem = vi.fn()
      const confirmOpen = vi.fn(async () => true)
      const result = setup({ worktreePath: '/repo' }, { viewImage, showImage, openSystem, confirmOpen, statPath: exists() })
      await result.current(event(), PNG)
      expect(confirmOpen).toHaveBeenCalled()
      expect(viewImage).toHaveBeenCalledWith(PNG_ABS)
      expect(showImage).toHaveBeenCalledWith({ src: 'data:image/png;base64,AAAA', title: 'image-1.png', file: null })
      expect(openSystem).not.toHaveBeenCalled()
    })
    it("go to the system's app when the lightbox cannot show them", async () => {
      const viewImage = vi.fn(async () => ({ ok: false, error: 'too large' }))
      const showImage = vi.fn()
      const openSystem = vi.fn(async () => ({ ok: true }))
      const result = setup({ worktreePath: '/repo' }, { viewImage, showImage, openSystem, confirmOpen: async () => true, statPath: exists() })
      await result.current(event(), PNG)
      expect(showImage).not.toHaveBeenCalled()
      expect(openSystem).toHaveBeenCalledWith(PNG_ABS)
    })
    it('use panelCtx.showImage and shellApi.viewImage by default', async () => {
      const showImage = vi.fn()
      window.shellApi = { viewImage: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/gif;base64,R0' })) }
      let click
      const wrapper = mount(
        defineComponent({
          setup() {
            click = useNativeChatFileLinkClick({ worktreePath: '/repo' }, { statPath: exists() })
            return () => null
          },
        }),
        { global: { provide: { panelCtx: { showImage, viewFile: vi.fn() } } } },
      )
      try {
        await click.value(event(), 'assets/logo.gif')
        expect(showImage).toHaveBeenCalledWith(expect.objectContaining({ src: 'data:image/gif;base64,R0', title: 'logo.gif' }))
      } finally {
        wrapper.unmount()
        delete window.shellApi
      }
    })
  })

  it('refuses a path that does not exist, before any question', async () => {
    const openFile = vi.fn()
    const confirmOpen = vi.fn()
    const onOpenFailure = vi.fn()
    const result = setup(
      { worktreePath: '/repo' },
      { openFile, confirmOpen, onOpenFailure, statPath: vi.fn(async () => null) },
    )
    await result.current(event(), 'C:\\gone\\file.gif')
    expect(confirmOpen).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'missing', path: 'C:/gone/file.gif' }))
  })

  it('distinguishes unresolved paths from failed opens', async () => {
    const openFile = vi.fn().mockRejectedValue(new Error('unavailable'))
    const onOpenFailure = vi.fn()
    const result = setup({ worktreePath: '/workspaces/repo' }, { openFile, onOpenFailure, statPath: exists() })
    await result.current(event(), '~/.claude/plans/plan.md')
    expect(openFile).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenLastCalledWith(expect.objectContaining({ verdict: 'unresolved' }))
    await result.current(event(), 'docs/deck.md')
    expect(onOpenFailure).toHaveBeenLastCalledWith(
      expect.objectContaining({ verdict: 'unverifiable', path: '/workspaces/repo/docs/deck.md' }),
    )
  })

  it('reads the current pane context on every click and refuses remote contexts', async () => {
    const context = ref({ worktreePath: '/one' })
    const openFile = vi.fn()
    const result = setup(context, { openFile, statPath: exists() })
    context.value = { worktreePath: '/two' }
    await result.current(event(), 'file.md')
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ file: '/two/file.md' }), expect.anything())
    context.value = { worktreePath: '/remote', runtimeEnvironmentId: 'ssh:server' }
    await result.current(event(), 'file.md')
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it.each([
    'run.exe',
    'RUN.CMD',
    'run.ps1',
    'run.sh',
    'file:///tmp/run.bat',
    'C:\\Users\\me\\Desktop\\app.lnk',
    'C:\\x\\setup.msi',
    'C:\\x\\script.vbs',
    'C:\\x\\run.exe.',
    'C:\\x\\notes.txt:hidden.exe',
  ])('refuses executable %s without looking or asking', async (href) => {
    const openFile = vi.fn()
    const openSystem = vi.fn()
    const statPath = exists()
    const confirmOpen = vi.fn(async () => true)
    const onOpenFailure = vi.fn()
    const result = setup({ worktreePath: '/repo' }, { openFile, openSystem, statPath, confirmOpen, onOpenFailure })
    await result.current(event(), href)
    expect(statPath).not.toHaveBeenCalled()
    expect(confirmOpen).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(openSystem).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: expect.stringMatching(/executable|invalid/) }))
  })

  it.each([
    '\\\\server\\share\\clip.mp4',
    '//server/share/clip.mp4',
    '\\\\?\\C:\\x\\clip.mp4',
    '\\\\.\\pipe\\x',
    'file://server/share/clip.mp4',
    'C:\\x\\con.txt',
  ])('refuses network or device path %s without looking', async (href) => {
    const statPath = exists()
    const openFile = vi.fn()
    const onOpenFailure = vi.fn()
    const result = setup({ worktreePath: 'C:\\repo' }, { openFile, statPath, onOpenFailure, confirmOpen: vi.fn(async () => true) })
    await result.current(event(), href)
    expect(statPath).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalled()
    expect(onOpenFailure.mock.calls[0][0].verdict).toMatch(/network|unresolved/)
  })

  it('refuses control characters', async () => {
    const statPath = exists()
    const onOpenFailure = vi.fn()
    const result = setup({ worktreePath: '/repo' }, { openFile: vi.fn(), statPath, onOpenFailure })
    await result.current(event(), createNativeChatFileHref('docs/a\u0007b.md'))
    expect(statPath).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'control' }))
  })

  describe('through shellApi.chatFiles', () => {
    afterEach(() => {
      delete window.shellApi
    })
    it('looks with stat and opens a folder with open', async () => {
      const stat = vi.fn(async (paths) => ({ [paths[0]]: 'dir' }))
      const open = vi.fn(async () => ({ ok: true }))
      window.shellApi = { chatFiles: { stat, open } }
      const result = setup({ worktreePath: '/repo' }, { openFile: vi.fn() })
      await result.current(event(), '/repo/assets/')
      expect(stat).toHaveBeenCalledWith(['/repo/assets'])
      expect(open).toHaveBeenCalledWith('/repo/assets')
    })
  })
})
