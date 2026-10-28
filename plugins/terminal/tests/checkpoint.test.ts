import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { CHECKPOINT_FORMAT, restoreCheckpoint, restoreSideState, takeCheckpoint, type Checkpoint } from '../lib/checkpoint'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'
import { compareSteps, drain, fullState, stateDiff, type Term } from '../lib/terminal-state'
import { apply, emulator, generate, settled } from './helpers/terminal-fuzz'

const enc = (text: string) => new TextEncoder().encode(text)
const cat = (...parts: Uint8Array[]) => { const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of parts) { all.set(part, at); at += part.length } return all }
function terminal(cols: number, rows: number, scrollback = 100): Term {
  const term = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS, scrollback })
  applyTerminalProfile(term).setLive(false)
  return term
}
const write = (term: Term, data: Uint8Array | string) => new Promise<void>((resolve) => term.write(data, resolve))

/**
 * A join at the end of `before`: the latest checkpoint the replica could
 * prove (one is attempted after every byte), then the bytes since it.
 */
async function joinAt(cols: number, rows: number, before: Uint8Array) {
  const replica = terminal(cols, rows)
  let last: Checkpoint | undefined
  let offset = 0
  for (let i = 0; i < before.length; i++) {
    await write(replica, before.subarray(i, i + 1))
    const result = takeCheckpoint(replica)
    if ('checkpoint' in result) { last = result.checkpoint; offset = i + 1 }
  }
  const viewer = terminal(cols, rows)
  if (last) await restoreCheckpoint(viewer, last)
  await write(viewer, before.subarray(offset))
  return { replica, viewer, offset, served: Boolean(last) }
}

/** The visible text of both buffers and DECSCUSR's override, read through the public API and the override itself. */
function shown(term: Term) {
  const rows = (buffer: typeof term.buffer.normal) => Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true))
  const override = (term as unknown as { _core: { coreService: { decPrivateModes: { cursorStyle?: string; cursorBlink?: boolean } } } })._core.coreService.decPrivateModes
  return { normal: rows(term.buffer.normal), alternate: term.buffer.active.type === 'alternate' ? rows(term.buffer.alternate) : [], cursor: `${override.cursorStyle}/${override.cursorBlink}/${term.options.cursorBlink}` }
}

