/**
 * The checkpoint fuzz (plan T32b; spike 3's generator): an integer PRNG,
 * a branch per kind of terminal input, and a replica that keeps its latest
 * accepted checkpoint plus the raw tail since it, which every join is
 * served from.
 */
import headless from '@xterm/headless'
import { restoreCheckpoint, takeCheckpoint, type Checkpoint } from '../../lib/checkpoint'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../../lib/terminal-profile'
import { internals, type Term } from '../../lib/terminal-state'

/** mulberry32, with unbiased integers (rejection sampling). */
export function prng(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
  const int = (n: number) => {
    const limit = Math.floor(0x100000000 / n) * n
    let x: number
    do x = next(); while (x >= limit)
    return x % n
  }
  return { int, pick: <T>(items: readonly T[]): T => items[int(items.length)]! }
}
export type Random = ReturnType<typeof prng>

type Branch = (r: Random, cols: number, rows: number) => string
export const BRANCHES: Record<string, Branch> = {
  print: (r) => 'lorem ipsum dolor sit amet'.slice(0, 1 + r.int(20)),
  numbered: (r) => `line ${r.int(100000)}\r\n`,
  sgr: (r) => `\x1b[${r.pick(['0', '1', '2', '3', '4', '5', '7', '8', '9', '53', '22', '24', '27', String(30 + r.int(8)), String(40 + r.int(8)), String(90 + r.int(8)), `38;5;${r.int(256)}`, `48;2;${r.int(256)};${r.int(256)};${r.int(256)}`])}m`,
  'ul-style': (r) => `\x1b[4:${r.int(6)}m`,
  'ul-color': (r) => `\x1b[58;5;${r.int(256)}m`,
  cup: (r, cols, rows) => `\x1b[${1 + r.int(rows + 2)};${1 + r.int(cols + 2)}H`,
  'cursor-rel': (r) => `\x1b[${r.int(4)}${r.pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'd'])}`,
  ed: (r) => `\x1b[${r.int(3)}J`,
  'ed1-last-col': (r, cols, rows) => `\x1b[${1 + r.int(rows)};${cols}H\x1b[1J`,
  el: (r) => `\x1b[${r.int(3)}K`,
  'ech-ich-dch': (r) => `\x1b[${r.int(5)}${r.pick(['X', '@', 'P'])}`,
  'il-dl': (r) => `\x1b[${r.int(3)}${r.pick(['L', 'M'])}`,
  decstbm: (r, _cols, rows) => { const top = 1 + r.int(rows); return `\x1b[${top};${top + r.int(rows - top + 1)}r` },
  'decstbm-reset': () => '\x1b[r',
  'su-sd': (r) => `\x1b[${r.int(3)}${r.pick(['S', 'T'])}`,
  'ind-ri-nel': (r) => r.pick(['\x1bD', '\x1bM', '\x1bE']),
  lf: () => '\n', cr: () => '\r', crlf: () => '\r\n', bs: () => '\b', bel: () => '\x07',
  cjk: (r) => r.pick(['漢字', '日本語', 'ｱ', '한국']),
  emoji: (r) => r.pick(['😀', '👍🏽', '❤️', '👨‍👩‍👧', '✓', '🧑‍💻']),
  combining: (r) => r.pick(['é', 'ạ̈', 'ñ']),
  'alt-1049': (r) => r.pick(['\x1b[?1049h', '\x1b[?1049l']),
  'alt-47-1047': (r) => r.pick(['\x1b[?47h', '\x1b[?47l', '\x1b[?1047h', '\x1b[?1047l']),
  'decsc-decrc': (r) => r.pick(['\x1b7', '\x1b8', '\x1b[s', '\x1b[u']),
  'charset-designate': (r) => `\x1b${r.pick(['(', ')', '*', '+'])}${r.pick(['0', 'B', 'A'])}`,
  'si-so': (r) => r.pick(['\x0e', '\x0f']),
  'osc-title-bel': (r) => `\x1b]0;title ${r.int(99)}\x07`,
  'osc-title-st': (r) => `\x1b]2;title ${r.int(99)}\x1b\\`,
  'osc8-ok': (r) => `\x1b]8;;https://e.example/${r.int(9)}\x1b\\link\x1b]8;;\x1b\\`,
  'osc8-id': (r) => `\x1b]8;id=${r.pick(['a', 'b', 'bakin-1'])};https://e.example/${r.int(3)}\x1b\\${r.pick(['x', 'yz'])}`,
  'osc8-bad': (r) => `\x1b]8;;${r.pick(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x'])}\x07bad\x1b]8;;\x07`,
  osc52: () => '\x1b]52;c;aGVsbG8=\x07',
  'osc-color-query': (r) => `\x1b]${r.pick(['10', '11', '4;1'])};?\x07`,
  'dcs-decrqss': () => '\x1bP$qm\x1b\\',
  'dcs-bel-inside': () => '\x1bP1$qm\x07junk\x1b\\',
  'dcs-xtgettcap': () => '\x1bP+q544e\x1b\\',
  'apc-pm-sos': (r) => `\x1b${r.pick(['_', '^', 'X'])}payload\x07more\x1b\\`,
  'mode-toggle': (r) => `\x1b[?${r.pick(['1', '6', '7', '12', '25', '45', '66', '1000', '1002', '1003', '1004', '1006', '2004'])}${r.pick(['h', 'l'])}`,
  'mode-irm': (r) => `\x1b[4${r.pick(['h', 'l'])}`,
  keypad: (r) => r.pick(['\x1b=', '\x1b>']),
  tabs: (r) => r.pick(['\t', '\x1bH', '\x1b[g', '\x1b[3g', '\x1b[Z', '\x1b[2I']),
  'pending-wrap': (r, cols, rows) => `\x1b[${1 + r.int(rows)};${cols}H${r.pick(['Z', '漢'])}`,
  rep: (r) => `x\x1b[${1 + r.int(4)}b`,
  'can-sub-abort': (r) => `\x1b[1;3${r.pick(['\x18', '\x1a'])}after`,
  ed3: () => '\x1b[3J',
  decscusr: (r) => `\x1b[${r.int(7)} q`,
  decsca: (r) => `\x1b[${r.pick(['0', '1', '2'])}"q`,
  'selective-erase': (r) => `\x1b[?${r.int(3)}${r.pick(['J', 'K'])}`,
  queries: (r) => r.pick(['\x1b[c', '\x1b[>c', '\x1b[6n', '\x1b[5n', '\x1b[18t', '\x1b[?2004$p']),
  'long-line': (r) => 'w'.repeat(20 + r.int(60)),
  // Enough lines to fill and trim the scrollback.
  'flood-lines': (r) => 'x\r\n'.repeat(60 + r.int(200)),
  // A string cut short by CAN or SUB.
  'osc-cancel': (r) => r.pick(['\x1b]8;;https://x\x18', '\x1b]0;title\x1a', '\x1bP$q\x18m', '\x1b]52;c;aGVs\x18']),
  ris: () => '\x1bc',
}
/** Branches drawn rarely (a reset wipes the state every other branch builds). */
export const RARE = new Set(['ris'])

