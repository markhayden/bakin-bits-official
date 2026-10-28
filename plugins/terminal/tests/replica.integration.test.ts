import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECKPOINT_BYTES, heavyWorkRunning, MAX_BACKLOG_BYTES, Replica } from '../lib/replica'
import { BATCH_BYTES } from '../lib/output-log'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'
import { tmuxConfig } from '../lib/tmux-config'

// Spec D13 / T32c against the managed tmux: the shadow replica beside the
// bridge. Run with TERMINAL_PROCESS_TEST=1 TERMINAL_TMUX=~/.bakin/bin/tmux.
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
const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 20_000) => {
  for (const start = Date.now(); Date.now() - start < ms; await Bun.sleep(25)) if (await check()) return
  throw new Error(`Timed out: ${label}`)
}
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!

async function harness(root: string) {
  const service = new TerminalService(root)
  // The generated configuration: no status line, manual window sizes, deep history.
  const config = join(root, 'tmux.conf')
  writeFileSync(config, tmuxConfig())
  const server = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', config], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  await until(() => service.ready(), 'service')
  const logs: { message: string; data?: Record<string, unknown> }[] = []
  const driver = new TmuxProcesses(service, { info: (message, data) => logs.push({ message, data }) })
  const manager = new Sessions(new Store(join(root, 'terminal.db')), driver, {
    settings: () => ({}), prepare: async () => undefined, release: async () => undefined,
    log: { info: (message, data) => logs.push({ message, data }) }, shadowQuietMs: 300,
  })
  let sequence = 0
  const session = await manager.create({ title: 'Replica', cwd: root }, human, { cols: 100, rows: 30, kind: 'browser', device: 'desktop' })
  const type = (data: string) => manager.write(session.id, human, session.generation, ++sequence, data)
  return {
    service, driver, manager, session, logs, type,
    async close() {
      await manager.shutdown()
      await service.command(['kill-server'], true)
      server.kill()
      await server.exited
    },
  }
}

