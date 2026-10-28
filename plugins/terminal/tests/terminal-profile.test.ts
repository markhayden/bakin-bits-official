import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { applyTerminalProfile, clipboardText, CLIPBOARD_OFFER_LIMIT, TITLE_LIMIT } from '../lib/terminal-profile'
import { LINK_ORPHAN_LIMIT } from '../lib/xterm-fixes'

type Term = InstanceType<typeof headless.Terminal>
const write = (terminal: Term, data: string) => new Promise<void>(resolve => terminal.write(data, resolve))
const row = (terminal: Term, y = 0) => terminal.buffer.active.getLine(y)!.translateToString(true)
/** The link URI under a cell (the pinned version's internals: the public cell has no link). */
function linkAt(terminal: Term, x: number, y = 0): string {
  const cell = terminal.buffer.active.getLine(y)!.getCell(x) as unknown as { bg: number; extended: { urlId: number } }
  const id = cell.bg & 0x10000000 ? cell.extended.urlId : 0
  return id ? (terminal as unknown as { _core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } } })._core._oscLinkService.getLinkData(id)?.uri ?? '' : ''
}
function profiled(cols = 80, rows = 6, scrollback = 100) {
  const terminal = new headless.Terminal({ cols, rows, scrollback, allowProposedApi: true })
  const seen = { bells: 0, titles: [] as string[], offers: [] as string[], denied: [] as string[], replies: [] as string[] }
  const profile = applyTerminalProfile(terminal, { bell: () => seen.bells++, title: t => seen.titles.push(t), clipboardOffer: t => seen.offers.push(t), deniedLink: u => seen.denied.push(u) })
  terminal.onData(data => seen.replies.push(data))
  return { terminal, seen, profile }
}

describe('terminal profile: queries and reports', () => {
  it('answers nothing (tmux is the pane\'s only responder)', async () => {
    const { terminal, seen } = profiled(40, 3)
    for (const query of ['\x1b[c', '\x1b[>c', '\x1b[=c', '\x1b[5n', '\x1b[6n', '\x1b[?6n', '\x1b[?2004$p', '\x1b[4$p', '\x1b[>q', '\x1b[14t', '\x1b[18t', '\x1b[21t', '\x1b[19t',
      '\x1b]10;?\x07', '\x1b]11;?\x1b\\', '\x1b]4;1;?\x07', '\x1b]12;?\x07', '\x1bP$qm\x1b\\', '\x1bP$qr\x1b\\', '\x1bP+q544e\x1b\\', '\x1b[x', '\x1b[1x']) await write(terminal, query)
    expect(seen.replies).toEqual([])
  })
  it('stock xterm does answer them (why the profile exists)', async () => {
    const stock = new headless.Terminal({ cols: 40, rows: 3, allowProposedApi: true })
    const replies: string[] = []
    stock.onData(data => replies.push(data))
    await write(stock, '\x1b[c\x1b[6n')
    expect(replies.length).toBeGreaterThan(0)
  })
  it('emulator-generated input (focus reports, any reply) never leaves; typed input does', async () => {
    const { terminal, seen } = profiled(40, 3)
    const service = (terminal as unknown as { _core: { coreService: { triggerDataEvent(data: string, user?: boolean): void } } })._core.coreService
    await write(terminal, '\x1b[?1004h')
    service.triggerDataEvent('\x1b[I')
    service.triggerDataEvent('\x1b[O', false)
    terminal.input('typed', true)
    expect(seen.replies).toEqual(['typed'])
  })
})

describe('terminal profile: links', () => {
  it('keeps http, https and mailto; refuses the rest, whose text still prints', async () => {
    const { terminal, seen } = profiled(80, 12)
    const ok = ['https://a.example/x', 'http://b.example', 'mailto:me@example.com', 'HTTPS://UPPER.example']
    for (const [i, uri] of ok.entries()) await write(terminal, `\x1b[${i + 1};1H\x1b]8;id=k${i};${uri}\x1b\\OK${i}\x1b]8;;\x1b\\`)
    expect(ok.map((_, i) => linkAt(terminal, 0, i))).toEqual(ok)
    const bad = ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', ' javascript:x', 'ssh://host']
    for (const [i, uri] of bad.entries()) await write(terminal, `\x1b[${i + 6};1H\x1b]8;;${uri}\x07BAD${i}\x1b]8;;\x07`)
    expect(bad.map((_, i) => linkAt(terminal, 0, i + 5))).toEqual(bad.map(() => ''))
    expect(bad.map((_, i) => row(terminal, i + 5))).toEqual(bad.map((_, i) => `BAD${i}`))
    expect(seen.denied).toEqual(bad)
  })
  it('a refused link closes an open one, also when split across writes', async () => {
    const { terminal } = profiled(80, 2)
    await write(terminal, '\x1b]8;;https://good.example\x1b\\GOOD\x1b]8;;javascript:x\x1b\\EVIL\x1b]8;;\x1b\\')
    expect(linkAt(terminal, 0)).toBe('https://good.example')
    expect(linkAt(terminal, 4)).toBe('')
    const split = profiled(80, 2).terminal
    for (const piece of ['\x1b]8;;java', 'script:alert(1)\x1b', '\\SPLIT\x1b]8;', ';\x1b\\']) await write(split, piece)
    expect(linkAt(split, 0)).toBe('')
    expect(row(split)).toBe('SPLIT')
  })
})

