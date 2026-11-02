import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sniffImage, UPLOAD_LIMITS, Uploads } from '../lib/uploads'
import { Store } from '../lib/store'
import { uploadImage } from '../lib/http'
import type { Sessions } from '../lib/sessions'

const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-upload-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const png = (width: number, height: number, bytes = 64) => {
  const data = new Uint8Array(bytes)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(data.buffer).setUint32(16, width)
  new DataView(data.buffer).setUint32(20, height)
  return data
}
/** A JPEG: APP0, a fill byte, then a whole start-of-frame (three components). */
const jpeg = (width: number, height: number, frame = 0xc2, length = 17) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xff, frame, length >> 8, length & 0xff, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
])
/** A WebP: RIFF sized to the bytes, and a first chunk of `chunkSize`. */
const webp = (chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number, chunkSize = chunk === 'VP8L' ? 5 : 10, riff = 32) => {
  const data = new Uint8Array(40)
  const view = new DataView(data.buffer)
  data.set(new TextEncoder().encode('RIFF'), 0)
  view.setUint32(4, riff, true)
  data.set(new TextEncoder().encode('WEBP'), 8)
  data.set(new TextEncoder().encode(chunk), 12)
  view.setUint32(16, chunkSize, true)
  if (chunk === 'VP8 ') { data.set([0x9d, 0x01, 0x2a], 23); view.setUint16(26, width, true); view.setUint16(28, height, true) }
  if (chunk === 'VP8L') { data[20] = 0x2f; view.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true) }
  if (chunk === 'VP8X') { const w = width - 1, h = height - 1; data.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24) }
  return data
}

describe('sniffImage', () => {
  test('PNG, JPEG (any start-of-frame, past other segments and fill bytes) and the three WebP kinds, by their bytes', () => {
    expect(sniffImage(png(1920, 1080))).toEqual({ kind: 'png', width: 1920, height: 1080 })
    expect(sniffImage(jpeg(640, 480))).toEqual({ kind: 'jpeg', width: 640, height: 480 })
    expect(sniffImage(jpeg(640, 480, 0xc0))).toEqual({ kind: 'jpeg', width: 640, height: 480 })
    expect(sniffImage(webp('VP8 ', 300, 200))).toEqual({ kind: 'webp', width: 300, height: 200 })
    expect(sniffImage(webp('VP8L', 300, 200))).toEqual({ kind: 'webp', width: 300, height: 200 })
    expect(sniffImage(webp('VP8X', 9000, 7000))).toEqual({ kind: 'webp', width: 9000, height: 7000 })
  })
  test('anything else, or a header too short to say, is none: GIF, SVG text, a truncated PNG, a JPEG whose scan starts before a frame', () => {
    expect(sniffImage(new TextEncoder().encode('GIF89a\x01\x00\x01\x00'))).toBeUndefined()
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined()
    expect(sniffImage(png(10, 10).slice(0, 20))).toBeUndefined()
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]))).toBeUndefined()
    // A DHT (C4) is not a frame.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x04, 0, 0]))).toBeUndefined()
  })
  test('declared lengths must hold: forged or truncated headers are none', () => {
    // PNG: IHDR must be 13 bytes; the header must be whole.
    const shortIhdr = png(10, 10); shortIhdr[11] = 12
    expect(sniffImage(shortIhdr)).toBeUndefined()
    expect(sniffImage(png(10, 10).slice(0, 32))).toBeUndefined()
    // JPEG: a start-of-frame too short for its fields, one running past the bytes, a segment running past them.
    expect(sniffImage(jpeg(10, 10, 0xc0, 2))).toBeUndefined()
    expect(sniffImage(jpeg(10, 10, 0xc0, 0xffff))).toBeUndefined()
    expect(sniffImage(jpeg(10, 10).slice(0, 20))).toBeUndefined()
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 0, 0]))).toBeUndefined()
    // WebP: a RIFF larger than the bytes, a chunk larger than the RIFF, chunks too short for their kind.
    expect(sniffImage(webp('VP8X', 10, 10, 10, 64))).toBeUndefined()
    expect(sniffImage(webp('VP8 ', 10, 10, 30))).toBeUndefined()
    expect(sniffImage(webp('VP8X', 10, 10, 0))).toBeUndefined()
    expect(sniffImage(webp('VP8L', 10, 10, 4))).toBeUndefined()
    expect(sniffImage(webp('VP8 ', 10, 10, 9))).toBeUndefined()
  })
  test('the largest dimensions each format can state', () => {
    expect(sniffImage(jpeg(65535, 65535))).toEqual({ kind: 'jpeg', width: 65535, height: 65535 })
    expect(sniffImage(webp('VP8X', 2 ** 24, 2 ** 24))).toEqual({ kind: 'webp', width: 2 ** 24, height: 2 ** 24 })
    expect(sniffImage(png(2 ** 31 - 1, 2 ** 31 - 1))).toEqual({ kind: 'png', width: 2 ** 31 - 1, height: 2 ** 31 - 1 })
  })
})