// Spike 3's named repros (Codex's included: pending wrap, DEC graphics under a saved cursor, BEL inside DCS, idle prompt).
const NAMED: { name: string; cols: number; rows: number; before: Uint8Array; after: Uint8Array; atCut?: boolean }[] = [
  { name: 'pending wrap at the margin', cols: 4, rows: 3, before: enc('abcd\x07'), after: enc('E') },
  { name: 'saved cursor under DEC graphics', cols: 10, rows: 3, before: enc('\x1b(0\x1b7\x1b(B'), after: enc('\x1b8q') },
  { name: 'BEL inside DCS', cols: 20, rows: 3, before: enc('\x1bP1$qm\x07'), after: enc('garbage\x1b\\visible') },
  { name: 'idle prompt "$ "', cols: 20, rows: 3, before: enc('done\r\n$ '), after: enc('ls\r\n') },
  { name: 'mid UTF-8', cols: 20, rows: 3, before: cat(enc('a'), enc('✓').subarray(0, 2)), after: cat(enc('✓').subarray(2), enc('b')) },
  { name: 'mid SGR', cols: 20, rows: 3, before: enc('x\x1b[31'), after: enc('mRED') },
  { name: 'combining mark after a print', cols: 20, rows: 3, before: enc('e'), after: enc('́!') },
  { name: 'REP after a print', cols: 20, rows: 3, before: enc('a'), after: enc('\x1b[3b') },
  { name: 'scroll region then newlines', cols: 10, rows: 5, before: enc('1\r\n2\r\n3\r\n4\r\n5\x1b[2;4r\x1b[4;1H'), after: enc('\nX\nY\nZ') },
  { name: 'open hyperlink', cols: 20, rows: 3, before: enc('\x1b]8;;https://a.example\x1b\\li'), after: enc('nk\x1b]8;;\x1b\\ plain') },
  { name: 'ED 1 at the bottom-right', cols: 10, rows: 3, before: enc('A\x1b[3;10H'), after: enc('\x1b[1JB-after\r\nnext') },
  { name: 'ED 1 at the last column with scrollback', cols: 10, rows: 3, before: enc('x'.repeat(25) + '\r\n1\r\n2\x1b[2;10H'), after: enc('\x1b[1Jz') },
  { name: 'alternate buffer DECSC slot kept while inactive', cols: 12, rows: 4, before: enc('\x1b[?1049h\x1b[3;5H\x1b[31m\x1b7\x1b[?1049lnormal'), after: enc('\x1b[?1049h\x1b8X') },
  { name: 'alt screen with saved normal cursor', cols: 12, rows: 4, before: enc('hist1\r\nhist2\x1b[?1049h\x1b[2;3Hprog'), after: enc('\x1b[?1049lback') },
  // Added for the grapheme provider. `atCut`: served by a checkpoint taken at the cut itself, so the join state travelled with it.
  { name: 'grapheme join state between 👍 and 🏽', cols: 20, rows: 3, before: enc('ok 👍'), after: enc('🏽X'), atCut: true },
  { name: 'a ZWJ sequence cut after the joiner', cols: 20, rows: 3, before: enc('🧑‍'), after: enc('💻X'), atCut: true },
  { name: 'idle text (a join state after any print)', cols: 20, rows: 3, before: enc('$ make'), after: enc('\r\n'), atCut: true },
  { name: 'a literal ∅ is a character, not an empty cell', cols: 10, rows: 3, before: enc('a∅b'), after: enc('c') },
  { name: 'a DECSCUSR override (blinking bar)', cols: 10, rows: 3, before: enc('\x1b[5 qx'), after: enc('y') },
  { name: 'a DECSCUSR override reset (CSI 0 SP q)', cols: 10, rows: 3, before: enc('\x1b[4 q\x1b[0 qx'), after: enc('y') },
  { name: 'a pending wrap inside a link', cols: 6, rows: 3, before: enc('\x1b]8;;https://a.example\x1b\\abcdef'), after: enc('gh\x1b]8;;\x1b\\') },
  { name: 'protected (DECSCA) cells, an erase that spares them, and a protected pen', cols: 12, rows: 3, before: enc('ab\x1b[1"qPROT\x1b[0"qcd\x1b[1"q'), after: enc('X\x1b[1;1H\x1b[?2Kafter'), atCut: true },
  { name: 'a protected cell after a reset (SGR 0 clears protection)', cols: 12, rows: 3, before: enc('\x1b[1"qP\x1b[0"qU'), after: enc('\x1b[?2Kx'), atCut: true },
  { name: 'DECSET 12 (cursor blinking set by the program)', cols: 12, rows: 3, before: enc('\x1b[?12hx'), after: enc('y'), atCut: true },
  { name: 'an open link that survived SGR 0', cols: 20, rows: 3, before: enc('\x1b]8;;https://a.example\x1b\\on\x1b[0m'), after: enc('ward\x1b]8;;\x1b\\'), atCut: true },
  // DECRC restores a bg without HAS_EXTENDED while the pen keeps its link: latent until an SGR sets the bit.
  { name: 'a latent link after DECRC, revived by an SGR', cols: 20, rows: 3, before: enc('\x1b7\x1b]8;;https://a.example\x1b\\a\x1b8'), after: enc('b\x1b[4mc\x1b]8;;\x1b\\'), atCut: true },
  { name: 'a curly underline held by DECRC with the underline bit clear (the renderer still draws it)', cols: 20, rows: 3, before: enc('\x1b]8;;https://a.example\x1b\\\x1b7\x1b]8;;\x1b\\\x1b[4:3m\x1b8A\x1b[0m'), after: enc('B') },
  { name: 'a saved cursor with protection on', cols: 12, rows: 3, before: enc('\x1b[1"q\x1b7\x1b[0"qx'), after: enc('\x1b8P\x1b[?2K'), atCut: true },
  { name: 'a link the program named like a generated one', cols: 20, rows: 3, before: enc('\x1b]8;;https://a.example\x1b\\A\x1b]8;;\x1b\\'), after: enc('\x1b]8;id=bakin-1;https://a.example\x1b\\B\x1b]8;;\x1b\\'), atCut: true },
  { name: 'custom tab stops then the alternate screen', cols: 20, rows: 3, before: enc('\x1b[3g\x1b[1;5H\x1bH\x1b[H'), after: enc('\x1b[?1049h\tX') },
]

