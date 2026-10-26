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

test('write queries copy mode, cancels it with its own awaited command, then sends the keys', async () => {
  const lines: string[] = []
  const service = { tmux: '/bin/tmux', socket: '/tmp/fake.sock', ready: async () => true, command: async () => '' } as unknown as TerminalService
  const processes = new TmuxProcesses(service)
  const { ControlClient } = await import('../lib/control')
  let reply = 0
  const control = new ControlClient({
    write: (line) => {
      lines.push(line.trim())
      reply++
      const body = line.includes('#{pane_in_mode}') ? '1\n' : ''
      queueMicrotask(() => control.feed(`%begin 1 ${reply} 1\n${body}%end 1 ${reply} 1\n`))
    },
    close: () => {}, exited: new Promise(() => {}),
  }, () => {})
  control.feed('%begin 1 0 0\n%end 1 0 0\n')
  ;(processes as unknown as { controls: Map<string, unknown>; clients: Map<string, unknown> }).controls.set('s1', control)
  ;(processes as unknown as { clients: Map<string, unknown> }).clients.set('s1', {})
  await processes.write('s1', 'a')
  expect(lines).toEqual([
    '"display-message" "-p" "-t" "s1" "#{pane_in_mode}"',
    '"send-keys" "-X" "-t" "s1" "cancel"',
    '"send-keys" "-t" "s1" "-H" "61"',
  ])
})

