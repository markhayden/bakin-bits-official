/**
 * newRequestId: crypto.randomUUID where the origin is secure, a hand-built v4
 * from getRandomValues on plain http (Tailscale) — same shape either way.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { newRequestId } from '../lib/request-id'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const savedUuid = crypto.randomUUID
const savedRandom = crypto.getRandomValues
const define = (name: 'randomUUID' | 'getRandomValues', value: unknown) =>
  Object.defineProperty(crypto, name, { value, configurable: true, writable: true })
afterEach(() => { define('randomUUID', savedUuid); define('getRandomValues', savedRandom) })

describe('newRequestId', () => {
  it('uses crypto.randomUUID on a secure origin', () => {
    define('randomUUID', () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(newRequestId()).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('builds a v4 from getRandomValues without it', () => {
    define('randomUUID', undefined)
    expect(newRequestId()).toMatch(V4)
    expect(new Set(Array.from({ length: 50 }, () => newRequestId())).size).toBe(50)
  })

  it('keeps every random bit and stamps only the version and variant nibbles', () => {
    define('randomUUID', undefined)
    const fill = (byte: number) => (array: Uint8Array) => { array.fill(byte); return array }
    define('getRandomValues', fill(0xff))
    expect(newRequestId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    define('getRandomValues', fill(0x00))
    expect(newRequestId()).toBe('00000000-0000-4000-8000-000000000000')
    define('getRandomValues', (array: Uint8Array) => { array.forEach((_, i) => { array[i] = i }); return array })
    expect(newRequestId()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })
})