describe('checkpoint: continuation-exact joins', () => {
  for (const repro of NAMED) {
    it(repro.name, async () => {
      const reference = terminal(repro.cols, repro.rows)
      await write(reference, cat(repro.before, repro.after))
      const { replica, viewer, offset } = await joinAt(repro.cols, repro.rows, repro.before)
      if (repro.atCut) expect(offset).toBe(repro.before.length)
      // Exact at the join…
      expect(stateDiff(fullState(replica), fullState(viewer))).toBeNull()
      // …and after what follows.
      await write(viewer, repro.after)
      expect(stateDiff(fullState(reference), fullState(viewer))).toBeNull()
      // Independently of the state comparison: what is shown, and the cursor's look.
      expect(shown(viewer)).toEqual(shown(reference))
      for (const term of [reference, replica, viewer]) term.dispose()
    })
  }
})

describe('checkpoint: link identity', () => {
  it('an open link continued after a join is one link, not two', async () => {
    const reference = terminal(20, 3)
    await write(reference, '\x1b]8;;https://a.example\x1b\\link\x1b]8;;\x1b\\')
    const { viewer } = await joinAt(20, 3, enc('\x1b]8;;https://a.example\x1b\\li'))
    await write(viewer, 'nk\x1b]8;;\x1b\\')
    const id = (term: Term, x: number) => (term.buffer.active.getLine(0)!.getCell(x) as unknown as { extended: { urlId: number } }).extended.urlId
    expect(id(viewer, 0)).toBe(id(viewer, 3))
    expect(stateDiff(fullState(reference), fullState(viewer))).toBeNull()
  })
  it('two separate links to the same address stay two (compared by grouping, not number)', async () => {
    const term = terminal(30, 3)
    await write(term, '\x1b]8;;https://a.example\x1b\\one\x1b]8;;\x1b\\ \x1b]8;;https://a.example\x1b\\two\x1b]8;;\x1b\\')
    const result = takeCheckpoint(term)
    expect('checkpoint' in result).toBe(true)
  })
})

describe('checkpoint: what bytes cannot carry', () => {
  it('the width the alternate screen was entered at (leaving it after a resize resets the stops)', async () => {
    const build = async () => {
      const term = terminal(20, 3)
      await write(term, '\x1b[3g\x1b[1;5H\x1bH\x1b[?1049h')
      term.resize(25, 3)
      return term
    }
    const reference = await build()
    const replica = await build()
    const result = takeCheckpoint(replica)
    expect('checkpoint' in result && result.checkpoint.altEnteredCols).toBe(20)
    if (!('checkpoint' in result)) return
    const viewer = terminal(25, 3)
    await restoreCheckpoint(viewer, result.checkpoint)
    for (const term of [reference, viewer]) await write(term, '\x1b[?1049l\x1b[H\tX')
    expect(stateDiff(fullState(reference), fullState(viewer))).toBeNull()
    expect(shown(viewer)).toEqual(shown(reference))
  })
})

describe('checkpoint: partial input is never accepted', () => {
  it('a lone high surrogate from a string write', async () => {
    const term = terminal(20, 3)
    await write(term, '\ud83d')
    expect('rejected' in takeCheckpoint(term)).toBe(true)
  })
  it('two held UTF-8 tails of the same length compare different', async () => {
    const a = terminal(20, 3)
    const b = terminal(20, 3)
    await write(a, Uint8Array.of(0xe4))
    await write(b, Uint8Array.of(0xe5))
    expect(stateDiff(fullState(a), fullState(b))).toContain('utf8')
  })
  it('underline styles held with the underline bit clear compare different (the renderer draws them)', async () => {
    const held = (style: number) => `\x1b]8;;https://a.example\x1b\\\x1b7\x1b]8;;\x1b\\\x1b[4:${style}m\x1b8A\x1b[0m`
    const a = terminal(20, 3)
    const b = terminal(20, 3)
    await write(a, held(3))
    await write(b, held(4))
    expect(stateDiff(fullState(a), fullState(b))).toContain('row 0')
  })
  it('CSI continuation flags (past 32 params) compare different', async () => {
    const a = terminal(20, 3)
    const b = terminal(20, 3)
    await write(a, '\x1b[' + '0;'.repeat(31) + '0')
    await write(b, '\x1b[' + '0;'.repeat(31) + '0;')
    expect(stateDiff(fullState(a), fullState(b))).toContain('sequence')
  })
})

