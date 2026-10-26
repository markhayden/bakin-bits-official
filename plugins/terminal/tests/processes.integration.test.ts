import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ControlClient } from '../lib/control'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'

const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip

// Terminal runs only the managed tmux (`$BAKIN_HOME/bin/tmux`). These tests
// give a throwaway home that binary: TERMINAL_TMUX, else the pinned version
// found on PATH. Run with the managed pin before merging (plan D12).
const bakinHome = mkdtempSync(join(tmpdir(), 'bakin-terminal-home-'))
if (process.env.TERMINAL_PROCESS_TEST === '1') {
  const tmux = process.env.TERMINAL_TMUX ?? Bun.which('tmux')
  if (!tmux) throw new Error('TERMINAL_PROCESS_TEST needs tmux: set TERMINAL_TMUX to the managed binary')
  mkdirSync(join(bakinHome, 'bin'), { recursive: true })
  symlinkSync(tmux, join(bakinHome, 'bin', 'tmux'))
  process.env.BAKIN_HOME = bakinHome
}
afterAll(() => rmSync(bakinHome, { recursive: true, force: true }))

processTest('boot marks stored running sessions exited when the tmux server is empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-empty-'))
  const service = new TerminalService(root)
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', '/dev/null'], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  const human = { kind: 'human', id: 'integration-browser' } as const
  let manager: Sessions | undefined
  try {
    for (let attempt = 0; attempt < 100 && !await service.ready(); attempt++) await Bun.sleep(50)
    await service.command(['set-option', '-g', 'exit-empty', 'off'])
    const store = new Store(join(root, 'terminal.db'))
    store.save({
      id: 'terminal-ghost', title: 'Ghost', cwd: root, program: 'shell', owner: human,
      generation: 1, inputSequence: 0, cols: 100, rows: 30, sizeEpoch: 0, sizeRevision: 0, state: 'running',
      createdAt: Date.now(), lastActivityAt: Date.now(),
    })
    manager = new Sessions(store, new TmuxProcesses(service), { settings: () => ({}), prepare: async () => undefined, release: async () => undefined })
    // Regression: list-panes -a on a running but empty server exits with
    // "no current target"; activation must recover the session as exited.
    await manager.start()
    expect(manager.get('terminal-ghost', human).state).toBe('exited')
  } finally {
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

processTest('real shell survives manager restart, accepts input, resizes and terminates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-process-'))
  const service = new TerminalService(root)
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', '/dev/null'], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  let manager: Sessions | undefined
  const options = { settings: () => ({}), prepare: async () => undefined, release: async () => undefined }
  const human = { kind: 'human', id: 'integration-browser' } as const
  const wait = async (predicate: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await Bun.sleep(50) }
    throw new Error('Process probe timed out')
  }
  try {
    await wait(() => service.ready())
    await service.command(['set-option', '-g', 'exit-empty', 'off'])
    await service.command(['set-option', '-g', 'remain-on-exit', 'on'])
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), options)
    const session = await manager.create({ title: 'Integration', cwd: root }, human)
    const pid = await service.command(['display-message', '-p', '-t', session.id, '#{pane_pid}'])
    await Bun.sleep(250)
    await manager.write(session.id, human, 1, 1, 'printf "BAKIN_TERMINAL_READY\\n"\r')
    await wait(async () => (await manager!.readScreen(session.id, human)).screen.includes('BAKIN_TERMINAL_READY'))
    await manager.claim(session.id, human, 80, 24, { kind: 'browser', device: 'desktop' })
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{pane_width} #{pane_height}'])).trim()).toBe('80 24')
    await manager.shutdown()
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), options)
    await manager.start()
    expect(await service.command(['display-message', '-p', '-t', session.id, '#{pane_pid}'])).toBe(pid)
    await wait(async () => (await manager!.readScreen(session.id, human)).screen.includes('BAKIN_TERMINAL_READY'))
    expect(manager.get(session.id, human).owner).toEqual(human)
    await manager.finish(session.id, human, 1, true)
    expect(manager.get(session.id, human).state).toBe('completed')
    if (process.env.TERMINAL_CLI_TEST === '1') {
      for (const program of ['claude', 'codex'] as const) {
        const cli = await manager.create({ title: program, program, checkout: 'existing', cwd: root }, human)
        await wait(async () => (await manager!.readScreen(cli.id, human)).screen.trim().length > 0)
        expect(await new TmuxProcesses(service).alive(cli.id)).toBe(true)
        await manager.finish(cli.id, human, 1, true)
      }
    }
  } finally {
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

processTest('control client: command round trip, quoting, subscriptions and exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-control-'))
  const service = new TerminalService(root)
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', '/dev/null'], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  let client: ControlClient | undefined
  try {
    for (let attempt = 0; attempt < 100 && !await service.ready(); attempt++) await Bun.sleep(50)
    await service.command(['new-session', '-d', '-s', 'control-probe', '-x', '80', '-y', '24', 'cat'])
    const notifications: string[] = []
    client = ControlClient.attach(service.tmux!, service.socket, 'control-probe', terminalEnvironment(), (line) => notifications.push(line))
    await client.ready
    // Quoting survives tmux's parser: quotes, $ and backslashes stay literal.
    await client.command(['set-option', '-p', '-t', 'control-probe', '@bakin_title', 'Say "hi" $HOME \\ ok'])
    expect(await client.command(['display-message', '-p', '-t', 'control-probe', '#{@bakin_title}'])).toEqual(['Say "hi" $HOME \\ ok'])
    // Input bypasses key tables and arrives byte-exact.
    await client.sendKeys('control-probe', new TextEncoder().encode('hello control\r'))
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await service.command(['capture-pane', '-p', '-t', 'control-probe'])).includes('hello control')) break
      await Bun.sleep(50)
    }
    expect(await service.command(['capture-pane', '-p', '-t', 'control-probe'])).toContain('hello control')
    // A failed command reports tmux's own message.
    await expect(client.command(['kill-session', '-t', 'no-such-session'])).rejects.toThrow("can't find session")
    // Format subscriptions notify on change.
    await client.command(['refresh-client', '-B', 'title:%*:#{@bakin_title}'])
    await client.command(['set-option', '-p', '-t', 'control-probe', '@bakin_title', 'changed'])
    for (let attempt = 0; attempt < 60 && !notifications.some((line) => line.startsWith('%subscription-changed title') && line.endsWith(': changed')); attempt++) await Bun.sleep(50)
    expect(notifications.some((line) => line.startsWith('%subscription-changed title') && line.endsWith(': changed'))).toBe(true)
    // The control client does not count toward the window size (ignore-size).
    await service.command(['resize-window', '-t', 'control-probe', '-x', '120', '-y', '40'])
    expect((await service.command(['display-message', '-p', '-t', 'control-probe', '#{window_width}x#{window_height}'])).trim()).toBe('120x40')
    // Killing the server ends the control connection and rejects new work.
    await service.command(['kill-server'], true)
    await expect(client.command(['list-clients'])).rejects.toThrow()
  } finally {
    client?.close()
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 20000)

