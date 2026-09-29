// After Orca's NativeChatToolRun.identity.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import NativeChatToolRun from '../NativeChatToolRun.vue'
import {
  NativeChatDisclosureContext,
  provideNativeChatDisclosures
} from '../../../../chat/orca/composables/native-chat-disclosure-store.js'
import { buttonNamed, byText, clickEvent, queryByText } from './native-chat-tool-test-dom.js'

vi.mock('../NativeChatDiffCard.vue', () => ({ default: { name: 'NativeChatDiffCard', render: () => null } }))
vi.mock('../NativeChatDiffView.vue', () => ({ default: { name: 'NativeChatDiffView', render: () => null } }))

const disclosureWrite = vi.fn()
const capturedDisclosures = {
  read: () => undefined,
  write: (key, open) => disclosureWrite(key, open)
}

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  disclosureWrite.mockReset()
})

const shell = {
  type: 'tool-call',
  name: 'shell',
  input: { command: 'missing-command' },
  state: 'failed',
  exitCode: 127,
  durationMs: 400
}

function render(component, props, provide) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(component, { props, attachTo: container, global: provide ? { provide } : {} })
  return {
    container,
    rerender: async (next) => {
      await wrapper.setProps(next)
      await nextTick()
    }
  }
}

const ToolRunDisclosureHarness = defineComponent({
  props: { expandOverride: { type: Boolean, required: true } },
  setup(props) {
    provideNativeChatDisclosures()
    return () =>
      h(NativeChatToolRun, {
        blocks: [shell],
        expandSignal: false,
        expandOverride: props.expandOverride,
        activeTurnIsWorking: false,
        disclosureId: 'message-1'
      })
  }
})

async function click(element) {
  clickEvent(element)
  await nextTick()
}

