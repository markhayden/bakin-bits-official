import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
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

/** Absence cannot be polled for: wait out a window, saying why it is long enough. */
const settle = (ms: number, why: string) => { void why; return Bun.sleep(ms) }

// Prints numbered lines as fast as it can, answers every input line once,
// and records each line it received in a receipt file: the program's own
// count, independent of what the event log delivered.
const FLOOD = `$|=1; use IO::Select; use IO::Handle; open(my $r, '>>', $ARGV[0]) or die; $r->autoflush(1);
my $s = IO::Select->new(\\*STDIN); my $i = 0;
while (1) { print "n ", ++$i, "\\n"; if ($s->can_read(0)) { my $l = <STDIN>; last unless defined $l; chomp $l; print $r "$l\\n"; print "GOT[$l]\\n" } }`

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
  let following = true
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
    // Watch every event the session's log delivers to its replica; a reattach starts a fresh log and replica.
    const reasons: string[] = []
    const watched = new WeakSet<object>()
    const follow = (): void => {
      if (!following) return
      const replica = processes.replica(session.id)
      if (replica && !watched.has(replica)) {
        watched.add(replica)
        const deliver = replica.event.bind(replica)
        const invalid = replica.invalid.bind(replica)
        replica.event = (event) => {
          if (event.kind === 'layout') layouts.push(`${event.cols}x${event.rows}`)
          else if (event.kind === 'output') {
            const text = carry + new TextDecoder().decode(event.bytes)
            for (const match of text.matchAll(/GOT\[([^\]\r\n]*)\]\r\n/g)) answers.set(match[1]!, (answers.get(match[1]!) ?? 0) + 1)
            lines += text.split('\r\nn ').length - 1
            // Keep the tail after the last complete line, so an answer straddling two events counts once.
            const cut = text.lastIndexOf('\r\n')
            carry = cut === -1 ? text.slice(-64) : text.slice(cut + 2).slice(-64)
          }
          return deliver(event)
        }
        replica.invalid = (reason) => { reasons.push(reason); carry = ''; invalid(reason) }
      }
      setTimeout(follow, 10)
    }
    follow()
    writeFileSync(join(root, 'flood.pl'), FLOOD)
    const receiptsFile = join(root, 'receipts.txt')
    const receipts = () => existsSync(receiptsFile) ? readFileSync(receiptsFile, 'utf8').split('\n').filter(Boolean) : []
    let generation = session.generation
    await manager.writeNext(session.id, human, generation, `exec perl ${join(root, 'flood.pl')} ${receiptsFile}\r`)
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

    // Capture and liveness answer on the same streaming control client, with
    // their own replies (correlation holds under output).
    const streaming = (processes as unknown as { controls: Map<string, ControlClient> }).controls.get(session.id)!
    for (let round = 0; round < 20; round++) {
      const [captured, dead, size] = await Promise.all([
        streaming.command(['capture-pane', '-p', '-t', session.id]),
        streaming.command(['display-message', '-p', '-t', session.id, '#{pane_dead}']),
        streaming.command(['display-message', '-p', '-t', session.id, '#{window_width}x#{window_height}']),
      ])
      expect(captured.some((line) => /^n \d+$/.test(line))).toBe(true)
      expect(dead).toEqual(['0'])
      expect(size).toEqual(['100x30'])
    }
    expect(await processes.alive(session.id)).toBe(true)

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
    const sequence = manager.get(session.id, human).inputSequence
    let consumedBeforeSend: number | undefined
    transport.write = (line) => {
      const keys = line.includes('"send-keys" "-t"') && line.includes('"-H"')
      // Consume before delivery: the sequence is persisted before the keys leave.
      if (keys) {
        const db = new Database(join(root, 'terminal.db'), { readonly: true })
        const row = db.query('SELECT value FROM sessions WHERE id=?').get(session.id) as { value: string }
        consumedBeforeSend = (JSON.parse(row.value) as { inputSequence: number }).inputSequence
        db.close()
      }
      send(line)
      if (keys) control.close('test drop')
    }
    // Count every delivery attempt at the driver, across any client it attaches next.
    const attempts: string[] = []
    const deliver = processes.write.bind(processes)
    processes.write = (id, data) => { attempts.push(data); return deliver(id, data) }
    await expect(manager.writeNext(session.id, human, generation, 'maybe\r')).rejects.toBeInstanceOf(DeliveryUncertainError)
    expect(consumedBeforeSend).toBe(sequence + 1)
    expect(manager.get(session.id, human).inputSequence).toBe(sequence + 1)
    // Recovery: the next read reattaches on a fresh control client, which works.
    await manager.readScreen(session.id, human)
    expect((processes as unknown as { controls: Map<string, ControlClient> }).controls.get(session.id)).not.toBe(control)
    await manager.writeNext(session.id, human, generation, 'after-recovery\r')
    await wait(() => receipts().includes('after-recovery'), 'input after recovery')
    // The uncertain input was attempted once and never again, recovery included.
    expect(attempts.filter((data) => data === 'maybe\r')).toHaveLength(1)

    // Exactly once, by the program's own receipts: no duplicate, and the
    // uncertain input was never retried (at most the one attempt landed).
    await settle(1000, 'a retry, had there been one, would have landed by now')
    const received = receipts()
    expect(received.filter((line) => line.startsWith('hello') || line === 'after-recovery')).toEqual(['hello-1', 'hello-2', 'hello-3', 'after-recovery'])
    expect(received.filter((line) => line === 'maybe').length).toBeLessThanOrEqual(1)
    // The event log delivered each answer it carried once.
    expect([...answers.entries()].filter(([key]) => key.startsWith('hello'))).toEqual([['hello-1', 1], ['hello-2', 1], ['hello-3', 1]])
    // The flood never overflowed the log or broke the connection before the deliberate drop.
    expect(reasons.filter((reason) => reason !== 'reattached' && reason !== 'detached' && reason !== 'test drop')).toEqual([])
  } finally {
    following = false
    for (const child of apps) child.kill()
    await manager?.shutdown()
    await service.command(['kill-server'], true)
    server.kill(); await server.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 120000)
