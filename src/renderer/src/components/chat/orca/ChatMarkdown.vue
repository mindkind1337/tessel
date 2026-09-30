<script>
// After Orca's components/sidebar/CommentMarkdown.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Markdown from an agent (or any text Tessel did not write), rendered through
 * Tessel's markdownView.js renderMarkdown (markdown-it + DOMPurify), then
 * turned into vnodes by ./chat-markdown-render.js (allowlisted tags and
 * attributes only, never v-html).
 *
 * Props:
 *   content (String, required)
 *   variant ('compact' | 'document', default 'compact')
 *   githubRepo ({ owner, repo } | null): #123 / owner/repo#123 become issue links
 *   onLinkClick ((event, href) => void): every link (and, in the document
 *     variant, every image) click; also bound by @link-click. Without it, links
 *     go through useNativeChatLinkActions (http(s) to the browser, file paths
 *     to Tessel's viewer, anything else refused).
 *   allowFileUriLinks (Boolean): kept for the reference's callers; file: URIs
 *     are always dropped by renderMarkdown, only linkified text paths remain.
 *   linkifyFilePaths (Boolean): paths in prose / inline code become file links
 *   expandImages (Boolean): compact images open a lightbox
 *   renderCodeBlock (component): fenced blocks in the document variant, given
 *     { language } and the <code> as its default slot (e.g. NativeChatCodeBlock)
 *   fileLinkContext (Object | null, Tessel): the worktree context of the
 *     fallback link actions (useNativeChatFileLinkContext's value)
 * Class and attributes go to the root <div>.
 *
 * Clicking a link never navigates the window: the default action is always
 * prevented (a middle click too); a right click is left alone.
 */
import { computed, defineComponent, h, inject, shallowRef, toValue, watch } from 'vue'
import { renderMarkdown } from '../../../markdownView'
import { useNativeChatLinkActions } from '../../../chat/orca/composables/use-native-chat-link-actions.js'
import { applyInlineCodeFileLinks, resolveInlineCodeFiles } from './chat-inline-code-files.js'
import {
  createCompactRenderers,
  createDocumentRenderers,
  linkifyFilePaths as linkifyFilePathsInDom,
  linkifyGitHubReferences,
  parseSanitizedHtml,
  protectLocalMarkdownLinks,
  renderMarkdownFragment
} from './chat-markdown-render.js'

const compactRenderers = createCompactRenderers()
const documentRenderers = createDocumentRenderers()

export default defineComponent({
  name: 'ChatMarkdown',
  props: {
    content: { type: String, required: true },
    variant: { type: String, default: 'compact' },
    githubRepo: { type: Object, default: null },
    onLinkClick: { type: Function, default: undefined },
    allowFileUriLinks: { type: Boolean, default: false },
    linkifyFilePaths: { type: Boolean, default: false },
    expandImages: { type: Boolean, default: false },
    renderCodeBlock: { type: [Object, Function], default: undefined },
    fileLinkContext: { type: Object, default: null }
  },
  setup(props) {
    const root = shallowRef(null)
    const fallback = useNativeChatLinkActions(() => props.fileLinkContext, root)

    function onAnchorClick(event, href) {
      // Why: link clicks should not also trigger an outer row/card handler.
      event.stopPropagation()
      // Tessel: the window never follows a link from agent text.
      event.preventDefault()
      const handler = props.onLinkClick ?? fallback.onLinkClick.value
      handler?.(event, href)
    }

    function onImageClick(event, src) {
      props.onLinkClick?.(event, src)
    }

    // The sanitized document, transformed; re-made only when the text or the
    // transforms change (not on every re-render).
    const baseFragment = computed(() => {
      const parsed = parseSanitizedHtml(renderMarkdown(protectLocalMarkdownLinks(props.content)))
      if (props.linkifyFilePaths) linkifyFilePathsInDom(parsed)
      if (props.githubRepo) linkifyGitHubReferences(parsed, props.githubRepo)
      return parsed
    })

    // Tessel: inline code naming a file that exists becomes a link
    // (chat-inline-code-files.js); looked up once per message, in main.
    const injectedContext = inject('nativeChatFileLinkContext', null)
    const linkContext = computed(() => props.fileLinkContext ?? toValue(injectedContext) ?? null)
    const codeFiles = shallowRef(null)
    let lookup = 0
    watch(
      [baseFragment, linkContext, () => props.linkifyFilePaths],
      ([parsed, context, linkify]) => {
        const run = ++lookup
        codeFiles.value = null
        const stat = globalThis.window?.shellApi?.chatFiles?.stat
        if (!linkify || !context || !stat) return
        resolveInlineCodeFiles({ fragment: parsed, content: props.content, context, stat }).then((found) => {
          if (run === lookup && found.size) codeFiles.value = found
        })
      },
      { immediate: true }
    )
    const fragment = computed(() =>
      codeFiles.value ? applyInlineCodeFileLinks(baseFragment.value.cloneNode(true), codeFiles.value) : baseFragment.value
    )

    return () => {
      const isDocument = props.variant === 'document'
      const ctx = {
        renderers: isDocument ? documentRenderers : compactRenderers,
        renderCodeBlock: props.renderCodeBlock,
        expandImages: props.expandImages,
        hasLinkClick: props.onLinkClick !== undefined,
        onAnchorClick,
        onImageClick
      }
      return h(
        'div',
        { ref: root, class: ['chat-md', isDocument ? 'cm-document' : 'cm-compact'] },
        renderMarkdownFragment(fragment.value, ctx)
      )
    }
  }
})
</script>

<style scoped>
.chat-md {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
/* Preflight-like resets (zero specificity: the renderers' classes win);
   Tessel's global element styles never leak in. */
.chat-md :where(p, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, figure, dl, dd) {
  margin: 0;
}
.chat-md :where(ul, ol) {
  padding: 0;
}
.chat-md :where(h1, h2, h3, h4, h5, h6) {
  font-size: inherit;
  font-weight: inherit;
}
.chat-md :where(a) {
  color: inherit;
}
.chat-md :where(code, pre, kbd, samp) {
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
}
.chat-md pre code {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font-size: inherit;
}

/* --- compact ------------------------------------------------------------- */
.cm-c-link {
  text-decoration-line: underline;
  text-underline-offset: 2px;
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
}
.cm-c-link:hover {
  color: var(--nc-foreground);
}
/* Inline code naming a file: the code's look, a link's underline on hover. */
.chat-md .cm-code-link {
  color: inherit;
  text-decoration-line: none;
  cursor: pointer;
}
.chat-md .cm-code-link:hover,
.chat-md .cm-code-link:focus-visible {
  color: inherit;
  text-decoration-line: underline;
  text-underline-offset: 2px;
}
.cm-c-code {
  border-radius: 4px;
  background: var(--nc-accent);
  padding: 1px 4px;
  font-size: 10px;
  overflow-wrap: anywhere;
}
.cm-c-pre {
  margin: 4px 0;
  max-height: 128px;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 4px;
  background: var(--nc-accent);
  padding: 6px;
  font-size: 10px;
}
.cm-c-ul,
.cm-c-ol {
  margin: 2px 0 2px 12px;
}
.cm-c-ul {
  list-style: disc;
}
.cm-c-ol {
  list-style: decimal;
}
.cm-c-li {
  line-height: 1.5;
}
.cm-bold {
  font-weight: 700;
}
.cm-semibold {
  font-weight: 600;
}
.cm-c-hr {
  height: 0;
  margin: 4px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 50%, transparent);
}
.cm-c-blockquote {
  margin: 2px 0;
  border-left: 2px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  padding-left: 8px;
  color: color-mix(in srgb, var(--nc-muted-foreground) 80%, transparent);
}
.cm-c-img {
  margin: 4px 0;
  max-height: 128px;
  max-width: 100%;
  border-radius: 4px;
  object-fit: contain;
  outline: 1px solid color-mix(in srgb, var(--nc-border) 70%, transparent);
}
.cm-c-table-wrap {
  margin: 4px 0;
  max-width: 100%;
  overflow-x: auto;
}
.cm-c-table {
  border-collapse: collapse;
  font-size: 10px;
}
.cm-c-table :deep(:is(td, th)) {
  border: 1px solid color-mix(in srgb, var(--nc-border) 40%, transparent);
  padding: 2px 4px;
}
.cm-c-table :deep(th) {
  font-weight: 600;
  text-align: left;
}

/* --- document ------------------------------------------------------------ */
.cm-d-p {
  margin: 8px 0;
}
.cm-d-p:first-child {
  margin-top: 0;
}
.cm-d-p:last-child {
  margin-bottom: 0;
}
.cm-d-link {
  word-break: break-all;
  color: var(--nc-primary);
  text-decoration-line: underline;
  text-underline-offset: 2px;
}
.cm-d-link:hover {
  color: color-mix(in srgb, var(--nc-primary) 80%, transparent);
}
.cm-d-code {
  border-radius: 4px;
  background: var(--nc-accent);
  padding: 2px 6px;
  font-size: 0.92em;
  overflow-wrap: anywhere;
}
.cm-d-pre {
  margin: 12px 0;
  max-height: 320px;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--nc-accent);
  padding: 12px;
  font-size: 12px;
}
.cm-d-mermaid {
  margin: 12px 0;
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  padding: 12px;
}
.cm-d-mermaid :deep(.mermaid-block) {
  min-width: 0;
}
.cm-d-mermaid :deep(.mermaid-block-img) {
  display: block;
  max-width: 100%;
}
.cm-d-mermaid :deep(.mermaid-block pre) {
  margin: 0;
  max-height: 320px;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--nc-accent);
  padding: 12px;
  font-size: 12px;
}
.cm-d-ul,
.cm-d-ol {
  margin: 8px 0 8px 20px;
}
.cm-d-ul {
  list-style: disc;
}
.cm-d-ol {
  list-style: decimal;
}
.cm-d-ul > * + *,
.cm-d-ol > * + * {
  margin-top: 4px;
}
.cm-d-li {
  line-height: 1.625;
}
.cm-d-h1,
.cm-d-h2,
.cm-d-h3 {
  margin-bottom: 8px;
  font-weight: 600;
  line-height: 1.25;
}
.cm-d-h1 {
  margin-top: 16px;
  font-size: 18px;
}
.cm-d-h2 {
  margin-top: 16px;
  font-size: 16px;
}
.cm-d-h3 {
  margin-top: 12px;
  font-size: 15px;
}
.cm-d-h4 {
  margin-top: 12px;
  margin-bottom: 4px;
  font-weight: 600;
}
:is(.cm-d-h1, .cm-d-h2, .cm-d-h3, .cm-d-h4):first-child {
  margin-top: 0;
}
.cm-d-hr {
  height: 0;
  margin: 16px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
}
.cm-d-blockquote {
  margin: 12px 0;
  border-left: 2px solid color-mix(in srgb, var(--nc-border) 70%, transparent);
  padding-left: 12px;
  color: var(--nc-muted-foreground);
}
.cm-d-img {
  margin: 12px 0;
  max-height: 384px;
  max-width: 100%;
  border-radius: 6px;
  object-fit: contain;
  outline: 1px solid rgb(255 255 255 / 0.1);
}
.cm-d-img.is-clickable {
  cursor: pointer;
}
.cm-d-table-wrap {
  margin: 12px 0;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
}
.cm-d-table {
  min-width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.cm-d-table :deep(:is(td, th)) {
  border: 1px solid color-mix(in srgb, var(--nc-border) 50%, transparent);
  padding: 6px 8px;
}
.cm-d-table :deep(th) {
  background: color-mix(in srgb, var(--nc-muted) 60%, transparent);
  text-align: left;
  font-weight: 600;
}
.cm-d-li > :deep(input) {
  pointer-events: none;
}
</style>
