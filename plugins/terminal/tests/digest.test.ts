import { describe, expect, it } from 'bun:test'
import headless from '@xterm/headless'
import { screenDigest, type DigestTerminal } from '../lib/digest'
import { applyTerminalProfile, TERMINAL_OPTIONS } from '../lib/terminal-profile'

async function terminal(text: string, cols = 40, rows = 6) {
  const term = new headless.Terminal({ cols, rows, ...TERMINAL_OPTIONS })
  applyTerminalProfile(term).setLive(false)
  await new Promise<void>((resolve) => term.write(text, resolve))
  return term
}
const digest = (term: unknown) => screenDigest(term as DigestTerminal)

describe('screenDigest (plan T37)', () => {
  it('equal screens, equal digests; it is short and stable', async () => {
    const a = await terminal('\x1b[31mred\x1b[0m line\r\nnext')
    const b = await terminal('\x1b[31mred\x1b[0m line\r\nnext')
    expect(digest(a)).toBe(digest(b))
    expect(digest(a)).toMatch(/^[0-9a-f]{8}$/)
  })
  it('sees a character, an attribute, the cursor, the active buffer, a mode, a wrap and the size', async () => {
    const base = digest(await terminal('hello'))
    for (const text of ['hellp', '\x1b[1mhello', 'hello\x1b[1;1H', '\x1b[?1049hhello', '\x1b[?1hhello', 'hello\x1b[?2004h']) {
      expect(digest(await terminal(text))).not.toBe(base)
    }
    expect(digest(await terminal('hello', 41))).not.toBe(base)
    const wrapped = await terminal('x'.repeat(41))
    const broken = await terminal('x'.repeat(40) + '\r\nx')
    expect(digest(wrapped)).not.toBe(digest(broken))
  })
  it('ignores scrollback above the screen (only what is visible, plus cursor and modes)', async () => {
    const lines = (from: number) => Array.from({ length: 10 }, (_, i) => `line ${from + i}`).join('\r\n')
    const a = await terminal(`earlier\r\n${lines(0)}`)
    const b = await terminal(`different history\r\n${lines(0)}`)
    expect(digest(a)).toBe(digest(b))
  })
})
