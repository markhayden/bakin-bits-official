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
import { tmuxConfig, VERIFIED_OPTIONS } from '../lib/tmux-config'
import headless from '@xterm/headless'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import type { Term } from '../lib/terminal-state'
import type { Bundle } from '../lib/bundle'

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

async function harness(root: string, options: { raw?: boolean } = {}) {
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
    log: { info: (message, data) => logs.push({ message, data }) }, shadowQuietMs: 300, rawPath: () => options.raw ?? false,
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

processTest('raw path: the size revision continues across a reattachment, and the new attachment\'s other size moves it once; each replacement is a recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-revision-'))
  const h = await harness(root, { raw: true })
  // Ready once the attachment's replica has its seed (readScreen answers 503 until then).
  const ready = async () => { try { return await h.manager.readScreen(h.session.id, human) } catch { return undefined } }
  try {
    await until(async () => (await ready())?.cols === 100, 'seeded')
    const tmuxSize = async () => (await h.service.command(['display-message', '-p', '-t', h.session.id, '#{window_width} #{window_height}'])).trim()
    await h.service.command(['resize-window', '-t', h.session.id, '-x', '80', '-y', '30'])
    await until(async () => (await ready())?.cols === 80, 'the first width change')
    const before = (await ready())!
    expect(before.sizeRevision).toBe(1)
    // The session's first replica started with its pane: nothing was lost.
    expect(h.driver.fidelity(h.session.id).recoveries).toBeUndefined()
    // The attachment is lost; tmux's window changes while nothing is attached.
    await h.driver.detach(h.session.id)
    await h.service.command(['resize-window', '-t', h.session.id, '-x', '90', '-y', '30'])
    expect(await tmuxSize()).toBe('90 30')
    // The next read reattaches: a fresh replica, whose seed at another size is one more change, never a restart at 0.
    await until(async () => (await ready())?.cols === 90, 'reattached')
    expect(await ready()).toMatchObject({ cols: 90, rows: 30, sizeRevision: 2 })
    // A replica that replaced a lost one is a recovery (the persistent notice's cause, plan T35a).
    expect(h.driver.fidelity(h.session.id).recoveries).toBe(1)
    // A reattachment at the same size moves nothing.
    await h.driver.detach(h.session.id)
    await until(async () => (await ready()) !== undefined && h.driver.replica(h.session.id) !== undefined, 'reattached again')
    expect(await ready()).toMatchObject({ cols: 90, rows: 30, sizeRevision: 2 })
    expect(h.driver.fidelity(h.session.id).recoveries).toBe(2)
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
    // The overload's pictures were the screen alone; once quiet, a full seed brought the history back.
    await until(() => h.driver.fidelity(h.session.id).history === 'reloaded', 'history restored', 10_000)
    expect(replica.terminal!.buffer.normal.length).toBeGreaterThan(1000)
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
  const replica = new Replica({ reseed: async () => {}, geometry: async () => {} })
  await replica.event({ seq: ++seq, kind: 'seed', bytes: new TextEncoder().encode('\x1bc'), cols: 120, rows: 40, reason: 'test', history: true })
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

/** A screen's cells as `[x, y, chars, attributes]`, up to each row's last printed cell (tmux's `-e` capture trims the rest). */
function screenCells(t: Term): string[] {
  const buffer = t.buffer.active
  const cells: string[] = []
  const cell = buffer.getNullCell()
  for (let y = 0; y < t.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)!
    const end = line.translateToString(true).length
    for (let x = 0; x < end; x++) {
      line.getCell(x, cell)
      const style = [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isItalic(), cell.isUnderline(), cell.isInverse()].join(',')
      cells.push(`${x},${y} ${cell.getChars() || ' '} ${style}`)
    }
  }
  return cells
}

