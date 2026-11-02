import { randomUUID } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TerminalError } from './contracts'
import type { Store } from './store'

/**
 * Images pasted into a session (spec item 8): PNG, JPEG or WebP, checked by
 * their bytes (never a name or a declared type), kept plugin-private at
 * `<root>/uploads/<sessionId>/<uuid>.<ext>`, and recorded in the store — the
 * quota, what was sent, and what was abandoned come from those records.
 */
export const UPLOAD_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  sessionBytes: 100 * 1024 * 1024,
  /** Decoded pixels, as the image's own header says (never decoded to find out). */
  pixels: 40_000_000,
  /** An upload never sent this long is abandoned (a draft given up on). */
  abandonedMs: 24 * 60 * 60 * 1000,
} as const

export type ImageKind = 'png' | 'jpeg' | 'webp'
export interface Upload {
  session: string
  /** `<uuid>.<ext>`, generated here. */
  name: string
  kind: ImageKind
  bytes: number
  width: number
  height: number
  createdAt: number
  sentAt?: number
}

const ascii = (bytes: Uint8Array, at: number, text: string) => text.split('').every((char, index) => bytes[at + index] === char.charCodeAt(0))
const u16be = (bytes: Uint8Array, at: number) => (bytes[at] << 8) | bytes[at + 1]
const u32be = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]
const u24le = (bytes: Uint8Array, at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)

const u32le = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0

/**
 * The image's kind and dimensions from its header, or nothing: not one of
 * the three, or a header whose declared lengths do not hold (a truncated or
 * forged one) — every length is checked against the bytes before anything
 * past it is read.
 */
