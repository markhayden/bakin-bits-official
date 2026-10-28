import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PASTE_END, PASTE_START } from '../lib/paste'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'
import { tmuxConfig } from '../lib/tmux-config'

// Spec D9 item 2 against the managed tmux: a bracketed paste from a viewer
// reaches the program bracketed only if the program enabled bracketed paste.
// Run with TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip

const bakinHome = mkdtempSync(join(tmpdir(), 'bakin-terminal-home-'))
if (process.env.TERMINAL_PROCESS_TEST === '1') {
  const tmux = process.env.TERMINAL_TMUX ?? Bun.which('tmux')
  if (!tmux) throw new Error('TERMINAL_PROCESS_TEST needs tmux: set TERMINAL_TMUX to the managed binary')
  mkdirSync(join(bakinHome, 'bin'), { recursive: true })
  symlinkSync(tmux, join(bakinHome, 'bin', 'tmux'))
  process.env.BAKIN_HOME = bakinHome
}
afterAll(() => rmSync(bakinHome, { recursive: true, force: true }))

const human = { kind: 'human', id: 'integration-browser' } as const

processTest('a viewer paste is bracketed only when the program enabled bracketed paste, and leaves no buffer or file behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-paste-'))
  const service = new TerminalService(root)
  const config = join(root, 'tmux.conf')
  writeFileSync(config, tmuxConfig())
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', config], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  let manager: Sessions | undefined
  const until = async (check: () => Promise<boolean>, label: string) => {
    for (const start = Date.now(); Date.now() - start < 15_000; await Bun.sleep(50)) if (await check()) return
    throw new Error(`Timed out: ${label}`)
  }
  try {
    await until(() => service.ready(), 'service')
    manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), { settings: () => ({}), prepare: async () => undefined, release: async () => undefined })
    const session = await manager.create({ title: 'Paste', cwd: root }, human, { cols: 100, rows: 30, kind: 'browser', device: 'desktop' })
    const screen = async () => (await manager!.readScreen(session.id, human)).screen
    const type = (data: string) => manager!.writeNext(session.id, human, session.generation, data)
    await until(async () => (await screen()).trim().length > 0, 'prompt')
    // cat -v shows the markers if they arrive; the shell turns bracketed paste off before running it.
    await type('stty -echo; cat -v\r')
    await Bun.sleep(400)
    await type(`${PASTE_START}PLAIN_ONE\rPLAIN_TWO${PASTE_END}\r`)
    await until(async () => (await screen()).includes('PLAIN_TWO'), 'plain paste')
    expect(await screen()).not.toContain('[200~')
    await type('\x03')
    // A program that enabled bracketed paste gets the markers around the text.
    await type(`stty -echo; printf '\\033[?2004h'; cat -v\r`)
    await Bun.sleep(400)
    await type(`${PASTE_START}BRACKETED${PASTE_END}\r`)
    await until(async () => (await screen()).includes('BRACKETED'), 'bracketed paste')
    expect(await screen()).toContain('^[[200~BRACKETED^[[201~')
    expect((await service.command(['list-buffers'])).trim()).toBe('')
    expect(readdirSync(join(root, 'paste'))).toEqual([])
  } finally {
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill()
    await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)
