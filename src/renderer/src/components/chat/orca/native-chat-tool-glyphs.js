// After Orca's NativeChatToolIcon.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// Glyph name to component, shared by NativeChatToolIcon and NativeChatToolRunIcon
// so a row and its run header can never draw one category differently.
import {
  Bot,
  Eye,
  Folder,
  Globe,
  ListChecks,
  MessageSquareMore,
  Pencil,
  Plug,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-vue-next'

export const NATIVE_CHAT_TOOL_GLYPHS = {
  eye: Eye,
  search: Search,
  folder: Folder,
  'square-terminal': SquareTerminal,
  pencil: Pencil,
  globe: Globe,
  plug: Plug,
  bot: Bot,
  'list-checks': ListChecks,
  wrench: Wrench,
  'message-square-more': MessageSquareMore
}
