import type { PluginRegistration } from '@makinbakin/sdk'
import { TerminalPage } from './components/terminal-page'
import { TerminalAttentionProvider } from './components/attention-provider'
export const terminalRegistration = {
  id: 'terminal',
  routes: { '/terminal': TerminalPage, '/terminal/[sessionId]': TerminalPage },
  slots: { 'nav-badge-providers': TerminalAttentionProvider },
} satisfies PluginRegistration
