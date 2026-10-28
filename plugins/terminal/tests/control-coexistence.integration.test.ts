import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeliveryUncertainError } from '../lib/contracts'
import type { ControlClient } from '../lib/control'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'

// Plan T31b: with the pane's output streaming through the control client,
// every command it carries keeps working (spec D13). Real tmux; run with
// TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
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

// Prints numbered lines as fast as it can and answers every input line once.
const FLOOD = `$|=1; use IO::Select; my $s = IO::Select->new(\\*STDIN); my $i = 0;
while (1) { print "n ", ++$i, "\\n"; if ($s->can_read(0)) { my $l = <STDIN>; last unless defined $l; chomp $l; print "GOT[$l]\\n" } }`

processTest('commands keep working while output floods the control client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-coexist-'))
  const service = new TerminalService(root)
  const config = join(root, 'tmux.conf')
  await Bun.write(config, (await import('../lib/tmux-config')).tmuxConfig())
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', config], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  const human = { kind: 'human', id: 'integration-browser' } as const
  const operator = { kind: 'human', id: 'cli' } as const
  const options = { settings: () => ({ enabledAgents: [{ id: 'patch' }] }), prepare: async () => undefined, release: async () => undefined }
  const processes = new TmuxProcesses(service)
  let manager: Sessions | undefined
  const apps: Array<ReturnType<typeof Bun.spawn>> = []
  const wait = async (predicate: () => boolean | Promise<boolean>, label: string, ms = 20000) => {
    for (const start = Date.now(); Date.now() - start < ms; await Bun.sleep(25)) if (await predicate()) return
    throw new Error(`Coexistence probe timed out: ${label}`)
  }
  try {
    await wait(() => service.ready(), 'service')
    manager = new Sessions(new Store(join(root, 'terminal.db')), processes, options)
    const session = await manager.create({ title: 'Flood', cwd: root, agentId: 'patch' }, human)
    // Watch the event log: answers, numbered lines and layout changes.
    const answers = new Map<string, number>()
    const layouts: string[] = []
    let lines = 0
    let carry = ''
    // Follow the session's current log: a reattach starts a fresh one (as the replica will).
    const reasons: string[] = []
    const follow = (): void => {
      const log = processes.outputLog(session.id)
      if (!log || log.invalidReason) { setTimeout(follow, 10); return }
      log.attach({
        event: (event) => {
          if (event.kind === 'layout') { layouts.push(`${event.cols}x${event.rows}`); return }
          const text = carry + new TextDecoder().decode(event.bytes)
          for (const match of text.matchAll(/GOT\[([^\]\r\n]*)\]\r\n/g)) answers.set(match[1]!, (answers.get(match[1]!) ?? 0) + 1)
          lines += text.split('\r\nn ').length - 1
          // Keep the tail after the last complete line, so an answer straddling two events counts once.
          const cut = text.lastIndexOf('\r\n')
          carry = cut === -1 ? text.slice(-64) : text.slice(cut + 2).slice(-64)
        },
        invalid: (reason) => { reasons.push(reason); carry = ''; setTimeout(follow, 10) },
      })
    }
    follow()
    writeFileSync(join(root, 'flood.pl'), FLOOD)
    let generation = session.generation
    await manager.writeNext(session.id, human, generation, `exec perl ${join(root, 'flood.pl')}\r`)
    await wait(() => lines > 5000, 'the flood is streaming')

    // Input arrives exactly once while output floods.
    await manager.writeNext(session.id, human, generation, 'hello-1\r')
    await wait(() => answers.has('hello-1'), 'input answered')
    // Copy mode is cancelled first, then the input is delivered, once.
    await service.command(['copy-mode', '-t', session.id])
    await manager.writeNext(session.id, human, generation, 'hello-2\r')
    await wait(() => answers.has('hello-2'), 'input after copy mode')
    expect((await service.command(['display-message', '-p', '-t', session.id, '#{pane_in_mode}'])).trim()).toBe('0')

    // A claim resizes through the control client; the layout change reaches the log.
    await manager.claim(session.id, human, 100, 30, { kind: 'browser', device: 'desktop' })
    expect(await processes.windowSize(session.id)).toEqual({ cols: 100, rows: 30 })
    await wait(() => layouts.includes('100x30'), 'layout event')

    // Liveness and screen queries answer. (The bridge's own server Screen is
    // bounded and may fail under an unthrottled flood until a reattach — B2's
    // bounded-load design; the raw path replaces it.)
    expect(await processes.alive(session.id)).toBe(true)
    expect(await processes.screen(session.id)).toContain('n ')

    // Native admission rides the client-resized subscription: an admitted app sizes the session.
    const reserved = await manager.reserveAttach(session.id, operator)
    const app = Bun.spawn([service.tmux!, ...reserved.args], { env: terminalEnvironment(), terminal: { cols: 132, rows: 41, data: () => {} } })
    apps.push(app)
    await manager.confirmAttach(reserved.token, app.pid)
    await wait(() => manager!.get(session.id, human).cols === 132, 'sized by the app')
    app.terminal!.resize(110, 35)
    await wait(() => manager!.get(session.id, human).cols === 110 && manager!.get(session.id, human).rows === 35, 'followed the app')
    const returned = await manager.control(session.id, human, 'return')
    await app.exited
    expect(manager.nativeClients(session.id)).toEqual([])
    // Take control back for the human to keep typing.
    generation = (await manager.control(session.id, human, 'take')).generation
    expect(returned.owner).toEqual({ kind: 'agent', id: 'patch' })

    await manager.writeNext(session.id, human, generation, 'hello-3\r')
    await wait(() => answers.has('hello-3'), 'input after admission')

    // The connection drops after the input's sequence is consumed: uncertain, never retried.
    // Drop it the moment the keys are on the wire, before tmux's reply.
    const control = (processes as unknown as { controls: Map<string, ControlClient> }).controls.get(session.id)!
    const transport = (control as unknown as { transport: { write(line: string): void } }).transport
    const send = transport.write.bind(transport)
    transport.write = (line) => { send(line); if (line.includes('"send-keys" "-t"') && line.includes('"-H"')) control.close('test drop') }
    const sequence = manager.get(session.id, human).inputSequence
    await expect(manager.writeNext(session.id, human, generation, 'maybe\r')).rejects.toBeInstanceOf(DeliveryUncertainError)
    // The sequence was consumed: the input is never retried.
    expect(manager.get(session.id, human).inputSequence).toBe(sequence + 1)

    // No duplicates: every answer arrived exactly once.
    await Bun.sleep(300)
    expect([...answers.entries()].filter(([key]) => key.startsWith('hello'))).toEqual([['hello-1', 1], ['hello-2', 1], ['hello-3', 1]])
    expect((answers.get('maybe') ?? 0)).toBeLessThanOrEqual(1)
    // The flood never overflowed the log or broke the connection before the deliberate drop.
    expect(reasons.filter((reason) => reason !== 'reattached' && reason !== 'detached' && reason !== 'test drop')).toEqual([])
  } finally {
    for (const child of apps) child.kill()
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 120000)