processTest('a clear erases the screen in tmux as in the replica: no copy of it in either history (scroll-on-clear off)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-clear-'))
  const h = await harness(root)
  try {
    // The server runs the generated configuration (what setup verifies).
    for (const [name, value] of Object.entries(VERIFIED_OPTIONS)) expect(`${name} ${(await h.service.command(['show-options', '-gv', name])).trim()}`).toBe(`${name} ${value}`)
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    const replica = h.driver.replica(h.session.id)!
    const capture = (args: string[]) => h.service.command(['capture-pane', '-p', ...args, '-t', h.session.id])
    // A screen of numbered lines, then a full-screen erase (ED 2, as clear programs send) with the program still running.
    await h.type("for i in $(seq 1 40); do printf 'line %s\\n' $i; done; printf '\\033[2J%s%s' CLE ARED; sleep 30\r")
    await until(async () => (await capture([])).includes('CLEARED'), 'cleared')
    const history = async () => (await replica.read((t) => {
      const buffer = t.buffer.active
      const lines: string[] = []
      for (let y = 0; y < buffer.baseY; y++) lines.push(buffer.getLine(y)!.translateToString(true))
      return lines
    }))!
    await until(async () => replica.quietMs > 300 && (await replica.read((t) => t.buffer.active.getLine(t.buffer.active.baseY + t.buffer.active.cursorY)!.translateToString(true)))!.includes('CLEARED'), 'the replica has it')
    const tmuxHistory = (await capture(['-S', '-', '-E', '-1'])).replace(/\n$/, '').split('\n').map((line) => line.trimEnd())
    const ours = (await history()).map((line) => line.trimEnd())
    // tmux's -S - -E -1 prints one empty line when the history is empty.
    expect(ours.length ? ours : ['']).toEqual(tmuxHistory)
    expect(tmuxHistory.some((line) => line === 'line 40')).toBe(false)
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)

