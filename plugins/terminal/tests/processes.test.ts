import { expect, test } from 'bun:test'
import { TmuxProcesses } from '../lib/processes'
import type { TerminalService } from '../lib/service'

test('alive treats an empty tmux server as no matching process', async () => {
  const calls: unknown[] = []
  const service = {
    tmux: '/opt/homebrew/bin/tmux',
    socket: '/tmp/fake.sock',
    ready: async () => true,
    command: async (args: string[], optional?: boolean) => {
      calls.push({ args, optional })
      return ''
    },
  } as unknown as TerminalService

  await expect(new TmuxProcesses(service).alive('terminal-missing')).resolves.toBe(false)
  expect(calls).toEqual([{ args: ['list-panes', '-a', '-F', '#{session_name} #{pane_dead}'], optional: true }])
})
