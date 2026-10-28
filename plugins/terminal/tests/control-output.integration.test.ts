import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ControlClient } from '../lib/control'
import headless from '@xterm/headless'
import { MAX_QUEUED_BYTES, OutputLog, parseLayoutChange, type LogEvent } from '../lib/output-log'
import { reseed } from '../lib/reseed'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

// Spec D13 / T31a against the managed tmux: the control client's %output
// feeds the ordered event log. Run with
// TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
const processTest = process.env.TERMINAL_PROCESS_TEST === '1' ? test : test.skip
const tmux = process.env.TERMINAL_TMUX ?? Bun.which('tmux') ?? ''
const env = { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }

let root = ''
let socket = ''
const run = (...args: string[]) => {
  const result = Bun.spawnSync([tmux, '-S', socket, '-f', '/dev/null', ...args], { env: { ...env, HOME: root } })
  return result.stdout.toString()
}
function server(command: string) {
  // A short path: tmux sockets are limited to about 100 bytes.
  root = mkdtempSync('/tmp/bakin-control-')
  socket = join(root, 's')
  run('new-session', '-d', '-s', 'w', '-x', '80', '-y', '24', command)
}
const clients: ControlClient[] = []
function attach(log: OutputLog, notes: string[] = [], closed: string[] = []) {
  const client = ControlClient.attach(tmux, socket, 'w', { ...env, HOME: root }, {
    notification: (line) => {
      notes.push(line)
      const layout = parseLayoutChange(line)
      if (layout) log.layout(layout.cols, layout.rows)
    },
    output: (_pane, bytes) => log.output(bytes),
    closed: (reason) => { closed.push(reason); log.invalidate(reason) },
  })
  clients.push(client)
  return client
}
const until = async (check: () => boolean, ms = 30000) => { for (const start = Date.now(); !check() && Date.now() - start < ms;) await Bun.sleep(20) }

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  if (root) { run('kill-server'); rmSync(root, { recursive: true, force: true }); root = '' }
})

