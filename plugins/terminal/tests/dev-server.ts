import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformPluginCss } from '@makinbakin/sdk/testing/ui/conformance'
import { TerminalService, terminalEnvironment } from '../lib/service'
import { TmuxProcesses } from '../lib/processes'
import { Sessions } from '../lib/sessions'
import { Store } from '../lib/store'
import { command, failure, human, stream } from '../lib/http'

const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-preview-'))
const service = new TerminalService(root)
if (!service.tmux) throw new Error('tmux is required for the local Terminal preview')
const tmux = Bun.spawn([service.tmux, '-D', '-S', service.socket, '-f', '/dev/null'], { env: terminalEnvironment(), stdout: 'ignore', stderr: 'ignore' })
for (let i = 0; i < 40 && !await service.ready(); i++) await Bun.sleep(50)
if (!await service.ready()) { tmux.kill(); await tmux.exited; throw new Error('Preview tmux service failed to start') }
await service.command(['set-option', '-g', 'exit-empty', 'off'])
await service.command(['set-option', '-g', 'remain-on-exit', 'on'])
await service.command(['set-option', '-g', 'status', 'off'])
await service.command(['set-option', '-g', 'prefix', 'None'])
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
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.TERMINAL_PREVIEW_PORT ?? 0),
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
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
        if (path === '/stream') return stream(manager, request)
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