describe('terminal profile: clipboard, colours, windows, graphics', () => {
  it('OSC 52 is an offer of the decoded text, never a write or an answer', async () => {
    const { terminal, seen } = profiled(40, 3)
    await write(terminal, '\x1b]52;c;aGVsbG8=\x07\x1b]52;p;?\x07\x1b]52;c;\x07\x1b]52;;8J+Ygw==\x07after')
    expect(seen.offers).toEqual(['hello', '😃'])
    expect(seen.replies).toEqual([])
    expect(row(terminal)).toBe('after')
  })
  it('OSC 52: malformed, non-UTF-8 and oversized offers are dropped; the limit is decoded bytes', () => {
    const encode = (text: string) => Buffer.from(text).toString('base64')
    expect(clipboardText('c')).toBeUndefined()
    expect(clipboardText('c;?')).toBeUndefined()
    expect(clipboardText('c;not base64!')).toBeUndefined()
    expect(clipboardText('c;A')).toBeUndefined()
    expect(clipboardText('c;/w==')).toBeUndefined()
    expect(clipboardText('c;aGk')).toBe('hi')
    expect(clipboardText('c;' + encode('a'.repeat(CLIPBOARD_OFFER_LIMIT)))).toHaveLength(CLIPBOARD_OFFER_LIMIT)
    expect(clipboardText('c;' + encode('a'.repeat(CLIPBOARD_OFFER_LIMIT + 1)))).toBeUndefined()
  })
  it('palette and dynamic-colour changes and window operations do nothing', async () => {
    const { terminal, seen } = profiled(10, 2)
    let colours = 0
    ;(terminal as unknown as { _core: { _inputHandler: { onColor(listener: () => void): void } } })._core._inputHandler.onColor(() => colours++)
    await write(terminal, '\x1b]4;1;rgb:ff/00/00\x07\x1b]10;#ffffff\x07\x1b]11;#000000\x07\x1b]104\x07\x1b]110\x07\x1b[8;50;200t\x1b[3;0;0t')
    expect(colours).toBe(0)
    expect(seen.replies).toEqual([])
    expect([terminal.cols, terminal.rows]).toEqual([10, 2])
  })
  it('sixel, kitty graphics, PM, SOS and a DCS containing BEL leave nothing on screen', async () => {
    const { terminal, seen } = profiled(40, 3)
    await write(terminal, '\x1bPq#0;2;0;0;0#1!10~-\x1b\\\x1b_Gf=24;AAAA\x1b\\\x1b^pm\x1b\\\x1bXsos\x1b\\\x1bP1$qm\x07still dcs\x1b\\shown')
    expect(row(terminal)).toBe('shown')
    expect(seen.replies).toEqual([])
  })
})

describe('terminal profile: side effects only live', () => {
  it('bells, titles and clipboard offers do not fire while replaying', async () => {
    const { terminal, seen, profile } = profiled(40, 3)
    profile.setLive(false)
    await write(terminal, '\x07\x1b]0;first\x07\x1b]52;c;eA==\x07\x07\x1b]2;second\x1b\\')
    expect(seen).toMatchObject({ bells: 0, titles: [], offers: [] })
    profile.setLive(true)
    await write(terminal, '\x07\x1b]0;third\x07')
    expect(seen.bells).toBe(1)
    expect(seen.titles).toEqual(['third'])
  })
})

