import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'

const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-probe-'))
const socket = join(root, 'tmux.sock')
const tmux = Bun.which('tmux')!
const uid = process.getuid!()
const label = `io.bakin.terminal-probe.${process.pid}`
const hostLabel = `${label}.host`
const jobs: string[] = []

async function run(argv: string[], allowFailure = false): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  if (code && !allowFailure) throw new Error(`${argv[0]} exited ${code}: ${stderr}`)
  return stdout.trim()
}
const mux = (...args: string[]) => run([tmux, '-S', socket, ...args])
async function until(check: () => Promise<boolean>, name: string): Promise<void> {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out: ${name}`)
}
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
async function bootstrap(name: string, argv: string[]): Promise<void> {
  const path = join(root, `${name}.plist`)
  writeFileSync(path, `<?xml version="1.0"?><plist version="1.0"><dict>
<key>Label</key><string>${name}</string>
<key>ProgramArguments</key><array>${argv.map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardErrorPath</key><string>${xml(join(root, `${name}.err`))}</string>
</dict></plist>`)
  await run(['launchctl', 'bootstrap', `gui/${uid}`, path])
  jobs.push(name)
}

try {
  await bootstrap(label, [tmux, '-D', '-S', socket, '-f', '/dev/null'])
  await until(async () => {
    try { await mux('show-options', '-s'); return true } catch { return false }
  }, 'tmux service')
  await mux('new-session', '-d', '-s', 'probe', '-x', '80', '-y', '24', '/bin/sh')
  const panePid = await mux('display-message', '-p', '-t', 'probe:0.0', '#{pane_pid}')
  const attachFile = join(root, 'attach.ts')
  writeFileSync(attachFile, `const p=Bun.spawn(${JSON.stringify([tmux, '-S', socket, 'attach-session', '-t', 'probe'])},{env:{...process.env,TERM:'xterm-256color'},terminal:{cols:80,rows:24,data(_t,d){process.stderr.write(d)}}}); await p.exited;`)
  await bootstrap(hostLabel, [process.execPath, attachFile])
  await until(async () => (await mux('list-clients', '-F', '#{client_pid}')).length > 0, 'attachment')
  const clientBefore = await mux('list-clients', '-F', '#{client_pid}')
  await mux('send-keys', '-t', 'probe:0.0', '-l', 'while :; do printf "tick\\n"; sleep 0.1; done')
  await mux('send-keys', '-t', 'probe:0.0', 'Enter')
  await until(async () => (await mux('capture-pane', '-p', '-t', 'probe:0.0')).includes('tick'), 'counter')
  await run(['launchctl', 'kickstart', '-k', `gui/${uid}/${hostLabel}`])
  await until(async () => {
    const next = await mux('list-clients', '-F', '#{client_pid}')
    return Boolean(next) && next !== clientBefore
  }, 'reattachment after service restart')
  assert.equal(await mux('display-message', '-p', '-t', 'probe:0.0', '#{pane_pid}'), panePid)
  await mux('resize-window', '-t', 'probe:0', '-x', '100', '-y', '30')
  assert.equal(await mux('display-message', '-p', '-t', 'probe:0.0', '#{pane_width}x#{pane_height}'), '100x30')
  await mux('send-keys', '-t', 'probe:0.0', 'C-c')
  await mux('send-keys', '-t', 'probe:0.0', '-l', 'printf "INTERRUPT_OK\\n"')
  await mux('send-keys', '-t', 'probe:0.0', 'Enter')
  await until(async () => (await mux('capture-pane', '-p', '-t', 'probe:0.0')).includes('\nINTERRUPT_OK'), 'interrupt')
  console.log(JSON.stringify({ version: await run([tmux, '-V']), supervisedRestart: 'passed', panePid, resize: 'passed', interrupt: 'passed' }))
} finally {
  for (const job of jobs.reverse()) await run(['launchctl', 'bootout', `gui/${uid}/${job}`], true)
  await run([tmux, '-S', socket, 'kill-server'], true)
  rmSync(root, { recursive: true, force: true })
}