describe('Uploads', () => {
  const store = new Store(':memory:')
  const uploads = new Uploads(root, store)
  test('limits: empty, over 10 MB, not an image, no pixels, over 40 megapixels — each refused, nothing kept', () => {
    const refused = (bytes: Uint8Array) => { try { uploads.save('s1', bytes, 1); return '' } catch (error) { return (error as Error).message } }
    expect(refused(new Uint8Array())).toBe('The image is empty')
    expect(refused(png(10, 10, UPLOAD_LIMITS.imageBytes + 1))).toBe('Images are at most 10 MB')
    expect(refused(new TextEncoder().encode('#!/bin/sh\nrm -rf ~'))).toBe('Only PNG, JPEG and WebP images can be pasted')
    expect(refused(png(0, 10))).toBe('The image has no pixels')
    expect(refused(png(8000, 5001))).toBe('Images are at most 40 megapixels')
    expect(store.uploads('s1')).toEqual([])
  })
  test('kept privately with a generated name; the session quota is 100 MB', () => {
    const upload = uploads.save('s2', png(8000, 5000), 1)
    expect(statSync(uploads.path(upload)).mode & 0o777).toBe(0o600)
    expect(statSync(uploads.dir('s2')).mode & 0o777).toBe(0o700)
    const big = png(100, 100, UPLOAD_LIMITS.imageBytes)
    for (let index = 0; index < 9; index++) uploads.save('s3', big, 1)
    expect(() => uploads.save('s3', big, 1)).not.toThrow()
    expect(() => uploads.save('s3', png(1, 1), 1)).toThrow('This session already holds 100 MB of images')
    // Another session has its own.
    expect(() => uploads.save('s4', big, 1)).not.toThrow()
  })
  test('files left without a record (a crash before it) go after a day; recorded, young or foreign files stay', () => {
    const base = mkdtempSync(join(root, 'orphans-'))
    const records = new Store(':memory:')
    const sweeping = new Uploads(base, records)
    const kept = sweeping.save('s1', png(2, 2), 1)
    const dir = sweeping.dir('s1')
    const old = join(dir, '00000000-0000-4000-8000-000000000001.png')
    const young = join(dir, '00000000-0000-4000-8000-000000000002.png')
    const foreign = join(dir, 'notes.txt')
    for (const path of [old, young, foreign]) writeFileSync(path, 'x')
    const now = Date.now()
    const dayAgo = new Date(now - UPLOAD_LIMITS.abandonedMs - 1000)
    utimesSync(old, dayAgo, dayAgo)
    utimesSync(foreign, dayAgo, dayAgo)
    // Mark the recorded one sent, so only the unrecorded files are in question.
    sweeping.markSent('s1', kept.name, now)
    expect(sweeping.sweepAbandoned(now)).toEqual([])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(sweeping.path(kept))).toBe(true)
    // A session folder holding only an old orphan goes with it.
    const empty = join(base, 'uploads', 's2')
    mkdirSync(empty)
    const lone = join(empty, '00000000-0000-4000-8000-000000000003.webp')
    writeFileSync(lone, 'x')
    utimesSync(lone, dayAgo, dayAgo)
    sweeping.sweepAbandoned(now)
    expect(existsSync(empty)).toBe(false)
    // An unreadable session folder is answered; another session's orphan still goes.
    const locked = join(base, 'uploads', 's3')
    const other = join(base, 'uploads', 's4')
    mkdirSync(locked); mkdirSync(other)
    const otherOrphan = join(other, '00000000-0000-4000-8000-000000000004.png')
    writeFileSync(otherOrphan, 'x')
    utimesSync(otherOrphan, dayAgo, dayAgo)
    chmodSync(locked, 0o000)
    try {
      expect(sweeping.sweepAbandoned(now).map((failure) => failure.sessionId)).toEqual(['s3'])
      expect(existsSync(otherOrphan)).toBe(false)
    } finally { chmodSync(locked, 0o700) }
  })
  test('a symlink in place of the image folders is never followed: writes refuse, deletions remove the link only', () => {
    const base = mkdtempSync(join(root, 'links-'))
    const elsewhere = mkdtempSync(join(root, 'elsewhere-'))
    writeFileSync(join(elsewhere, 'keep.txt'), 'operator data')
    const linked = new Uploads(base, new Store(':memory:'))
    symlinkSync(elsewhere, join(base, 'uploads'))
    expect(() => linked.save('s1', png(2, 2), 1)).toThrow('The image folder is not a plain folder')
    linked.removeSession('s1')
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true)
    expect(existsSync(join(base, 'uploads'))).toBe(false)
    // A session folder that is a symlink: removed itself.
    mkdirSync(join(base, 'uploads'))
    symlinkSync(elsewhere, join(base, 'uploads', 's2'))
    linked.removeSession('s2')
    expect(existsSync(join(elsewhere, 'keep.txt'))).toBe(true)
  })
  test('a folder that cannot be read is no absence: the records stay', () => {
    const base = mkdtempSync(join(root, 'unreadable-'))
    const records = new Store(':memory:')
    const locked = new Uploads(base, records)
    locked.save('s1', png(2, 2), 1)
    chmodSync(join(base, 'uploads'), 0o000)
    try { expect(() => locked.removeSession('s1')).toThrow() } finally { chmodSync(join(base, 'uploads'), 0o700) }
    expect(records.uploads('s1')).toHaveLength(1)
  })
  test('a file that cannot be deleted keeps its record (still counted, swept again)', () => {
    const base = mkdtempSync(join(root, 'stuck-'))
    const records = new Store(':memory:')
    const stuck = new Uploads(base, records)
    const upload = stuck.save('s1', png(2, 2), 1)
    chmodSync(stuck.dir('s1'), 0o500)
    try {
      expect(() => stuck.remove('s1', upload.name)).toThrow()
      expect(records.uploads('s1').map((entry) => entry.name)).toEqual([upload.name])
      // A sweep answers it and goes on: another session's abandoned image still goes.
      const other = stuck.save('s2', png(2, 2), 1)
      expect(stuck.sweepAbandoned(UPLOAD_LIMITS.abandonedMs + 2).map((failure) => failure.name)).toEqual([upload.name])
      expect(records.uploadBytes('s1')).toBe(64)
      expect(existsSync(stuck.path(other))).toBe(false)
    } finally { chmodSync(stuck.dir('s1'), 0o700) }
    stuck.sweepAbandoned(UPLOAD_LIMITS.abandonedMs + 2)
    expect(records.uploads('s1')).toEqual([])
  })
})

