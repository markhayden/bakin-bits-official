import { expect, test } from 'bun:test'
import { Screen } from '../lib/screen'

test('screen restores split UTF-8, cursor movement and alternate screen', async () => {
  const screen = new Screen(80, 24)
  try {
    const bytes = Buffer.from('hello \u{1f642}')
    await screen.write(bytes.subarray(0, bytes.length - 2))
    await screen.write(bytes.subarray(bytes.length - 2))
    expect(await screen.snapshot()).toContain('hello \u{1f642}')
    await screen.write(Buffer.from('\x1b[?1049h\x1b[2J\x1b[Halternate'))
    expect(await screen.snapshot()).toContain('alternate')
    await screen.write(Buffer.from('\x1b[?1049l'))
    expect(await screen.snapshot()).toContain('hello')
  } finally { screen.close() }
})
test('parser overflow and persistence failures remain visible without hanging disposal', async () => {
  const screen = new Screen(80, 24)
  try {
    await expect(screen.write(Buffer.from('output'), () => { throw new Error('disk unavailable') })).rejects.toThrow('disk unavailable')
    expect(screen.failed).toBe(true)
    await screen.drain()
  } finally { screen.close() }
  const noisy = new Screen(80, 24)
  try {
    await expect(noisy.write(new Uint8Array(1024 * 1024 + 1))).rejects.toThrow('limit')
    expect(noisy.failed).toBe(true)
    await expect(noisy.snapshot()).rejects.toThrow('reconnect')
  } finally { noisy.close() }
})