export type Event = { kind: 'output'; bytes: Uint8Array } | { kind: 'resize'; cols: number; rows: number }

/** A stream for `seed`: branches drawn in order, cut into chunks (some single bytes, so joins land mid-sequence), with resizes. */
export function generate(seed: number, cols: number, rows: number, branches = 260) {
  const r = prng(seed)
  const names = Object.keys(BRANCHES)
  const used: Record<string, number> = {}
  let text = ''
  for (let i = 0; i < branches; i++) {
    let name = r.pick(names)
    if (RARE.has(name) && r.int(8)) name = 'numbered'
    used[name] = (used[name] ?? 0) + 1
    text += BRANCHES[name]!(r, cols, rows)
  }
  const bytes = new TextEncoder().encode(text)
  const events: Event[] = []
  for (let i = 0; i < bytes.length;) {
    const size = r.int(4) === 0 ? 1 : 1 + r.int(300)
    events.push({ kind: 'output', bytes: bytes.subarray(i, i + size) })
    i += size
  }
  // Sometimes one write past xterm's own 128 KiB parse split, with a three-byte character across it.
  const large = r.int(6) === 0
  if (large) {
    const big = new TextEncoder().encode('a'.repeat(131070) + '漢字 after a large write\r\n')
    events.splice(r.int(events.length), 0, { kind: 'output', bytes: big })
    used['large-write'] = 1
  }
  for (let k = 0; k < 3; k++) {
    events.splice(r.int(events.length), 0, { kind: 'resize', cols: Math.max(2, cols + r.int(21) - 10), rows: Math.max(1, rows + r.int(7) - 3) })
    used.resize = (used.resize ?? 0) + 1
  }
  return { bytes, events, used, r }
}

