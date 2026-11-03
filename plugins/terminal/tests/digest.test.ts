import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { Terminal as BrowserTerminal } from '@xterm/xterm'
import { screenDigest } from '../lib/digest'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

const write = (term: { write(data: string, done: () => void): void }, text: string) => new Promise<void>((resolve) => term.write(text, resolve))
async function replica(text: string, cols = 40, rows = 6) {
  const term = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  applyTerminalProfile(term).setLive(false)
  await write(term, text)
  return term
}
/** A viewer as the canvas makes one (the browser package, the canvas's extra options, never opened here). */
async function viewer(text: string, cols = 40, rows = 6) {
  const term = new BrowserTerminal({ cols, rows, ...TERMINAL_OPTIONS, screenReaderMode: true, convertEol: false, fontSize: 13, cursorBlink: true, cursorStyle: 'bar' })
  applyTerminalProfile(term).setLive(false)
  await write(term, text)
  return term
}

describe('screenDigest (plan T37)', () => {
  it('equal screens, equal digests; it is short and stable', async () => {
    expect(screenDigest(await replica('\x1b[31mred\x1b[0m line\r\nnext'))).toBe(screenDigest(await replica('\x1b[31mred\x1b[0m line\r\nnext')))
    expect(screenDigest(await replica('x'))).toMatch(/^[0-9a-f]{8}$/)
  })
  it('the replica (headless) and a viewer (the browser package) agree, whatever the viewer does locally: its scroll position, its own cursor style and blink', async () => {
    const stream = Array.from({ length: 20 }, (_, i) => `\x1b[3${i % 8}mline ${i}\x1b[0m \x1b[4:3m\x1b[58;2;1;2;3mwavy\x1b[0m`).join('\r\n') + '\x1b[?25l\x1b[4 q\x1b[?1000;1006h\x1b[?1049h\x1b[2;3Halt'
    const server = await replica(stream)
    const browser = await viewer(stream)
    expect(screenDigest(browser)).toBe(screenDigest(server))
    browser.scrollLines(-5)
    expect(screenDigest(browser)).toBe(screenDigest(server))
  })
  it('sees a character, an attribute, underline style and colour, the cursor (position, visibility, style), the buffer, a mode, mouse encoding, a wrap and the size', async () => {
    const base = screenDigest(await replica('\x1b[4mhello'))
    for (const text of [
      '\x1b[4mhellp', '\x1b[1;4mhello', '\x1b[4:3mhello', '\x1b[4m\x1b[58;2;9;9;9mhello', '\x1b[4mhello\x1b[1;1H', '\x1b[4mhello\x1b[?25l', '\x1b[4mhello\x1b[2 q',
      '\x1b[?1049h\x1b[4mhello', '\x1b[?1h\x1b[4mhello', '\x1b[4mhello\x1b[?1000h',
    ]) expect(`${text} ${screenDigest(await replica(text))}`).not.toBe(`${text} ${base}`)
    expect(screenDigest(await replica('\x1b[?1000h'))).not.toBe(screenDigest(await replica('\x1b[?1000;1006h')))
    expect(screenDigest(await replica('\x1b[4mhello', 41))).not.toBe(base)
    expect(screenDigest(await replica('x'.repeat(41)))).not.toBe(screenDigest(await replica('x'.repeat(40) + '\r\nx')))
  })
  it('ignores scrollback above the screen (only what is visible, plus cursor and modes)', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\r\n')
    expect(screenDigest(await replica(`earlier\r\n${lines}`))).toBe(screenDigest(await replica(`different history\r\n${lines}`)))
  })
})
