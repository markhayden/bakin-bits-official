import type { Session } from '../lib/contracts'
import { terminalFetch } from './api'

/**
 * Images in a compose draft (spec item 8; plan T23b): each is uploaded as it
 * is added (lib/uploads.ts), shown with a thumbnail, and its path is sent
 * with the draft's text through Paste or Paste + Enter.
 */
export interface DraftImage {
  /** This draft's own id for it (the upload's name arrives later). */
  id: string
  /** The file's own name, for its label. */
  label: string
  /** The browser's local copy, for the thumbnail. */
  preview: string
  status: 'uploading' | 'ready' | 'failed'
  error?: string
  /** Once kept: the generated name and the path the program is given. */
  upload?: { name: string; path: string }
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
/** The images among files a picker, a paste or a drop brought (others are left out; the server checks the bytes). */
export function imageFiles(files: Iterable<File> | ArrayLike<File> | null | undefined): File[] {
  return Array.from(files ?? []).filter((file) => (IMAGE_TYPES as readonly string[]).includes(file.type))
}
/** Whether a paste or drop carries image files (it is the draft's, not the terminal's). */
export function carriesImages(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.items ?? []).some((item) => item.kind === 'file' && (IMAGE_TYPES as readonly string[]).includes(item.type)))
}

/** A path as a POSIX shell reads it back unchanged. */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`
}

/** One paste of a send, and what of the draft it carries (it leaves the draft once accepted). */
export interface ComposePaste { text: string; uploads: string[]; imageIds: string[]; carriesText: boolean }
/** At most this many images go in one send (the socket's paste names at most 20). */
export const MAX_DRAFT_IMAGES = 20
/**
 * What a draft sends, in order. Claude Code and Codex turn a pasted image
 * path into an attached image only when the paste is the path alone
 * (verified 2026-11-01 on Claude Code 2.1.316 and Codex 0.160): each image is
 * its own paste, literal, then the text. A shell gets one paste — the text,
 * then each path shell-quoted.
 */
export function composePastes(program: Session['program'], text: string, images: Array<{ id: string; name: string; path: string }>): ComposePaste[] {
  if (program === 'shell') {
    const line = [text, ...images.map((image) => shellQuote(image.path))].filter(Boolean).join(' ')
    return line ? [{ text: line, uploads: images.map((image) => image.name), imageIds: images.map((image) => image.id), carriesText: Boolean(text) }] : []
  }
  const pastes: ComposePaste[] = images.map((image) => ({ text: image.path, uploads: [image.name], imageIds: [image.id], carriesText: false }))
  if (text) pastes.push({ text: images.length ? ` ${text}` : text, uploads: [], imageIds: [], carriesText: true })
  return pastes
}

/**
 * A send's pastes, one at a time: the next goes only once the one before it
 * was accepted (`accepted`), so a refusal — the caller simply stops — leaves
 * the rest unsent and Return unsent; `delivered` hears each paste that went,
 * so what it carried leaves the draft and a retry never sends it twice.
 */
export class PasteSequence {
  private next = 0
  constructor(readonly parts: readonly ComposePaste[], private enter: boolean, private send: (paste: ComposePaste, enter: boolean) => number | false, private delivered: (paste: ComposePaste) => void) {}
  /** Send the next paste (Return only with the last); its envelope, or false when it could not go. */
  private sendNext(): number | false {
    return this.send(this.parts[this.next], this.enter && this.next === this.parts.length - 1)
  }
  start(): number | false { return this.sendNext() }
  /** The paste in flight was accepted: the following one's envelope, `done` after the last, or false when it could not go. */
  accepted(): number | false | 'done' {
    this.delivered(this.parts[this.next])
    this.next++
    return this.next < this.parts.length ? this.sendNext() : 'done'
  }
}

/** Upload one image for the session at the generation this screen holds. */
export async function uploadImage(sessionId: string, generation: number, file: File): Promise<{ name: string; path: string }> {
  const response = await terminalFetch(`/upload?id=${encodeURIComponent(sessionId)}&generation=${generation}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type } })
  const data = await response.json() as { name?: string; path?: string; error?: string }
  if (!response.ok || !data.name || !data.path) throw new Error(data.error ?? `Image not added (${response.status})`)
  return { name: data.name, path: data.path }
}