export function emulator(cols: number, rows: number, scrollback: number): Term {
  const term = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS, scrollback })
  applyTerminalProfile(term).setLive(false)
  return term
}
export const settled = (term: Term) => new Promise<void>((resolve) => term.write('', resolve))
/** Apply one event in order (a resize waits for the output before it). */
export function apply(term: Term, event: Event): void {
  if (event.kind === 'output') term.write(event.bytes)
  else term.write('', () => term.resize(event.cols, event.rows))
}

/** The parser category a join lands in (what the tail has to carry). */
export function joinCategory(term: Term): string {
  const handler = internals(term)._inputHandler
  const state = handler._parser.currentState
  if (handler._utf8Decoder.interim[0]) return 'mid-UTF-8'
  if (state === 0) return handler._parser.precedingJoinState ? 'after-print' : 'quiescent'
  if (state <= 2) return 'mid-ESC'
  if (state <= 6) return 'mid-CSI'
  if (state === 7) return 'mid-SOS/PM/APC'
  if (state === 8) return 'mid-OSC'
  return 'mid-DCS'
}

/** The replica under test: its latest accepted checkpoint plus every event since. */
export class FuzzReplica {
  readonly term: Term
  private base: Checkpoint | undefined
  /** Every event since the base checkpoint, numbered in apply order. */
  private tail: { seq: number; event: Event }[] = []
  private tailBytes = 0
  private seq = 0
  attempts = 0
  accepted = 0
  readonly rejected = new Map<string, number>()
  constructor(private cols: number, private rows: number, private scrollback: number, private every: number) {
    this.term = emulator(cols, rows, scrollback)
  }
  apply(event: Event): void {
    const seq = ++this.seq
    this.tail.push({ seq, event })
    apply(this.term, event)
    if (event.kind !== 'output') return
    this.tailBytes += event.bytes.length
    if (this.tailBytes < this.every) return
    // At exactly the events applied so far (by number: other attempts may
    // trim the tail first): later ones, a resize say, stay in the tail.
    this.term.write('', () => this.attempt(seq))
  }
  private attempt(at: number): void {
    this.attempts++
    const result = takeCheckpoint(this.term)
    if ('checkpoint' in result) {
      this.accepted++
      this.base = result.checkpoint
      this.tail = this.tail.filter((entry) => entry.seq > at)
      this.tailBytes = this.tail.reduce((n, entry) => n + (entry.event.kind === 'output' ? entry.event.bytes.length : 0), 0)
    } else {
      const kind = result.rejected.split(' ').slice(0, 2).join(' ')
      this.rejected.set(kind, (this.rejected.get(kind) ?? 0) + 1)
    }
  }
  /** A viewer joined now: restore, replay the tail, side effects off. */
  async join(): Promise<{ viewer: Term; fromCheckpoint: boolean }> {
    await settled(this.term)
    const base = this.base
    // Before any checkpoint, the tail is the whole stream from the start.
    const viewer = emulator(base?.cols ?? this.cols, base?.rows ?? this.rows, this.scrollback)
    if (base) await restoreCheckpoint(viewer, base)
    for (const { event } of [...this.tail]) apply(viewer, event)
    await settled(viewer)
    return { viewer, fromCheckpoint: Boolean(base) }
  }
}

/** Branches drawn fewer than `min` times (RARE ones need only one). */
export function missingBranches(used: Record<string, number>, min: number): string[] {
  return [...Object.keys(BRANCHES), 'resize'].filter((name) => (used[name] ?? 0) < (RARE.has(name) ? 1 : min))
}
/** Join categories the fuzz must reach, served from checkpoints. */
export const JOIN_CATEGORIES = ['quiescent', 'after-print', 'mid-UTF-8', 'mid-ESC', 'mid-CSI', 'mid-OSC', 'mid-DCS', 'mid-SOS/PM/APC', 'in-alt', 'region-active', 'pending-wrap']
export const missingCategories = (seen: Record<string, number>) => JOIN_CATEGORIES.filter((name) => !seen[name])
/** Deciles of the stream offset with fewer than `min` joins. */
export const thinDeciles = (cuts: number[], min: number) => Array.from({ length: 10 }, (_, i) => cuts.filter((cut) => cut >= i / 10 && cut < (i + 1) / 10).length).flatMap((count, i) => count < min ? [i] : [])