describe('checkpoint: acceptance', () => {
  it('a checkpoint is versioned and carries the join state beside its bytes', async () => {
    const term = terminal(20, 3)
    await write(term, 'ok 👍')
    const result = takeCheckpoint(term)
    expect('checkpoint' in result).toBe(true)
    if (!('checkpoint' in result)) return
    expect(result.checkpoint.format).toBe(CHECKPOINT_FORMAT)
    expect(result.checkpoint.joinState).not.toBe(0)
    expect([result.checkpoint.cols, result.checkpoint.rows, result.checkpoint.scrollback]).toEqual([20, 3, 100])
  })
  it('mid-sequence there is no checkpoint (the bytes cannot rebuild a half-read sequence)', async () => {
    const term = terminal(20, 3)
    await write(term, 'x\x1b[31')
    expect(takeCheckpoint(term)).toEqual({ rejected: 'parser not quiescent' })
    await write(term, enc('✓').subarray(0, 2))
    expect('rejected' in takeCheckpoint(term)).toBe(true)
  })
  it('the raw underline style survives (a link makes xterm report 5, dashed, whatever is stored)', async () => {
    const term = terminal(20, 3)
    await write(term, '\x1b[4:3m\x1b]8;;https://a.example\x1b\\curly link\x1b]8;;\x1b\\\x1b[0m')
    const result = takeCheckpoint(term)
    expect('checkpoint' in result && result.checkpoint.data.join('')).toContain('4:3')
    const viewer = terminal(20, 3)
    if ('checkpoint' in result) await restoreCheckpoint(viewer, result.checkpoint)
    expect(stateDiff(fullState(term), fullState(viewer))).toBeNull()
  })
  it('scrollback, wrapped lines, empty cells and coloured erases survive', async () => {
    const term = terminal(10, 3, 50)
    await write(term, 'x'.repeat(25) + '\r\n\x1b[41m\x1b[3X\x1b[0m\x1b[5Ckept\r\n' + Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\r\n'))
    const result = takeCheckpoint(term)
    expect('checkpoint' in result).toBe(true)
  })
})

describe('compareSteps (the verifier a checkpoint uses)', () => {
  it('gives fullState’s verdict: equal pairs, and pairs one byte apart, across generated streams', async () => {
    let equal = 0
    let different = 0
    for (let seed = 1; seed <= 40; seed++) {
      const { bytes } = generate(seed, 30, 8, 80)
      // The same stream, and the same stream plus one more byte, at every cut a few times over.
      for (const cut of [Math.floor(bytes.length / 3), Math.floor(bytes.length / 2), bytes.length]) {
        const a = terminal(30, 8)
        const b = terminal(30, 8)
        const c = terminal(30, 8)
        await write(a, bytes.subarray(0, cut))
        await write(b, bytes.subarray(0, cut))
        await write(c, cat(bytes.subarray(0, cut), enc(seed % 2 ? 'z' : '\x1b[7m\x1b]8;;https://e.invalid\x1b\\é́')))
        for (const [x, y] of [[a, b], [a, c]] as const) {
          const strict = stateDiff(fullState(x), fullState(y)) === null
          expect(drain(compareSteps(x, y)) === null).toBe(strict)
          if (strict) equal++; else different++
        }
        a.dispose(); b.dispose(); c.dispose()
      }
    }
    // Both verdicts were exercised.
    expect(equal).toBeGreaterThan(50)
    expect(different).toBeGreaterThan(50)
  })
  it('sees a difference only the side maps hold: a link, a combined character, an underline colour', async () => {
    for (const [x, y] of [
      ['\x1b]8;;https://a.invalid\x1b\\link\x1b]8;;\x1b\\', '\x1b]8;;https://b.invalid\x1b\\link\x1b]8;;\x1b\\'],
      ['é', 'è'],
      ['\x1b[4;58;5;1mu', '\x1b[4;58;5;2mu'],
    ]) {
      const a = terminal(10, 2)
      const b = terminal(10, 2)
      await write(a, x!)
      await write(b, y!)
      expect(stateDiff(fullState(a), fullState(b))).not.toBeNull()
      expect(drain(compareSteps(a, b))).not.toBeNull()
      a.dispose(); b.dispose()
    }
  })
})

describe('restoreCheckpoint', () => {
  it('restores a checkpoint larger than xterm takes queued at once (flow control)', async () => {
    // 52M characters: past the 50M xterm discards when queued in one go.
    const line = 'x'.repeat(78) + '\r\n'
    const chunk = line.repeat(Math.ceil(16 * 1024 / line.length))
    const data = Array.from({ length: Math.ceil(52_000_000 / chunk.length) }, () => chunk)
    const viewer = terminal(80, 24, 10)
    const checkpoint: Checkpoint = { format: CHECKPOINT_FORMAT, cols: 80, rows: 24, scrollback: 10, data, joinState: 0, penHasExtended: true, altEnteredCols: null }
    await restoreCheckpoint(viewer, checkpoint)
    // The side state is set once every piece is parsed.
    expect(((viewer as unknown as { _core: { _inputHandler: { _curAttrData: { bg: number } } } })._core._inputHandler._curAttrData.bg & 0x10000000) !== 0).toBe(true)
    expect(viewer.buffer.active.getLine(viewer.buffer.active.baseY)!.translateToString(true)).toBe('x'.repeat(78))
    viewer.dispose()
  }, 60_000)
})

describe('streamed restore (the raw path)', () => {
  // The checkpoint's UTF-8 written in pieces of any size (inside a character
  // too), then the side state from the last write's callback: the same full
  // state as restoreCheckpoint, over fuzz-generated states.
  it('equals restoreCheckpoint at every piece size, splits inside characters included', async () => {
    const SIZES = [1, 2, 3, 7, 64, 4096]
    let compared = 0
    let multibyte = 0
    for (let seed = 1; seed <= 30; seed++) {
      const source = emulator(40, 10, 200)
      const { events } = generate(seed, 40, 10, 80)
      for (const event of events) apply(source, event)
      await settled(source)
      const result = takeCheckpoint(source)
      if ('rejected' in result) continue
      const { checkpoint } = result
      // Restored at the checkpoint's own size (the stream resized its source); the reference equals the source.
      const whole = emulator(checkpoint.cols, checkpoint.rows, checkpoint.scrollback)
      await restoreCheckpoint(whole, checkpoint)
      expect(stateDiff(fullState(whole), fullState(source)), `seed ${seed} reference`).toBeNull()
      const bytes = new TextEncoder().encode(checkpoint.data.join(''))
      compared++
      if (bytes.length > checkpoint.data.join('').length) multibyte++
      for (const size of SIZES) {
        const streamed = emulator(checkpoint.cols, checkpoint.rows, checkpoint.scrollback)
        await new Promise<void>((resolve) => {
          for (let at = 0; at < bytes.length; at += size) {
            const last = at + size >= bytes.length
            streamed.write(bytes.subarray(at, at + size), last ? () => { restoreSideState(streamed, checkpoint); resolve() } : undefined)
          }
          if (!bytes.length) streamed.write('', () => { restoreSideState(streamed, checkpoint); resolve() })
        })
        expect(stateDiff(fullState(streamed), fullState(whole)), `seed ${seed} size ${size}`).toBeNull()
        streamed.dispose()
      }
      whole.dispose()
      source.dispose()
    }
    // Not vacuous: most seeds checkpoint, and their text has characters of several bytes to split.
    expect(compared).toBeGreaterThanOrEqual(10)
    expect(multibyte).toBeGreaterThanOrEqual(4)
  }, 120000)
})
