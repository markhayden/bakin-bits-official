/** The parser surface both xterm and @xterm/headless expose. */
interface ParserTerminal {
  parser: { registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void } }
}

/**
 * Whether the output last hid the cursor (DECTCEM, CSI ? 25 h/l), as xterm
 * applies it; xterm keeps this private. DECSTR (CSI ! p) shows it again;
 * RIS leaves it as is in xterm 6, so it does here too. Every handler lets
 * xterm handle the sequence as well.
 */
export function trackCursorVisibility(terminal: ParserTerminal): { readonly hidden: boolean; dispose(): void } {
  let hidden = false
  const mode = (value: boolean) => (params: (number | number[])[]) => {
    if (params.includes(25)) hidden = value
    return false
  }
  const handlers = [
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, mode(false)),
    terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, mode(true)),
    terminal.parser.registerCsiHandler({ intermediates: '!', final: 'p' }, () => { hidden = false; return false }),
  ]
  return {
    get hidden() { return hidden },
    dispose() { for (const handler of handlers) handler.dispose() },
  }
}

