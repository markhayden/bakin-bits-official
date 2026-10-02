import type { Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/** Optional acceleration: the terminal's normal renderer remains the fallback. */
export function enableWebgl(
  terminal: Pick<Terminal, 'loadAddon' | 'element'>,
  createAddon: () => WebglAddon = () => new WebglAddon(),
): () => void {
  let addon: WebglAddon | undefined
  let contextLoss: { dispose(): void } | undefined
  let pixels: ResizeObserver | undefined
  const dispose = () => {
    pixels?.disconnect()
    pixels = undefined
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
    const element = terminal.element
    const browser = element?.ownerDocument.defaultView
    if (element && browser?.ResizeObserver) {
      // Chromium device emulation can report physical content-box pixels at
      // the host scale while devicePixelRatio uses the emulated scale. xterm
      // then shrinks its canvas beneath the GPU viewport and clips the text.
      // A real display may round by one pixel; larger disagreements use DOM.
      pixels = new browser.ResizeObserver(entries => {
        const entry = entries.find(value => value.target === element)
        const device = entry?.devicePixelContentBoxSize?.[0]
        if (!entry || !device || !entry.contentRect.width || !entry.contentRect.height) return
        const dpr = browser.devicePixelRatio
        if (Math.abs(device.inlineSize - entry.contentRect.width * dpr) > 1
          || Math.abs(device.blockSize - entry.contentRect.height * dpr) > 1) dispose()
      })
      pixels.observe(element)
    }
  } catch {
    // Unsupported/blocked GPU contexts must not prevent a shell from opening.
    dispose()
  }
  return dispose
}
