import { patchAltBufferCapacity, patchEraseAbove, patchLinkLifetime, patchReflowStaleMaps } from './xterm-fixes'

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
  resize(cols: number, rows: number): void
  buffer: { active: { type: string } }
}

/** What a program asked the viewer to do; each fires only live, never while a join is replayed. */
export interface TerminalEffects {
  bell?(): void
  title?(title: string): void
  /** OSC 52: the program offered text for the clipboard. It is never written automatically. */
  clipboardOffer?(text: string): void
  /** OSC 8 to a scheme other than http, https or mailto: the text prints without a link. */
  deniedLink?(uri: string): void
}

/** Clipboard offers longer than this are dropped. */
export const CLIPBOARD_OFFER_LIMIT = 256 * 1024
const LINK_SCHEMES = /^(?:https?|mailto):/i

/**
 * The one terminal profile (spec D13) for every emulator: the server
 * replica, each browser viewer and the checkpoint verifier parse alike.
 * - Queries and reports are swallowed: tmux is the pane's only responder
 *   (a viewer's answers would otherwise be typed into the pane).
 * - OSC 8 links: http, https and mailto only; a refused link also closes
 *   an open one, and its text still prints.
 * - OSC 52 never writes the clipboard; it is an offer.
 * - Palette and dynamic-colour changes and window operations are
 *   swallowed (every viewer keeps its theme); graphics never draw.
 * - Bells, titles and clipboard offers fire only while `live`.
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
    const text = data.slice(data.indexOf(';') + 1)
    if (live && text !== '?' && text.length <= CLIPBOARD_OFFER_LIMIT) effects.clipboardOffer?.(text)
    return true
  })
  parser.registerOscHandler(8, (data) => {
    const uri = data.slice(data.indexOf(';') + 1)
    // The default handler opens (or with an empty URI closes) the link.
    if (uri === '' || LINK_SCHEMES.test(uri)) return false
    if (live) effects.deniedLink?.(uri)
    closeOpenLink(terminal)
    return true
  })
  terminal.onBell(() => { if (live) effects.bell?.() })
  terminal.onTitleChange((title) => { if (live) effects.title?.(title) })
  patchEraseAbove(terminal)
  patchAltBufferCapacity(terminal)
  patchReflowStaleMaps(terminal)
  const links = patchLinkLifetime(terminal)
  return { setLive: (value) => { live = value }, links }
}

/** Ends an open OSC 8 link exactly as xterm's own close does (the pinned version's internals). */
function closeOpenLink(terminal: object): void {
  const attributes = (terminal as { _core?: { _inputHandler?: { _curAttrData?: { extended?: { urlId: number; clone(): { urlId: number } }; updateExtended(): void } } } })._core?._inputHandler?._curAttrData
  if (!attributes?.extended?.urlId) return
  const extended = attributes.extended.clone()
  extended.urlId = 0
  attributes.extended = extended as typeof attributes.extended
  attributes.updateExtended()
}