describe('control-mode output into the event log (real tmux)', () => {
  processTest('a 40 MB burst arrives whole and in order, with the queue bounded', async () => {
    const N = 4_600_000
    // The program waits for a key, so nothing is printed before the log attaches.
    // awk, not seq: macOS seq prints large numbers as 1e+06.
    server(`sh -c 'stty -echo; read _; awk "BEGIN { for (i = 1; i <= ${N}; i++) print i }"; echo DONE; sleep 60'`)
    const log = new OutputLog()
    let received = 0
    let tail = ''
    let next = 1
    let ordered = true
    let maxPending = 0
    let done = false
    let firstMismatch = ''
    let invalidReason = ''
    log.attach({
      event: (event: LogEvent) => {
        maxPending = Math.max(maxPending, log.pendingBytes)
        if (event.kind !== 'output') return
        received += event.bytes.length
        // Check every number in order as it streams (a gap or a repeat fails).
        const lines = (tail + new TextDecoder().decode(event.bytes)).split('\r\n')
        tail = lines.pop()!
        for (const line of lines) {
          if (line === 'DONE') { done = true; continue }
          if (line === '') continue
          if (Number(line) !== next) { if (ordered) firstMismatch = `expected ${next}, got ${JSON.stringify(line)}`; ordered = false }
          next++
        }
      },
      invalid: (reason) => { invalidReason = reason },
    })
    const client = attach(log)
    await client.ready
    await client.sendKeys('w', new TextEncoder().encode('\r'))
    await until(() => done || invalidReason !== '', 120000)
    expect(invalidReason).toBe('')
    expect(firstMismatch).toBe('')
    expect(ordered).toBe(true)
    expect(next - 1).toBe(N)
    expect(received).toBeGreaterThan(40_000_000)
    expect(maxPending).toBeLessThanOrEqual(MAX_QUEUED_BYTES)
  }, 180000)

  processTest('a stalled consumer invalidates the log (overflow) instead of growing', async () => {
    server(`sh -c 'stty -echo; read _; awk "BEGIN { for (i = 1; i <= 3000000; i++) print i }"; sleep 60'`)
    const log = new OutputLog()
    const invalid: string[] = []
    log.attach({ event: () => new Promise(() => {}), invalid: (reason) => invalid.push(reason) })
    const client = attach(log)
    await client.ready
    await client.sendKeys('w', new TextEncoder().encode('\r'))
    await until(() => invalid.length > 0, 60000)
    expect(invalid).toEqual(['overflow'])
    expect(log.pendingBytes).toBe(0)
    // The control connection itself keeps working.
    expect(await client.command(['display-message', '-p', 'still here'])).toEqual(['still here'])
  }, 90000)

  processTest('grouped commands answer per command; an error ends the group and the next command still correlates', async () => {
    server('sleep 60')
    const client = attach(new OutputLog())
    await client.ready
    expect(await client.group([['display-message', '-p', 'one'], ['display-message', '-p', 'two']])).toEqual([['one'], ['two']])
    const failing = client.group([['kill-session', '-t', 'no-such-session'], ['display-message', '-p', 'skipped']])
    const next = client.command(['display-message', '-p', 'next'])
    await expect(failing).rejects.toThrow("can't find session")
    expect(await next).toEqual(['next'])
  }, 30000)

  processTest('a resize reaches the log as a layout event after the output before it', async () => {
    server(`sh -c 'stty -echo; read _; printf before; sleep 60'`)
    const log = new OutputLog()
    const events: string[] = []
    log.attach({ event: (event) => { events.push(event.kind === 'output' ? new TextDecoder().decode(event.bytes) : `<${event.cols}x${event.rows}>`) }, invalid: () => {} })
    const client = attach(log)
    await client.ready
    await client.sendKeys('w', new TextEncoder().encode('\r'))
    await until(() => events.join('').includes('before'))
    await client.command(['resize-window', '-t', 'w', '-x', '100', '-y', '30'])
    await until(() => events.includes('<100x30>'))
    expect(events.indexOf('<100x30>')).toBeGreaterThan(events.findIndex((event) => event.includes('before')))
  }, 30000)

  processTest('reseeds during a numbered stream leave no gap and no duplicate', async () => {
    const N = 3000
    root = mkdtempSync('/tmp/bakin-control-')
    socket = join(root, 's')
    // Paced so the reseeds land mid-stream; awk, not seq (macOS seq prints 1e+06).
    writeFileSync(join(root, 'numbers.sh'), `stty -echo; read _; awk 'BEGIN { for (i = 1; i <= ${N}; i++) { print i; if (i % 25 == 0) system("sleep 0.004") } }'; echo DONE; sleep 60\n`)
    // The managed config keeps 50,000 history lines (tmux's own default is 2,000).
    run('start-server', ';', 'set-option', '-g', 'history-limit', '50000', ';', 'new-session', '-d', '-s', 'w', '-x', '80', '-y', '24', `sh ${join(root, 'numbers.sh')}`)
    const log = new OutputLog()
    // The replica: a profiled terminal fed by the log, reset by each seed.
    const replica = new headless.Terminal({ cols: 80, rows: 24, ...TERMINAL_OPTIONS })
    applyTerminalProfile(replica)
    const write = (data: Uint8Array) => new Promise<void>((resolve) => replica.write(data, resolve))
    let seen = 0
    let seeds = 0
    let done = false
    log.attach({
      event: async (event) => {
        if (event.kind === 'layout') { replica.resize(event.cols, event.rows); return }
        if (event.kind === 'seed') { seeds++; replica.reset(); replica.resize(event.cols, event.rows); await write(event.bytes); return }
        const text = new TextDecoder().decode(event.bytes)
        seen += text.split('\n').length - 1
        if (text.includes('DONE')) done = true
        await write(event.bytes)
      },
      invalid: (reason) => { invalid.push(reason) },
    })
    const invalid: string[] = []
    const client = attach(log)
    await client.ready
    await client.sendKeys('w', new TextEncoder().encode('\r'))
    const numbersInReplica = () => {
      const buffer = replica.buffer.active
      return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true)).filter((row) => /^\d+$/.test(row)).map(Number)
    }
    for (const at of [800, 1600, 2400]) {
      await until(() => seen >= at)
      // A live boundary: the stream is still running when the seed lands, and keeps going after it.
      expect(done).toBe(false)
      await reseed(client, log, 'w', `test at ${at}`)
      const after = seen
      await until(() => seen >= after + 200 || done)
      expect(seen).toBeGreaterThan(after)
      // Before the next seed replaces the evidence: exactly 1…k, past the seed point.
      await Bun.sleep(50)
      const numbers = numbersInReplica()
      expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1))
      expect(numbers.length).toBeGreaterThan(at)
    }
    await until(() => done)
    log.flush()
    await until(() => seeds === 3)
    await Bun.sleep(100)
    const buffer = replica.buffer.active
    const rows = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true))
    const numbers = rows.filter((row) => /^\d+$/.test(row)).map(Number)
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1))
    // The visible screen is tmux's.
    const screen = run('capture-pane', '-p', '-t', 'w').split('\n').slice(0, 24).map((row) => row.trimEnd())
    expect(rows.slice(buffer.baseY, buffer.baseY + 24).map((row) => row.trimEnd())).toEqual(screen)
    expect(invalid).toEqual([])
  }, 60000)

  processTest('%exit (the control client detached) and EOF (the server died) end the connection: nothing hangs', async () => {
    server('sleep 60')
    const detachedLog = new OutputLog()
    const closed: string[] = []
    const client = attach(detachedLog, [], closed)
    await client.ready
    const name = run('list-clients', '-t', 'w', '-F', '#{client_name} #{client_control_mode}').split('\n').find((line) => line.endsWith(' 1'))!.split(' ')[0]!
    run('detach-client', '-t', name)
    await until(() => closed.length > 0, 10000)
    expect(closed[0]).toMatch(/exit|detached/)
    expect(detachedLog.invalidReason).toBe(closed[0])
    await expect(client.command(['display-message', '-p', 'x'])).rejects.toThrow('closed')

    const log = new OutputLog()
    const ended: string[] = []
    const second = attach(log, [], ended)
    await second.ready
    const pending = second.command(['display-message', '-p', 'x']).then((lines) => lines.join(''), (error: Error) => error.message)
    run('kill-server')
    await until(() => ended.length > 0, 10000)
    expect(ended).toHaveLength(1)
    expect(log.invalidReason).toBe(ended[0])
    expect(['x', 'Terminal control connection closed']).toContain(await pending)
  }, 30000)
})
