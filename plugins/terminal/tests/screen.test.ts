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

test('writes queued behind a busy parser are coalesced: small chunks are not paced by xterm\'s timer', async () => {
  const screen = new Screen(80, 24)
  const chunk = new TextEncoder().encode('ab\r\n')
  const order: number[] = []
  const start = performance.now()
  await Promise.all(Array.from({ length: 5000 }, (_, i) => screen.write(chunk, () => order.push(i))))
  // One xterm write per chunk took about 1.3 ms each (6.5 s for these).
  expect(performance.now() - start).toBeLessThan(1500)
  expect(order).toEqual(Array.from({ length: 5000 }, (_, i) => i))
  expect(screen.text()).toContain('ab')
  screen.close()
})

test('a capture sees exactly the writes queued before it', async () => {
  const screen = new Screen(20, 3)
  const before = screen.write(new TextEncoder().encode('one'))
  const snapshot = screen.capture(() => screen.text().split('\n')[0])
  const after = screen.write(new TextEncoder().encode(' two'))
  expect(await snapshot).toBe('one')
  await Promise.all([before, after])
  expect(screen.text().split('\n')[0]).toBe('one two')
  screen.close()
})