processTest('the shadow replica agrees with the bridge at quiet points', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-'))
  const h = await harness(root)
  try {
    await until(async () => (await h.manager.readScreen(h.session.id, human)).screen.trim().length > 0, 'prompt')
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    // Colours, a wide character, a cursor move, a region, and the alternate screen and back.
    await h.type(`printf '\\033[31mred\\033[0m wide:\\343\\201\\202 tab:\\there\\n\\033[5;10Hplaced\\n'; seq 1 60\r`)
    await until(() => (h.manager.shadow.get(h.session.id)?.compared ?? 0) > 0, 'first comparison')
    await h.type(`printf '\\033[?1049h\\033[2J\\033[Halternate screen\\033[3;5Hmoved'; sleep 1; printf '\\033[?1049l'\r`)
    await until(() => (h.manager.shadow.get(h.session.id)?.compared ?? 0) > 1, 'alternate comparison')
    await Bun.sleep(1500)
    await until(() => (h.manager.shadow.get(h.session.id)?.compared ?? 0) > 2, 'after the alternate screen')
    const stats = h.manager.shadow.get(h.session.id)!
    expect({ mismatched: stats.mismatched, last: stats.last }).toEqual({ mismatched: 0, last: undefined })
    expect(h.logs).toEqual([])
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)

processTest('a flood faster than the replica parses: it rebuilds from tmux instead of overflowing, input is acknowledged promptly, Ctrl-C stops it within 1 s, and it converges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-flood-'))
  const h = await harness(root)
  try {
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    const replica = h.driver.replica(h.session.id)!
    const log = h.driver.outputLog(h.session.id)!
    let worstBacklog = 0
    const watch = setInterval(() => { worstBacklog = Math.max(worstBacklog, log.pendingBytes) }, 2)
    let outputAt = 0
    h.manager.onOutput(h.session.id, () => { outputAt = performance.now() })
    await h.type('yes "flood line with some width to it, as programs print"\r')
    // Input every 20 ms for 10 s (yes ignores it). Measured: until tmux acknowledged it
    // (send-keys answered). That is not keystroke-to-render latency (a browser test's).
    const during: number[] = []
    const all: number[] = []
    const started = performance.now()
    while (performance.now() - started < 10_000) {
      const heavy = heavyWorkRunning() > 0
      const sent = performance.now()
      await h.type('x')
      all.push(performance.now() - sent)
      if (heavy) during.push(performance.now() - sent)
      await Bun.sleep(20)
    }
    const interrupted = performance.now()
    await h.type('\x03')
    await until(() => outputAt > 0 && performance.now() - outputAt > 500, 'flood stopped', 10_000)
    const stopped = outputAt - interrupted
    // Converged: a valid replica again, and the bridge agrees with it at the next quiet point.
    await until(() => Boolean(replica.cut()), 'converged', 10_000)
    const compared = h.manager.shadow.get(h.session.id)?.compared ?? 0
    const mismatched = h.manager.shadow.get(h.session.id)?.mismatched ?? 0
    await h.type('echo settled\r')
    await until(() => (h.manager.shadow.get(h.session.id)?.compared ?? 0) > compared, 'post-flood comparison', 10_000)
    clearInterval(watch)
    const shadow = h.manager.shadow.get(h.session.id)!
    console.log('flood', {
      inputAcks: all.length, duringHeavyWork: during.length, ackP95: percentile(all, 0.95).toFixed(1),
      heavyP95: during.length ? percentile(during, 0.95).toFixed(1) : '-', stopMs: stopped.toFixed(0),
      worstBacklog, stats: replica.stats, shadow,
    })
    expect(replica.ended).toBeUndefined()
    expect(replica.stats.rebuilds.overload).toBeGreaterThan(0)
    expect(worstBacklog).toBeLessThan(8 * 1024 * 1024)
    expect(worstBacklog).toBeGreaterThanOrEqual(MAX_BACKLOG_BYTES / 2)
    expect(during.length).toBeGreaterThan(5)
    expect(percentile(during, 0.95)).toBeLessThan(50)
    expect(percentile(all, 0.95)).toBeLessThan(50)
    expect(stopped).toBeLessThan(1000)
    // After convergence the bridge and the replica agree (earlier comparisons may not: the bridge redraws while the replica waits).
    expect(shadow.mismatched).toBe(mismatched)
    expect(h.logs.filter((entry) => entry.message === 'Terminal replica ended')).toEqual([])
    const rebuilt = h.logs.filter((entry) => entry.message === 'Terminal replica rebuilt')
    // One record per episode: from the first rebuild to the seed applied whole.
    expect(rebuilt.length).toBe(replica.stats.rebuilds.overload!)
    expect(h.logs.filter((entry) => entry.message === 'Terminal replica rebuilding').length).toBe(rebuilt.length)
    // Lifecycle logs carry counts and positions, never contents.
    expect(JSON.stringify(h.logs)).not.toContain('flood line')
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

// The absolute gate, here because it is a wall-clock measurement (the unit suite asserts the yielding).
processTest('a checkpoint over full scrollback never holds the event loop for 8 ms', async () => {
  let seq = 0
  const replica = new Replica({ reseed: async () => {} })
  await replica.event({ seq: ++seq, kind: 'seed', bytes: new TextEncoder().encode('\x1bc'), cols: 120, rows: 40, reason: 'test' })
  const deliver = async (text: string) => {
    const bytes = new TextEncoder().encode(text)
    for (let at = 0; at < bytes.length; at += BATCH_BYTES) await replica.event({ seq: ++seq, kind: 'output', offset: at, bytes: bytes.subarray(at, at + BATCH_BYTES) })
  }
  const flood = (size: number) => {
    let text = ''
    for (let i = 0; text.length < size; i++) text += `\x1b[3${i % 8}mline ${i} ${'lorem ipsum dolor sit amet '.repeat(3)}\x1b[0m\r\n`
    return text
  }
  await deliver(flood(4 * 1024 * 1024))
  const next = flood(CHECKPOINT_BYTES)
  let worst = 0
  let last = performance.now()
  let probing = true
  const probe = () => {
    const now = performance.now()
    if (heavyWorkRunning()) worst = Math.max(worst, now - last)
    last = now
    if (probing) setImmediate(probe)
  }
  const accepted = replica.stats.accepted
  setImmediate(probe)
  await deliver(next)
  probing = false
  expect(replica.stats.accepted).toBe(accepted + 1)
  expect(worst).toBeLessThan(8)
  replica.close()
}, 30_000)