processTest('stepped width changes: at each, the cells and attributes, cursor, region and modes agree with tmux, and later output continues the pen, charset and region', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-steps-'))
  const h = await harness(root)
  try {
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    const replica = h.driver.replica(h.session.id)!
    const capture = (args: string[]) => h.service.command(['capture-pane', '-p', ...args, '-t', h.session.id])
    // (Markers are printed in two halves: the echoed command line must not satisfy a wait for them.)
    // Attributed lines that wrap, then state left set for later output: a region, application cursor keys,
    // a bold green pen and the DEC graphics charset. The program then waits for the gate file, released
    // after the last width change was compared; its later output scrolls inside the region (in capitals,
    // which the line-drawing set leaves alone), then draws with the charset it left set.
    const setup = "for i in 1 2 3 4 5 6 7 8; do printf '\\033[1;3%sm%s\\033[0;4;38;5;%sm%0110d\\033[0;48;2;10;%s;90mend\\033[0m\\n' $((i%7)) row$i $((i*20)) $i $((i*25)); done; " +
      "printf '%s%s\\033[3;20r\\033[?1h\\033[12;1H\\033[1;32m\\033(0' REA DY; until [ -e gate ]; do sleep 0.1; done; for i in $(seq 1 24); do printf 'IN-REGION %s\\n' $i; done; printf 'qqqq\\033(B%s%s\\n' AF TER; printf '%s%s' DO NE; sleep 30\r"
    await h.type(setup)
    await until(async () => (await capture([])).includes('READY'), 'ready')
    const flags = '#{cursor_x} #{cursor_y} #{scroll_region_upper} #{scroll_region_lower} #{keypad_cursor_flag} #{insert_flag} #{wrap_flag}'
    const agree = async (label: string) => {
      await until(async () => replica.quietMs > 300, `${label}: quiet`)
      const tmux = (await h.service.command(['display-message', '-p', '-t', h.session.id, flags])).trim()
      const ours = await replica.read((t) => {
        const core = (t as unknown as { _core: { buffers: { active: { scrollTop: number; scrollBottom: number } } } })._core
        return [t.buffer.active.cursorX, t.buffer.active.cursorY, core.buffers.active.scrollTop, core.buffers.active.scrollBottom,
          Number(t.modes.applicationCursorKeysMode), Number(t.modes.insertMode), Number(t.modes.wraparoundMode)].join(' ')
      })
      expect(`${label}: ${ours}`).toBe(`${label}: ${tmux}`)
      // tmux's own attributed screen, parsed by a fresh profile terminal: the oracle for cells and attributes.
      const { cols, rows } = (await replica.read((t) => ({ cols: t.cols, rows: t.rows })))!
      const oracle = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
      applyTerminalProfile(oracle).setLive(false)
      const text = (await capture(['-e'])).replace(/\n$/, '').split('\n').join('\r\n')
      await new Promise<void>((resolve) => oracle.write(text, resolve))
      // tmux's capture writes a line-drawing cell as its ASCII letter (no charset switch): compared as that letter.
      expect((await replica.read(screenCells))!.map((cell) => `${label} ${cell.replace(/ ─ /, ' q ')}`)).toEqual(screenCells(oracle).map((cell) => `${label} ${cell}`))
      oracle.dispose()
    }
    await agree('before')
    for (const width of [70, 100, 55]) {
      await h.service.command(['resize-window', '-t', h.session.id, '-x', String(width), '-y', '30'])
      await until(async () => await replica.read((t) => t.cols) === width && !replica.geometryOwed, `width ${width}`)
      await agree(`width ${width}`)
    }
    expect(replica.stats.rebuilds).toEqual({})
    // The program's later output: the line-drawing charset and the green pen it left set, scrolling inside its region.
    const outside = (screen: string) => { const rows = screen.split('\n'); return [...rows.slice(0, 2), ...rows.slice(20)] }
    const before = outside(await capture([]))
    writeFileSync(join(root, 'gate'), '')
    await until(async () => (await capture([])).includes('DONE'), 'after', 20_000)
    const replicaText = async () => (await replica.read((t) => { let all = ''; for (let y = 0; y < t.buffer.active.length; y++) all += t.buffer.active.getLine(y)!.translateToString(true) + '\n'; return all }))!
    await until(async () => (await replicaText()).includes('DONE'), 'the replica has it too')
    await agree('after')
    // (tmux's plain capture prints line-drawing cells as their ASCII letters; the -e oracle above compared the rest.)
    expect(await replicaText()).toContain('────AFTER')
    // The region scrolled: its last line holds the newest output, the rows above and below it kept theirs.
    const rows = (await capture([])).split('\n')
    expect([rows[17], rows[18], rows[19]]).toEqual(['IN-REGION 24', 'qqqqAFTER', 'DONE'])
    expect(outside(await capture([]))).toEqual(before)
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

processTest("width changes install tmux's geometry: rapid resizes converge, the cursor line keeps its characters, and the replica agrees with tmux's own client", async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-width-'))
  const h = await harness(root)
  try {
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    const replica = h.driver.replica(h.session.id)!
    // Lines long enough to reflow differently in tmux and xterm, and a command line left unfinished at the cursor.
    await h.type(`for i in 1 2 3 4 5 6; do printf 'row%s-%0150d\\n' $i 0; done\r`)
    await until(async () => (await replica.read((t) => t.buffer.active.getLine(t.buffer.active.baseY + t.buffer.active.cursorY)?.translateToString(true) ?? '')) !== undefined, 'output')
    await Bun.sleep(300)
    const tail = 'abcdefghijklmnopqrstuvwxyz'.repeat(4)
    await h.type(`echo ${tail}`)
    await Bun.sleep(300)
    const browser = { kind: 'browser', device: 'desktop' } as const
    for (const cols of [70, 90, 60]) await h.manager.claim(h.session.id, human, cols, 30, browser)
    // (tmux reports each layout change asynchronously: wait for the last one, then for its geometry.)
    await until(async () => await replica.read((t) => t.cols) === 60 && !replica.geometryOwed, 'the newest geometry installed')
    expect(replica.stats.geometries).toBeGreaterThan(0)
    expect(replica.stats.rebuilds).toEqual({})
    // The rest of the command, typed after the width change: every character lands where tmux has it.
    // (The shell redraws its line on SIGWINCH: what it leaves is the shell's, so tmux itself is the oracle.)
    await h.type(' done\r')
    const ran = async () => (await h.service.command(['capture-pane', '-p', '-J', '-t', h.session.id])).includes(`${tail} done`)
    await until(ran, 'the command ran')
    await until(() => replica.quietMs > 500, 'the replica quiet')
    const trimmed = (lines: string[]) => { const out = lines.map((line) => line.trimEnd()); while (out.length && out.at(-1) === '') out.pop(); return out }
    // Wrapped rows joined, as tmux's -J capture gives them.
    const replicaLines = async (from: 'history' | 'screen') => trimmed((await replica.read((t) => {
      const buffer = t.buffer.active
      const lines: string[] = []
      for (let y = from === 'history' ? 0 : buffer.baseY; y < buffer.length; y++) {
        const row = buffer.getLine(y)!
        if (from === 'history' && row.isWrapped && lines.length) lines[lines.length - 1] += row.translateToString(true)
        else lines.push(row.translateToString(true))
      }
      return lines
    }))!)
    const tmuxLines = async (args: string[]) => trimmed((await h.service.command(['capture-pane', '-p', ...args, '-t', h.session.id])).split('\n'))
    expect(await replicaLines('screen')).toEqual(await tmuxLines([]))
    expect(await replicaLines('history')).toEqual(await tmuxLines(['-J', '-S', '-', '-E', '-']))
    // (Not the shadow comparison: the bridge's own emulator keeps cells from its old width after a resize,
    // which the bridge path, retired by T38b, never fixed. tmux's captures are the oracle.)
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 40_000)

/** A bundle's picture as text: its checkpoint, then its tail, in a fresh profile terminal. */
async function bundleText(bundle: Bundle): Promise<string> {
  const { checkpoint, tail } = bundle.cut
  const term = new headless.Terminal({ cols: checkpoint.cols, rows: checkpoint.rows, ...TERMINAL_OPTIONS, scrollback: checkpoint.scrollback })
  applyTerminalProfile(term).setLive(false)
  const write = (data: string | Uint8Array) => new Promise<void>((resolve) => term.write(data, resolve))
  for (const piece of checkpoint.data) await write(piece)
  for (const event of tail) {
    if (event.kind === 'output') await write(event.bytes)
    if (event.kind === 'layout') term.resize(event.cols, event.rows)
  }
  let text = ''
  for (let y = 0; y < term.buffer.active.length; y++) text += term.buffer.active.getLine(y)!.translateToString(true) + '\n'
  term.dispose()
  return text
}

processTest('final output (plan T35b): a terminate right after the last output, and a natural exit, save it; a lost control client with the pane alive is a recovery, not an end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bakin-replica-final-'))
  const h = await harness(root)
  const store = (h.manager as unknown as { store: Store }).store
  const capture = () => h.service.command(['capture-pane', '-p', '-t', h.session.id])
  try {
    await until(() => Boolean(h.driver.replica(h.session.id)?.cut()), 'seeded')
    // A lost control client: the session runs on, nothing is saved (D4).
    const control = (await h.service.command(['list-clients', '-t', h.session.id, '-F', '#{client_control_mode} #{client_name}'])).split('\n').find((line) => line.startsWith('1 '))!.slice(2)
    await h.service.command(['detach-client', '-t', control])
    await h.manager.refreshStates()
    expect(h.manager.get(h.session.id, human)).toMatchObject({ state: 'running', outputSaved: false })
    expect(await store.bundle(h.session.id)).toBeUndefined()
    await until(async () => { try { await h.manager.readScreen(h.session.id, human); return true } catch { return false } }, 'recovered')
    // The last output, then terminate at once: the drain to a control reply takes it into the bundle.
    await h.type("printf '%s-%s\\n' last before-kill; sleep 30\r")
    await until(async () => (await capture()).includes('last-before-kill'), 'printed')
    const taken = await h.manager.control(h.session.id, human, 'take')
    const ended = await h.manager.finish(h.session.id, human, taken.generation, true)
    expect(ended).toMatchObject({ state: 'completed', outputSaved: true })
    const bundle = (await store.bundle(h.session.id))!
    expect(bundle).toMatchObject({ cols: 100, rows: 30, fidelity: { recoveries: 1 } })
    expect(await bundleText(bundle)).toContain('last-before-kill')
    // A second session whose program exits right after its last output.
    let sequence = 0
    const other = await h.manager.create({ title: 'Exits', cwd: root }, human, { cols: 100, rows: 30, kind: 'browser', device: 'desktop' })
    await until(() => Boolean(h.driver.replica(other.id)?.cut()), 'other seeded')
    await h.manager.write(other.id, human, other.generation, ++sequence, "printf '%s-%s\\n' last before-exit; exit\r")
    await until(async () => { await h.manager.refreshStates(); return h.manager.get(other.id, human).state === 'exited' }, 'exited')
    expect(h.manager.get(other.id, human).outputSaved).toBe(true)
    expect(await bundleText((await store.bundle(other.id))!)).toContain('last-before-exit')
  } finally {
    await h.close()
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