describe('POST /upload', () => {
  // The route's half: the query names the session and generation; the body is read capped.
  const manager = { upload: async (id: string, _principal: unknown, generation: number, read: () => Promise<Uint8Array>) => ({ id, generation, bytes: (await read()).length }) } as unknown as Sessions
  const human = { kind: 'human', id: 'browser-123456789' } as const
  const post = (body: BodyInit) => new Request('http://bakin/api/plugins/terminal/upload?id=s1&generation=3', { method: 'POST', body })
  test('the session, its generation and the bytes reach the manager', async () => {
    expect(await uploadImage(manager, post(png(2, 2)), human)).toEqual({ id: 's1', generation: 3, bytes: 64 })
  })
  test('a body in many tiny chunks arrives whole', async () => {
    const image = png(2, 2, 5000)
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of image) controller.enqueue(new Uint8Array([byte])); controller.close() } })
    expect(await uploadImage(manager, post(stream), human)).toEqual({ id: 's1', generation: 3, bytes: 5000 })
  })
  test('a body that runs past 10 MB is refused while it is read (never held whole)', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let index = 0; index < 11; index++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close() } })
    await expect(uploadImage(manager, post(stream), human)).rejects.toThrow('Images are at most 10 MB')
  })
  test('a missing or malformed generation is refused', async () => {
    for (const query of ['id=s1', 'id=s1&generation=', 'id=s1&generation=-1', 'id=s1&generation=1.5']) {
      await expect(uploadImage(manager, new Request(`http://bakin/upload?${query}`, { method: 'POST', body: png(2, 2) }), human)).rejects.toThrow()
    }
  })
})
