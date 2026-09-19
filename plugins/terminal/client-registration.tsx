import type { PluginRegistration } from '@makinbakin/sdk'
import { TerminalPage } from './components/terminal-page'
export const terminalRegistration = {
  id: 'terminal',
  routes: { '/terminal': TerminalPage, '/terminal/[sessionId]': TerminalPage },
} satisfies PluginRegistration
