/**
 * The grid this screen's terminal pane will hold, measured before the session
 * exists so its program starts at the size it is first seen at (spec D3); the
 * canvas refines it once it mounts (the creator holds the size claim). Cells
 * are measured in xterm's own font face at this device's font; the width is
 * the plugin's area (not the window, which includes the host's navigation);
 * the chrome allowance covers the workspace header, the canvas inset and, on
 * touch screens, the key strip. It carries the device kind so the header can
 * say "Sized by phone".
 */
import { BASE_FONT, screenDevice, storedFont, type ScreenDevice } from './terminal-view'

/** xterm's default `fontFamily`; the canvas never overrides it. */
const XTERM_FONT = 'courier-new, courier, monospace'
const INSET = 32

/**
 * One cell at `fontSize`, rounded the way the renderer the canvas will use
 * rounds it: the WebGL renderer snaps cell widths down to device pixels; the
 * DOM fallback (no WebGL2) keeps them fractional.
 */
export function measureCell(fontSize: number, doc: Document = document, dpr = window.devicePixelRatio || 1, snaps = webglAvailable(doc)): { width: number; height: number } {
  const probe = doc.createElement('span')
  probe.textContent = 'W'.repeat(32)
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: XTERM_FONT, fontSize: `${fontSize}px`, lineHeight: 'normal' })
  doc.body.appendChild(probe)
  const box = probe.getBoundingClientRect()
  probe.remove()
  const width = box.width / 32
  return { width: snaps ? Math.floor(width * dpr) / dpr : width, height: Math.ceil(box.height * dpr) / dpr }
}

let webgl: boolean | undefined
/** Whether the canvas's WebGL renderer can start here (it needs WebGL2). Asked once. */
function webglAvailable(doc: Document): boolean {
  if (webgl === undefined) {
    const context = doc.createElement('canvas').getContext('webgl2')
    webgl = Boolean(context)
    context?.getExtension('WEBGL_lose_context')?.loseContext()
  }
  return webgl
}

export function estimateTerminalSize(
  view: Pick<Window, 'innerWidth' | 'innerHeight' | 'matchMedia' | 'screen'> = window,
  area: number = document.querySelector('[data-bakin-plugin="terminal"]')?.clientWidth || view.innerWidth,
  cell: { width: number; height: number } = measureCell(storedFont() ?? BASE_FONT),
): { cols: number; rows: number; device: ScreenDevice } {
  const touch = view.matchMedia('(pointer: coarse)').matches
  const height = view.innerHeight - 96 - (touch ? 112 : 0)
  return { cols: Math.max(1, Math.floor((area - INSET) / cell.width)), rows: Math.max(1, Math.floor((height - INSET) / cell.height)), device: screenDevice(view) }
}