describe('terminal profile: bounded titles', () => {
  it('ignores a title or icon name past TITLE_LIMIT UTF-8 bytes, keeping the one before', async () => {
    const { terminal, seen } = profiled(40, 3)
    const core = (terminal as unknown as { _core: { _inputHandler: { _windowTitle: string; _iconName: string } } })._core._inputHandler
    await write(terminal, `\x1b]0;${'a'.repeat(TITLE_LIMIT)}\x07`)
    expect(seen.titles).toEqual(['a'.repeat(TITLE_LIMIT)])
    // One byte over, in characters or in UTF-8 bytes (é is two): ignored, OSC 0, 1 and 2 alike.
    for (const long of ['b'.repeat(TITLE_LIMIT + 1), 'é'.repeat(TITLE_LIMIT / 2) + 'c']) {
      for (const ident of [0, 1, 2]) await write(terminal, `\x1b]${ident};${long}\x07`)
    }
    expect(seen.titles).toHaveLength(1)
    expect(core._windowTitle).toBe('a'.repeat(TITLE_LIMIT))
    expect(core._iconName).toBe('a'.repeat(TITLE_LIMIT))
    await write(terminal, '\x1b]2;short\x07')
    expect(seen.titles.at(-1)).toBe('short')
  })
})

describe('xterm 6.0.0 workarounds', () => {
  it('inactive alt buffer: stock keeps a line store sized for the old rows (fails once upstream fixes it)', async () => {
    const stock = new headless.Terminal({ cols: 10, rows: 5, allowProposedApi: true })
    stock.resize(10, 2)
    // The alternate screen has no scrollback, yet it keeps lines past its two rows.
    await write(stock, '\x1b[?1049h1\r\n2\r\n3\r\n4\r\n5\r\n6')
    expect(stock.buffer.active.length).toBeGreaterThan(2)
  })
  it('inactive alt buffer: patched, it matches the screen after a resize', async () => {
    const { terminal } = profiled(10, 5)
    terminal.resize(10, 2)
    await write(terminal, '\x1b[?1049h1\r\n2\r\n3\r\n4\r\n5\r\n6')
    expect(terminal.buffer.active.length).toBe(2)
  })
  it('stale map entries: stock keeps entries for overwritten cells (fails once upstream fixes it)', async () => {
    const stock = new headless.Terminal({ cols: 10, rows: 3, allowProposedApi: true })
    await write(stock, 'e\u0301\x1b[4:3mx\x1b[0m\rab')
    const line = (stock as unknown as { _core: { buffers: { normal: { lines: { get(y: number): { _combined: Record<string, unknown>; _extendedAttrs: Record<string, unknown> } } } } } })._core.buffers.normal.lines.get(0)
    expect(Object.keys(line._combined)).toEqual(['0'])
    expect(Object.keys(line._extendedAttrs)).toEqual(['1'])
  })
  it('stale combined/extended map entries are purged before reflow', async () => {
    const { terminal } = profiled(10, 3)
    await write(terminal, 'e\u0301\x1b[4:3mx\x1b[0m\r' + 'ab')
    const line = (terminal as unknown as { _core: { buffers: { normal: { lines: { get(y: number): { _combined: Record<string, unknown>; _extendedAttrs: Record<string, unknown> } } } } } })._core.buffers.normal.lines.get(0)
    terminal.resize(8, 3)
    expect(Object.keys(line._combined)).toEqual([])
    expect(Object.keys(line._extendedAttrs)).toEqual([])
  })
  // A link printed in a scroll region, moved down by RI (content moves, its
  // marker does not), then the marker's row scrolled off: the cells still show it.
  const regionExpiry = '\x1b[2;4r\x1b[2;1H\x1b]8;;https://kept.example\x1b\\KEPT\x1b]8;;\x1b\\\x1b[2;1H\x1bM\x1b[r\x1b[5;1H\n\n'
  it('links: stock expires a link whose cells are still shown (fails once upstream fixes it)', async () => {
    const stock = new headless.Terminal({ cols: 20, rows: 5, scrollback: 0, allowProposedApi: true })
    await write(stock, regionExpiry)
    expect(row(stock)).toBe('KEPT')
    expect(linkAt(stock, 0)).toBe('')
  })
  it('links: patched, a link moved by a scroll region stays alive while shown', async () => {
    const { terminal } = profiled(20, 5, 0)
    await write(terminal, regionExpiry)
    expect(linkAt(terminal, 0)).toBe('https://kept.example')
  })
  it('links: a sweep keeps the link the pen is still printing', async () => {
    const { terminal, profile } = profiled(20, 3, 0)
    for (let i = 0; i < LINK_ORPHAN_LIMIT; i++) await write(terminal, `\x1b]8;;https://x.example/${i}\x1b\\L\x1b]8;;\x1b\\\x1b[2J`)
    // Open a link, erase everything (its marker goes, a sweep runs), keep printing it.
    await write(terminal, '\x1b[H\x1b]8;;https://open.example\x1b\\O\x1b[2J\x1b[HX')
    profile.links.sweep()
    expect(linkAt(terminal, 0)).toBe('https://open.example')
  })
  it('links: entries only stale map data still names are reclaimed', async () => {
    const { terminal, profile } = profiled(40, 3, 0)
    for (let i = 0; i < 300; i++) await write(terminal, `\x1b[H\x1b]8;;https://x.example/${i}\x1b\\L${i}\x1b]8;;\x1b\\`)
    // Selective erase clears the cells but leaves their attribute-map entries.
    await write(terminal, '\x1b[?2J')
    profile.links.sweep()
    expect(profile.links.orphans()).toBe(0)
  })
  it('links: links that stay referenced do not make every later expiry rescan', async () => {
    const { terminal, profile } = profiled(30, 12, 0)
    // 300 protected (DECSCA) links: a selective erase drops their markers but keeps their cells.
    let links = '\x1b[1"q'
    for (let i = 0; i < 300; i++) links += `\x1b]8;;https://x.example/${i}\x1b\\L\x1b]8;;\x1b\\`
    await write(terminal, links + '\x1b[0"q\x1b[?2J')
    // Each further expiry must not rescan the buffers again (stock-sweep count: one per expiry).
    for (let k = 0; k < 40; k++) await write(terminal, `\x1b[12;1H\x1b]8;;https://y.example/${k}\x1b\\Y\x1b]8;;\x1b\\\x1b[?2J`)
    expect(profile.links.sweeps()).toBeLessThanOrEqual(2)
    expect(linkAt(terminal, 0)).toBe('https://x.example/0')
  })
  it('links: orphans still referenced at a sweep are reclaimed by the next one once erased, without new links', async () => {
    const { terminal, profile } = profiled(30, 12, 0)
    let links = '\x1b[1"q'
    for (let i = 0; i < 300; i++) links += `\x1b]8;;https://x.example/${i}\x1b\\L\x1b]8;;\x1b\\`
    // Protected cells survive the selective erase (their markers do not): referenced orphans, kept by the sweep.
    await write(terminal, links + '\x1b[0"q\x1b[?2J')
    expect(profile.links.orphans()).toBe(300)
    // Erased for real: nothing references them, and no new link arrives to trigger a sweep.
    await write(terminal, '\x1b[2J')
    expect(profile.links.orphans()).toBe(300)
    // The owner's periodic sweep, sliced (lib/replica.ts maintain, lib/screen.ts maintain).
    for (const _ of profile.links.sweepSteps()) { /* each step is one line */ }
    expect(profile.links.orphans()).toBe(0)
    const registry = (terminal as unknown as { _core: { _oscLinkService: { _dataByLinkId: Map<number, unknown> } } })._core._oscLinkService._dataByLinkId
    expect(registry.size).toBe(0)
  })
  it('links stay alive while shown, and orphaned entries are reclaimed within a bound', async () => {
    const { terminal, profile } = profiled(20, 2, 0)
    // A link scrolled out of a region: stock xterm can expire it while it is still on screen.
    await write(terminal, '\x1b]8;;https://kept.example\x1b\\KEPT\x1b]8;;\x1b\\')
    expect(linkAt(terminal, 0)).toBe('https://kept.example')
    // Many distinct links scrolled away (no scrollback): orphans stay bounded.
    for (let i = 0; i < LINK_ORPHAN_LIMIT * 3; i++) await write(terminal, `\r\n\x1b]8;;https://x.example/${i}\x1b\\L${i}\x1b]8;;\x1b\\`)
    const live = (terminal as unknown as { _core: { _oscLinkService: { _dataByLinkId: Map<number, unknown> } } })._core._oscLinkService._dataByLinkId.size
    expect(profile.links.orphans()).toBeLessThanOrEqual(LINK_ORPHAN_LIMIT)
    expect(live).toBeLessThanOrEqual(LINK_ORPHAN_LIMIT + 4)
    // The links still on screen resolve.
    expect(linkAt(terminal, 0, 1)).toBe(`https://x.example/${LINK_ORPHAN_LIMIT * 3 - 1}`)
  })
})
