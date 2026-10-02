import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/** Optional acceleration: the terminal's normal renderer remains the fallback. */
export function enableWebgl(
  terminal: Pick<Terminal, 'loadAddon'>,
  createAddon: () => WebglAddon = () => new WebglAddon(),
): () => void {
  let addon: WebglAddon | undefined
  let contextLoss: { dispose(): void } | undefined
  const dispose = () => {
    const current = addon
    addon = undefined
    contextLoss?.dispose()
    contextLoss = undefined
    current?.dispose()
  }
  try {
    addon = createAddon()
    contextLoss = addon.onContextLoss(dispose)
    terminal.loadAddon(addon)
  } catch {
    // Unsupported/blocked GPU contexts must not prevent a shell from opening.
    dispose()
  }
  return dispose
}
