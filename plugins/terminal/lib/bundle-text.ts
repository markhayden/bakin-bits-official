/**
 * An ended session's text (the agent tool's `output`, chosen 2026-10-29):
 * its saved final picture (lib/bundle.ts) replayed into a headless terminal
 * as the replica applies events — the checkpoint, then the tail's seeds,
 * layouts, output and geometries — and read as plain text (lib/buffer-text.ts).
 */
import { bufferText } from './buffer-text'
import { pieces, restoreCheckpoint } from './checkpoint'
import { installGeometry } from './geometry'
import type { Bundle } from './bundle'
import { profileTerminal } from './replica'
import type { Term } from './terminal-state'

const write = (terminal: Term, data: string | Uint8Array) => new Promise<void>((resolve) => terminal.write(data, resolve))
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export async function bundleText(bundle: Bundle): Promise<{ text: string; lines: number }> {
  const { checkpoint, tail } = bundle.cut
  let { terminal } = profileTerminal(checkpoint.cols, checkpoint.rows)
  try {
    await restoreCheckpoint(terminal, checkpoint)
    for (const event of tail) {
      if (event.kind === 'output') await write(terminal, event.bytes)
      else if (event.kind === 'layout') terminal.resize(event.cols, event.rows)
      else if (event.kind === 'seed') {
        // A seed replaces the picture (a rebuild): a fresh terminal at its size.
        terminal.dispose()
        ;({ terminal } = profileTerminal(event.cols, event.rows))
        for (const piece of pieces([decode(event.bytes)])) await write(terminal, piece)
      } else {
        // A width change's geometry from tmux, installed as the replica installs it.
        const { terminal: source } = profileTerminal(event.cols, event.rows)
        try {
          for (const piece of pieces([decode(event.bytes)])) await write(source, piece)
          installGeometry(terminal, source)
        } finally { source.dispose() }
      }
    }
    return bufferText(terminal.buffer.active)
  } finally {
    terminal.dispose()
  }
}