describe('inline tool annotations', () => {
  it('restores a per-run deviation when its turn returns to the same disclosure state', async () => {
    const { container, rerender } = render(ToolRunDisclosureHarness, { expandOverride: true })
    const run = container.querySelector('button[aria-expanded="true"]')

    await click(run)
    expect(run.getAttribute('aria-expanded')).toBe('false')

    await rerender({ expandOverride: false })
    expect(container.querySelector('button')).toBeNull()

    await rerender({ expandOverride: true })
    expect(buttonNamed(container, /missing-command/).getAttribute('aria-expanded')).toBe('false')
  })

  it('resynchronizes a standalone run when the toolbar signal flips', async () => {
    const { container, rerender } = render(NativeChatToolRun, {
      blocks: [shell],
      expandSignal: false,
      activeTurnIsWorking: false
    })
    expect(container.querySelector('button').getAttribute('aria-expanded')).toBe('false')

    await rerender({ blocks: [shell], expandSignal: true, activeTurnIsWorking: false })

    expect(buttonNamed(container, /missing-command/).getAttribute('aria-expanded')).toBe('true')
  })

  it('uses provider call identities for byte-identical line disclosure keys', async () => {
    const { container } = render(
      NativeChatToolRun,
      { blocks: [{ ...shell, callId: 'call-a' }, { ...shell, callId: 'call-b' }], expandSignal: true, disclosureId: 'message-1' },
      { [NativeChatDisclosureContext]: capturedDisclosures }
    )

    await click(container.querySelectorAll('button')[2])

    expect(disclosureWrite).toHaveBeenCalledTimes(1)
    expect(disclosureWrite).toHaveBeenCalledWith('line:message-1:call:call-b', false)
  })

  it('keeps occurrence identity as the fallback for calls without provider IDs', async () => {
    const { container } = render(
      NativeChatToolRun,
      { blocks: [shell, shell], expandSignal: true, disclosureId: 'message-1' },
      { [NativeChatDisclosureContext]: capturedDisclosures }
    )

    await click(container.querySelectorAll('button')[2])

    expect(disclosureWrite).toHaveBeenCalledTimes(1)
    expect(disclosureWrite).toHaveBeenCalledWith('line:message-1:tool-call:shell:{"command":"missing-command"}:1', false)
  })

  it('keeps occurrence identity for whitespace-only provider IDs', async () => {
    const { container } = render(
      NativeChatToolRun,
      { blocks: [{ ...shell, callId: ' ' }, { ...shell, callId: '\t' }], expandSignal: true, disclosureId: 'message-1' },
      { [NativeChatDisclosureContext]: capturedDisclosures }
    )

    await click(container.querySelectorAll('button')[2])

    expect(disclosureWrite).toHaveBeenCalledTimes(1)
    expect(disclosureWrite).toHaveBeenCalledWith('line:message-1:tool-call:shell:{"command":"missing-command"}:1', false)
  })

  it('keeps command completion annotations on the collapsed tool line', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [shell],
      expandSignal: false,
      expandOverride: true,
      activeTurnIsWorking: false
    })
    expect(byText(container, 'exit 127').closest('button')).toBe(byText(container, '400ms').closest('button'))
    expect(byText(container, 'exit 127').closest('button').getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(container, '0s')).toBeNull()
  })

  it('renders a legacy command without invented metadata', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name: 'shell', input: null }],
      expandSignal: true
    })
    expect(container.textContent).not.toMatch(/exit \d/)
    expect(container.textContent).not.toMatch(/\d+ms/)
  })

  it('shows distinct MCP names while retaining the raw identifier', () => {
    const name = 'mcp__linear__list_issues'
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name, input: null }],
      expandSignal: true
    })
    expect(queryByText(container, 'Linear')).not.toBeNull()
    expect(queryByText(container, 'list issues')).not.toBeNull()
    expect(container.querySelector(`[title="${name}"]`)).not.toBeNull()
  })

  it('reveals safe result links only inside row disclosure and routes clicks through chat', async () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const { container } = render(NativeChatToolRun, {
      blocks: [
        {
          type: 'tool-call',
          name: 'web_search',
          input: { query: 'docs' },
          state: 'completed',
          webSearchResults: [{ title: 'Reference docs', url: 'https://example.com/docs' }]
        }
      ],
      expandSignal: false,
      expandOverride: true,
      onLinkClick
    })
    expect(container.querySelector('a')).toBeNull()
    await click(byText(container, 'web_search', 'code').closest('button'))
    const link = container.querySelector('a')
    expect(link.textContent).toMatch(/Reference docs/)
    expect(link.getAttribute('href')).toBe('https://example.com/docs')
    expect(link.closest('button')).toBeNull()
    await click(link)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.com/docs')
    link.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onLinkClick).toHaveBeenCalledTimes(2)
  })

  it('never lets a result link navigate the window without the chat router (Tessel)', async () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [
        {
          type: 'tool-call',
          name: 'web_search',
          input: null,
          webSearchResults: [{ title: 'Docs', url: 'https://example.com/docs' }]
        }
      ],
      expandSignal: true
    })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    container.querySelector('a').dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('tool names', () => {
  it.each(['tools/read', 'browser.open', 'package.lock', 'linear/list_issues'])(
    'keeps an ordinary tool name %s intact',
    (name) => {
      const { container } = render(NativeChatToolRun, { blocks: [{ type: 'tool-call', name, input: null }], expandSignal: true })
      expect(queryByText(container, name, 'code')).not.toBeNull()
      expect(container.querySelector('.lucide-plug')).toBeNull()
    }
  )

  it.each(['running', 'completed'])('renders provider MCP identity on %s rows and headers', (state) => {
    const name = 'my_server/ns.tool'
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name, input: null, state, mcpIdentity: { server: 'my_server', tool: 'ns.tool' } }],
      expandSignal: true,
      activeTurnIsWorking: state === 'running'
    })
    expect(queryByText(container, 'My server')).not.toBeNull()
    expect(queryByText(container, 'ns.tool')).not.toBeNull()
    expect(container.querySelector(`[title="${name}"]`)).not.toBeNull()
    // The run header's glyph plus the row's, both plug.
    expect(container.querySelectorAll('.lucide-plug')).toHaveLength(2)
  })

  it.each([
    [{ exitCode: 0 }, 'exit 0', '400ms'],
    [{ durationMs: 400 }, '400ms', 'exit 0']
  ])('renders independently optional command metadata %j', (metadata, present, absent) => {
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name: 'shell', input: null, ...metadata }],
      expandSignal: true
    })
    expect(queryByText(container, present)).not.toBeNull()
    expect(queryByText(container, absent)).toBeNull()
  })

  it('filters untrusted persisted result URLs at the renderer boundary', async () => {
    const onLinkClick = vi.fn((event) => event.preventDefault())
    const { container } = render(NativeChatToolRun, {
      blocks: [
        {
          type: 'tool-call',
          name: 'web_search',
          input: null,
          webSearchResults: [
            { title: 'Script', url: 'javascript:alert(1)' },
            { title: 'Local file', url: 'file:///tmp/secret' },
            { title: 'App route', url: 'orca://open' },
            { title: 'Protocol relative', url: '//example.com' },
            { title: 'Data', url: 'data:text/html,hello' },
            { title: 'Docs', url: 'https://example.com/docs' }
          ]
        }
      ],
      expandSignal: true,
      onLinkClick
    })
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    await click(links[0])
    expect(onLinkClick).toHaveBeenCalledTimes(1)
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), 'https://example.com/docs')
  })
})
