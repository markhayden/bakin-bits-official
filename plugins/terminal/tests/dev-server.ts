import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformPluginCss } from '@makinbakin/sdk/testing/ui/conformance'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { tmuxConfig } from '../lib/tmux-config'
import { TmuxProcesses } from '../lib/processes'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import type { PluginSocket } from '@makinbakin/sdk/types'
import { command, failure, human } from '../lib/http'
import { TerminalViewer } from '../lib/socket'

const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-preview-'))
// Terminal runs only the managed tmux: give the disposable home one
// (TERMINAL_TMUX, else the tmux on PATH) and the generated configuration.
const managed = process.env.TERMINAL_TMUX ?? Bun.which('tmux')
if (!managed) throw new Error('tmux is required for the local Terminal preview (set TERMINAL_TMUX)')
process.env.BAKIN_HOME = join(root, 'home')
mkdirSync(join(root, 'home', 'bin'), { recursive: true })
symlinkSync(managed, join(root, 'home', 'bin', 'tmux'))
const service = new TerminalService(root)
writeFileSync(join(root, 'tmux.conf'), tmuxConfig())
const tmux = Bun.spawn([service.tmux!, '-D', '-S', service.socket, '-f', join(root, 'tmux.conf')], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
for (let i = 0; i < 40 && !await service.ready(); i++) await Bun.sleep(50)
if (!await service.ready()) { tmux.kill(); await tmux.exited; throw new Error('Preview tmux service failed to start') }
const manager = new Sessions(new Store(join(root, 'terminal.db')), new TmuxProcesses(service), {
  settings: () => ({ enabledAgents: [{ id: 'patch' }] }),
  prepare: async () => ({ ok: false, error: 'Preview has no Git plugin. Use an existing checkout.' }),
  release: async () => ({ ok: false }),
})
const built = await Bun.build({
  entrypoints: [join(import.meta.dir, 'live.fixture.tsx')], outdir: root, target: 'browser', format: 'esm',
  naming: 'preview.[ext]', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'host-styles', setup(build) {
    build.onResolve({ filter: /^@makinbakin\/sdk\/styles\.css$/ }, () => ({ path: 'styles', namespace: 'host-styles' }))
    build.onLoad({ filter: /.*/, namespace: 'host-styles' }, () => ({ contents: '', loader: 'css' }))
  } }],
})
if (!built.success) throw new Error(built.logs.join('\n'))
const css = transformPluginCss({ pluginId: 'terminal', css: readFileSync(join(root, 'preview.css'), 'utf8'), from: 'preview.css' }).css
writeFileSync(join(root, 'preview.css'), css)
const sdkCss = readFileSync(Bun.resolveSync('@makinbakin/sdk/styles.css', import.meta.dir), 'utf8')
type ViewerData = { id: string; message: Array<(data: string | Uint8Array) => void>; close: Array<(code: number, reason: string) => void> }
const server = Bun.serve<ViewerData>({
  hostname: '127.0.0.1', port: Number(process.env.TERMINAL_PREVIEW_PORT ?? 0),
  idleTimeout: 0,
  // The host serves plugin socket routes (bakin #1029); the preview adapts
  // Bun's native WebSocket to the same PluginSocket the viewer expects.
  websocket: {
    open(ws) {
      const socket: PluginSocket = {
        send: (data) => { if (ws.readyState !== 1) return false; ws.send(data); return true },
        onMessage: (listener) => { ws.data.message.push(listener) },
        onClose: (listener) => { ws.data.close.push(listener) },
        close: (code, reason) => { ws.close(code, reason) },
      }
      new TerminalViewer(manager, socket, ws.data.id)
    },
    message(ws, data) { for (const listener of ws.data.message) listener(typeof data === 'string' ? data : new Uint8Array(data)) },
    close(ws, code, reason) { for (const listener of ws.data.close) listener(code, reason) },
  },
  async fetch(request, preview) {
    const url = new URL(request.url)
    if (url.pathname === '/api/plugins/terminal/socket') {
      // The same cross-site guard the host applies before any plugin socket.
      const origin = request.headers.get('origin')
      if (!origin || new URL(origin).host !== url.host) return new Response('Cross-origin socket refused', { status: 403 })
      const id = url.searchParams.get('id') ?? ''
      if (preview.upgrade(request, { data: { id, message: [], close: [] } })) return undefined
      return new Response('Upgrade required', { status: 426 })
    }
    try {
      if (url.pathname === '/api/plugins/projects/') return Response.json({ projects: [{ id: 'project-1', title: 'Bakin' }] })
      if (url.pathname.startsWith('/api/plugins/terminal/')) {
        const principal = human(request)
        const path = url.pathname.slice('/api/plugins/terminal'.length)
        if (path === '/options') return Response.json({ agents: [{ id: 'patch', name: 'Patch', enabled: true, workspace: '/tmp' }, { id: 'chef', name: 'Chef', enabled: false }], tasks: [{ id: 'task-1', title: 'Terminal development', agentId: 'patch', projectId: 'project-1' }], defaults: { cwd: process.cwd(), agentId: 'patch' } })
        if (path === '/sessions' && request.method === 'GET') {
          await manager.refreshStates()
          return Response.json({ sessions: manager.list(principal), serviceReady: true })
        }
        if (path === '/sessions' && request.method === 'POST') return Response.json(await manager.create(await request.json(), principal))
        if (path === '/session' && request.method === 'POST') return Response.json(await command(manager, await request.json(), principal))
        return new Response('Not found', { status: 404 })
      }
      if (url.pathname === '/preview.js' || url.pathname === '/preview.css') return new Response(Bun.file(join(root, url.pathname.slice(1))))
      if (url.pathname === '/sdk.css') return new Response(sdkCss, { headers: { 'Content-Type': 'text/css' } })
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
      return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bakin Terminal Preview</title><link rel="stylesheet" href="/sdk.css"><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
    } catch (error) { return failure(error) }
  },
})
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}`, workingDirectory: root }))
let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  server.stop(true)
  await manager.shutdown()
  await service.command(['kill-server'], true)
  tmux.kill(); await tmux.exited
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
