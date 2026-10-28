import { applyTmuxWidths } from './unicode-widths'
import { patchAltBufferCapacity, patchEraseAbove, patchLinkLifetime, patchReflowStaleMaps, patchSharedTabStops, patchSplitClusterReset, patchUtf8Boundaries } from './xterm-fixes'

/** The xterm surface the profile drives; both @xterm/xterm and @xterm/headless provide it. */
export interface ProfileTerminal {
  parser: {
    registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void }
    registerDcsHandler(id: { prefix?: string; intermediates?: string; final: string }, callback: (data: string, params: (number | number[])[]) => boolean): { dispose(): void }
    registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void }
  }
  onBell(listener: () => void): { dispose(): void }
  onTitleChange(listener: (title: string) => void): { dispose(): void }
  onResize(listener: () => void): { dispose(): void }
  loadAddon(addon: { activate(terminal: never): void; dispose(): void }): void
  unicode: { activeVersion: string; register(provider: { readonly version: string; wcwidth(codepoint: number): 0 | 1 | 2; charProperties(codepoint: number, preceding: number): number }): void }
  write(data: string | Uint8Array, callback?: () => void): void
  reset(): void
  resize(cols: number, rows: number): void
  buffer: { active: { type: string } }
}

/**
 * Construction options every emulator shares (the server replica, each
 * viewer, the checkpoint verifier): the same scrollback, so a join restores
 * exactly the history the replica holds.
 */
export const TERMINAL_OPTIONS = { scrollback: 10_000, allowProposedApi: true } as const

/** What a program asked the viewer to do; each fires only live, never while a join is replayed. */
export interface TerminalEffects {
  bell?(): void
  title?(title: string): void
  /** OSC 52: the program offered text for the clipboard. It is never written automatically. */
  clipboardOffer?(text: string): void
  /** OSC 8 to a scheme other than http, https or mailto: the text prints without a link. */
  deniedLink?(uri: string): void
}

/** Clipboard offers longer than this (decoded bytes) are dropped. */
export const CLIPBOARD_OFFER_LIMIT = 256 * 1024
const LINK_SCHEMES = /^(?:https?|mailto):/i
/** Whether an OSC 8 link may be kept and opened: http, https and mailto. */
export const isAllowedLink = (uri: string): boolean => LINK_SCHEMES.test(uri)
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/** OSC 52's selection data ("<targets>;<base64>") as text, or undefined for a read request, a clear, or anything malformed or too large. */
export function clipboardText(data: string): string | undefined {
  const separator = data.indexOf(';')
  if (separator === -1) return undefined
  const encoded = data.slice(separator + 1)
  // Bound the work before decoding: at most the limit once decoded.
  if (!encoded || encoded.length > Math.ceil(CLIPBOARD_OFFER_LIMIT / 3) * 4 || encoded.length % 4 === 1 || !BASE64.test(encoded)) return undefined
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    if (bytes.byteLength > CLIPBOARD_OFFER_LIMIT) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    // Not base64 or not UTF-8: no offer.
    return undefined
  }
}

/**
 * The one terminal profile (spec D13) for every emulator: the server
 * replica, each browser viewer and the checkpoint verifier parse alike.
 * - Queries and reports are swallowed: tmux is the pane's only responder
 *   (a viewer's answers would otherwise be typed into the pane).
 * - OSC 8 links: http, https and mailto only; a refused link also closes
 *   an open one, and its text still prints.
 * - OSC 52 never writes the clipboard; it is an offer of the decoded text.
 * - Nothing the emulator generates reaches the pane: only typed, pasted and
 *   pointer input leaves it (focus reports included).
 * - Palette and dynamic-colour changes and window operations are
 *   swallowed (every viewer keeps its theme); graphics never draw.
 * - Bells, titles and clipboard offers fire only while `live`.
 * - Character widths as tmux 3.7c lays them out: Unicode 15 grapheme
 *   clusters corrected by a table generated from the managed tmux.
 * - xterm 6.0.0 workarounds (lib/xterm-fixes.ts).
 */
export function applyTerminalProfile(terminal: ProfileTerminal & object, effects: TerminalEffects = {}): { setLive(live: boolean): void; links: ReturnType<typeof patchLinkLifetime> } {
  let live = true
  const parser = terminal.parser
  const swallow = () => true
  for (const id of [
    { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' },
    { final: 'n' }, { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' },
    { prefix: '>', final: 'q' }, { final: 'x' }, { final: 't' },
  ]) parser.registerCsiHandler(id, swallow)
  for (const id of [{ intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }, { final: 'q' }]) parser.registerDcsHandler(id, swallow)
  for (const ident of [4, 5, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 104, 105, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119]) parser.registerOscHandler(ident, swallow)
  parser.registerOscHandler(52, (data) => {
    if (!live) return true
    const text = clipboardText(data)
    if (text) effects.clipboardOffer?.(text)
    return true
  })
  parser.registerOscHandler(8, (data) => {
    const uri = data.slice(data.indexOf(';') + 1)
    // The default handler opens (or with an empty URI closes) the link.
    if (uri === '' || isAllowedLink(uri)) return false
    if (live) effects.deniedLink?.(uri)
    closeOpenLink(terminal)
    return true
  })
  dropGeneratedInput(terminal)
  terminal.onBell(() => { if (live) effects.bell?.() })
  terminal.onTitleChange((title) => { if (live) effects.title?.(title) })
  // Character widths as tmux 3.7c lays them out (lib/unicode-widths.ts).
  applyTmuxWidths(terminal)
  patchEraseAbove(terminal)
  patchAltBufferCapacity(terminal)
  patchReflowStaleMaps(terminal)
  patchUtf8Boundaries(terminal)
  patchSharedTabStops(terminal)
  patchSplitClusterReset(terminal)
  const links = patchLinkLifetime(terminal)
  return { setLive: (value) => { live = value }, links }
}

/**
 * xterm marks what the user produced (keys, paste, IME, pointer reports) as
 * user input and everything it generates itself (query replies, focus
 * reports) as not; only the former leaves a viewer. This is the profile's
 * enforcement point; the swallowed queries above keep the parser quiet too.
 */
function dropGeneratedInput(terminal: object): void {
  const internals = (terminal as { _core?: { coreService?: CoreService; _coreService?: CoreService } })._core
  const service = internals?.coreService ?? internals?._coreService
  if (!service || typeof service.triggerDataEvent !== 'function') return
  const trigger = service.triggerDataEvent.bind(service)
  service.triggerDataEvent = (data, wasUserInput = false) => { if (wasUserInput) trigger(data, true) }
}
interface CoreService { triggerDataEvent(data: string, wasUserInput?: boolean): void }

/** Ends an open OSC 8 link exactly as xterm's own close does (the pinned version's internals). */
function closeOpenLink(terminal: object): void {
  const attributes = (terminal as { _core?: { _inputHandler?: { _curAttrData?: { extended?: { urlId: number; clone(): { urlId: number } }; updateExtended(): void } } } })._core?._inputHandler?._curAttrData
  if (!attributes?.extended?.urlId) return
  const extended = attributes.extended.clone()
  extended.urlId = 0
  attributes.extended = extended as typeof attributes.extended
  attributes.updateExtended()
}
