import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'

const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip
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
    await wait(async () => (await manager!.readScreen(session.id, human)).includes('BAKIN_TERMINAL_READY'))
    await manager.resize(session.id, human, 1, 80, 24)
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{pane_width} #{pane_height}'])).trim()).toBe('80 24')
    await manager.shutdown()
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), options)
    await manager.start()
    expect(await service.command(['display-message', '-p', '-t', session.id, '#{pane_pid}'])).toBe(pid)
    await wait(async () => (await manager!.readScreen(session.id, human)).includes('BAKIN_TERMINAL_READY'))
    expect(manager.get(session.id, human).owner).toEqual(human)
    await manager.finish(session.id, human, 1, true)
    expect(manager.get(session.id, human).state).toBe('completed')
    if (process.env.TERMINAL_CLI_TEST === '1') {
      for (const program of ['claude', 'codex'] as const) {
        const cli = await manager.create({ title: program, program, checkout: 'existing', cwd: root }, human)
        await wait(async () => (await manager!.readScreen(cli.id, human)).trim().length > 0)
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