export function sniffImage(bytes: Uint8Array): { kind: ImageKind; width: number; height: number } | undefined {
  // PNG: the signature, then IHDR first — 13 bytes of data and its CRC.
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n\x1a\n')) {
    if (bytes.length < 33 || u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return undefined
    return { kind: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }
  // JPEG: SOI, then whole segments until a start-of-frame (C0–CF but DHT C4, JPG C8, DAC CC).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let at = 2
    while (at + 1 < bytes.length) {
      if (bytes[at] !== 0xff) return undefined
      const marker = bytes[at + 1]
      // Fill bytes, and markers without a length (TEM, RSTn).
      if (marker === 0xff) { at++; continue }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      // An end or a scan before any frame.
      if (marker === 0xd9 || marker === 0xda || at + 4 > bytes.length) return undefined
      const length = u16be(bytes, at + 2)
      // The segment must be whole (its length counts its own two bytes).
      if (length < 2 || at + 2 + length > bytes.length) return undefined
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // Precision, height, width, component count, then three bytes per component.
        if (length < 8 || length < 8 + 3 * bytes[at + 9]) return undefined
        return { kind: 'jpeg', height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) }
      }
      at += 2 + length
    }
    return undefined
  }
  // WebP: a RIFF that fits the bytes, then a first chunk that fits it and is long enough for its kind.
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    const riff = u32le(bytes, 4)
    if (bytes.length < 20 || riff < 12 || 8 + riff > bytes.length) return undefined
    const chunk = u32le(bytes, 16)
    if (20 + chunk > 8 + riff) return undefined
    if (ascii(bytes, 12, 'VP8 ') && chunk >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { kind: 'webp', width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff }
    }
    if (ascii(bytes, 12, 'VP8L') && chunk >= 5 && bytes[20] === 0x2f) {
      const bits = u32le(bytes, 21)
      return { kind: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (ascii(bytes, 12, 'VP8X') && chunk >= 10) return { kind: 'webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  return undefined
}

const EXTENSIONS: Record<ImageKind, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }
/** The names save() generates (anything else in a session folder is not this plugin's to delete). */
const GENERATED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/

export class Uploads {
  constructor(private root: string, private store: Store) {}
  /** Where a session's uploads live (the path a program is given). */
  dir(session: string): string { return join(this.root, 'uploads', session) }
  path(upload: Pick<Upload, 'session' | 'name'>): string { return join(this.dir(upload.session), upload.name) }
  /**
   * Validate and keep one image: within the image and session limits, one of
   * the three kinds by its bytes, and at most UPLOAD_LIMITS.pixels as its
   * header says. The name is generated; the file is the operator's only.
   */
  save(session: string, bytes: Uint8Array, now: number): Upload {
    if (bytes.length === 0) throw new TerminalError('The image is empty', 400)
    if (bytes.length > UPLOAD_LIMITS.imageBytes) throw new TerminalError('Images are at most 10 MB', 413)
    const image = sniffImage(bytes)
    if (!image) throw new TerminalError('Only PNG, JPEG and WebP images can be pasted', 415)
    if (image.width === 0 || image.height === 0) throw new TerminalError('The image has no pixels', 400)
    if (image.width * image.height > UPLOAD_LIMITS.pixels) throw new TerminalError('Images are at most 40 megapixels', 413)
    if (this.store.uploadBytes(session) + bytes.length > UPLOAD_LIMITS.sessionBytes) throw new TerminalError('This session already holds 100 MB of images; remove some first', 413)
    const upload: Upload = { session, name: `${randomUUID()}.${EXTENSIONS[image.kind]}`, ...image, bytes: bytes.length, createdAt: now }
    this.ownDir(join(this.root, 'uploads'))
    this.ownDir(this.dir(session))
    // A new file only (never through an existing name), removed again if the write or its record fails.
    try {
      writeFileSync(this.path(upload), bytes, { mode: 0o600, flag: 'wx' })
      this.store.addUpload(upload)
    } catch (error) {
      rmSync(this.path(upload), { force: true })
      throw error
    }
    return upload
  }
  /**
   * A folder of this plugin's, never a symlink to elsewhere (writes,
   * permissions and deletions stay inside the plugin's data). The plugin's
   * own folder is the operator's; this guards what Bakin itself follows.
   */
  private ownDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (!lstatSync(dir).isDirectory()) throw new TerminalError('The image folder is not a plain folder', 500)
    chmodSync(dir, 0o700)
  }
  /**
   * A session's folder, to delete from: true when it and the uploads folder
   * above it are plain folders. Anything else in their place (a symlink) is
   * removed itself, never followed, and there is nothing under it to delete.
   */
  private sessionDirExists(session: string): boolean {
    for (const dir of [join(this.root, 'uploads'), this.dir(session)]) {
      let plain: boolean
      // Only "not there" is absence: any other failure (no permission) is thrown, and the records stay.
      try { plain = lstatSync(dir).isDirectory() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
      if (!plain) { rmSync(dir, { force: true }); return false }
    }
    return true
  }
  /** A recorded upload whose file is there (a paste may name it). */
  exists(session: string, name: string): boolean {
    if (!this.store.uploads(session).some((upload) => upload.name === name)) return false
    try { return lstatSync(join(this.dir(session), name)).isFile() } catch { return false }
  }
  /** It reached the program (a paste delivered): no longer a draft that can be abandoned. */
  markSent(session: string, name: string, now: number): void { this.store.markUploadSent(session, name, now) }
  /** Remove one the operator took out of the draft: only a recorded upload (never a path a caller made up). */
  remove(session: string, name: string): boolean {
    if (!this.store.uploads(session).some((upload) => upload.name === name)) return false
    // The file first: its record stays (counted, swept again) until the bytes are gone.
    if (this.sessionDirExists(session)) rmSync(join(this.dir(session), name), { force: true })
    return this.store.deleteUpload(session, name)
  }
  /**
   * Generated files no record names, older than UPLOAD_LIMITS.abandonedMs:
   * removed (never followed through a symlink), and session folders left
   * empty with them.
   */
  private sweepUnrecorded(now: number): Array<{ sessionId: string; name: string; error: string }> {
    const failed: Array<{ sessionId: string; name: string; error: string }> = []
    const fail = (sessionId: string, name: string, error: unknown) => failed.push({ sessionId, name, error: error instanceof Error ? error.message : String(error) })
    const base = join(this.root, 'uploads')
    let sessions: string[]
    try { if (!lstatSync(base).isDirectory()) return failed; sessions = readdirSync(base) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('', 'uploads', error)
      return failed
    }
    // One that cannot be read or deleted is answered and tried again next sweep; the rest still go.
    for (const session of sessions) {
      const dir = join(base, session)
      try {
        if (!lstatSync(dir).isDirectory()) continue
        const recorded = new Set(this.store.uploads(session).map((upload) => upload.name))
        for (const name of readdirSync(dir)) {
          if (recorded.has(name) || !GENERATED_NAME.test(name)) continue
          const path = join(dir, name)
          try { if (now - lstatSync(path).mtimeMs >= UPLOAD_LIMITS.abandonedMs) rmSync(path, { force: true }) } catch (error) { fail(session, name, error) }
        }
        if (readdirSync(dir).length === 0 && recorded.size === 0) rmSync(dir, { recursive: true, force: true })
      } catch (error) { fail(session, '', error) }
    }
    return failed
  }
  /** Every upload of the session goes (its session or its history was deleted): the files first, then the records. */
  removeSession(session: string): void {
    if (this.sessionDirExists(session)) rmSync(this.dir(session), { recursive: true, force: true })
    this.store.deleteUploads(session)
  }
  /**
   * Uploads never sent within UPLOAD_LIMITS.abandonedMs go. One that cannot
   * be deleted keeps its record and is answered (tried again next sweep);
   * the rest still go.
   */
  sweepAbandoned(now: number): Array<{ sessionId: string; name: string; error: string }> {
    const failed: Array<{ sessionId: string; name: string; error: string }> = []
    // Files without a record (a crash between the write and the record) older than a day go too.
    failed.push(...this.sweepUnrecorded(now))
    for (const upload of this.store.abandonedUploads(now - UPLOAD_LIMITS.abandonedMs)) {
      try { this.remove(upload.session, upload.name) } catch (error) {
        failed.push({ sessionId: upload.session, name: upload.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return failed
  }
}
