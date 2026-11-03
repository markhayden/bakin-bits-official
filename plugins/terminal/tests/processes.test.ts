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
  })
  control.feed('%begin 1 0 0\n%end 1 0 0\n')
  ;(processes as unknown as { controls: Map<string, unknown> }).controls.set('s1', control)
  await processes.write('s1', 'a')
  expect(lines).toEqual([
    '"display-message" "-p" "-t" "s1" "#{pane_in_mode}"',
    '"send-keys" "-X" "-t" "s1" "cancel"',
    '"send-keys" "-t" "s1" "-H" "61"',
  ])
})


test('a session keeps its fidelity through a terminate that fails, and loses it only when forgotten', async () => {
  const service = { tmux: '/bin/tmux', socket: '/tmp/fake.sock', ready: async () => true, command: async () => { throw new Error('tmux refused') } } as unknown as TerminalService
  const processes = new TmuxProcesses(service)
  ;(processes as unknown as { fidelities: Map<string, unknown> }).fidelities.set('s1', { rebuilds: { overload: 2 }, lastCause: 'overload' })
  await expect(processes.terminate('s1')).rejects.toThrow('tmux refused')
  expect(processes.fidelity('s1')).toEqual({ rebuilds: { overload: 2 }, lastCause: 'overload' })
  processes.forget('s1')
  expect(processes.fidelity('s1')).toEqual({ rebuilds: {} })
})