processTest('bridge: titles the session, cancels copy-mode before input, and only resize-window sizes the window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-bridge-'))
  const service = new TerminalService(root)
  const config = join(root, 'tmux.conf')
  await Bun.write(config, (await import('../lib/tmux-config')).tmuxConfig())
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', config], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  const human = { kind: 'human', id: 'integration-browser' } as const
  const options = { settings: () => ({}), prepare: async () => undefined, release: async () => undefined }
  let manager: Sessions | undefined
  let other: ReturnType<typeof Bun.spawn> | undefined
  const wait = async (predicate: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await Bun.sleep(50) }
    throw new Error('Bridge probe timed out')
  }
  try {
    await wait(() => service.ready())
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), options)
    const session = await manager.create({ title: 'Bridge "probe"', cwd: root }, human)
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{@bakin_title}'])).trim()).toBe('Bridge "probe"')
    // Another client of a different size (as a native terminal would be) does not resize the window.
    other = Bun.spawn([service.tmux!, '-S', service.socket, 'attach-session', '-t', session.id], { env: terminalEnvironment(), terminal: { cols: 60, rows: 15, data: () => {} } })
    await wait(async () => (await service.command(['list-clients', '-t', session.id, '-F', '#{client_width}'])).includes('60'))
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{window_width}x#{window_height}'])).trim()).toBe(`${session.cols}x${session.rows}`)
    // Input cancels a pane left in copy mode, then reaches the shell.
    await service.command(['copy-mode', '-t', session.id])
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{pane_in_mode}'])).trim()).toBe('1')
    await manager.write(session.id, human, session.generation, 1, 'printf "AFTER_COPY_MODE\\n"\r')
    await wait(async () => (await manager!.readScreen(session.id, human)).screen.includes('AFTER_COPY_MODE'))
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{pane_in_mode}'])).trim()).toBe('0')
    // An explicit resize goes through the control client.
    const claimed = await manager.claim(session.id, human, 90, 20, { kind: 'browser', device: 'desktop' })
    expect(claimed.sizeRevision).toBeGreaterThan(0)
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{window_width}x#{window_height}'])).trim()).toBe('90x20')
    await manager.finish(session.id, human, session.generation, true)
  } finally {
    other?.kill()
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)

