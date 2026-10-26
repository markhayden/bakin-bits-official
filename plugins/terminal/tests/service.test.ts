import { afterAll, afterEach, beforeEach, describe, it, expect, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'terminal-service-test-'))
mock.module('node:os', () => ({ homedir: () => home, tmpdir }))
const { TerminalService, terminalEnvironment } = await import('../lib/service')
const { tmuxConfig } = await import('../lib/tmux-config')
afterAll(() => rmSync(home, { recursive: true, force: true }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string
let service: InstanceType<typeof TerminalService>
let running: boolean
let loaded: boolean
let panes: string
let paneError: boolean
let commands: string[][]
let restoreSpawn: () => void
const managedTmux = join(home, '.bakin/bin/tmux')
function installManagedTmux() {
  mkdirSync(join(home, '.bakin/bin'), { recursive: true })
  writeFileSync(managedTmux, '#!/bin/sh\n', { mode: 0o755 })
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  root = mkdtempSync(join(home, 'data-'))
  installManagedTmux()
  running = true; loaded = true; panes = ''; paneError = false; commands = []
  const spawn = spyOn(Bun, 'spawn').mockImplementation(((args: string[]) => {
    commands.push(args)
    let output = '', error = '', exit = 0
    if (args[0] === '/usr/bin/plutil') {
      output = readFileSync(args.at(-1)!, 'utf8').match(/<array><string>(.*?)<\/string>/)?.[1] ?? ''
      if (!output) exit = 1
    } else if (args[0] === 'launchctl') {
      if (args[1] === 'print') exit = loaded ? 0 : 113
      if (args[1] === 'bootout') { running = false; loaded = false }
      if (args[1] === 'bootstrap') { running = true; loaded = true }
    } else if (args.includes('show-options')) exit = running ? 0 : 1
    else if (args.includes('list-sessions')) output = panes ? [...new Set(panes.trim().split('\n').map(line => line.split(' ')[0]))].join('\n') + '\n' : ''
    else if (args.includes('list-panes')) {
      output = panes
      if (paneError) { exit = 1; error = 'cannot inspect panes' }
    }
    return { stdout: new Response(output).body, stderr: new Response(error).body, exited: Promise.resolve(exit) }
  }) as typeof Bun.spawn)
  restoreSpawn = () => spawn.mockRestore()
  service = new TerminalService(root)
})
afterEach(() => {
  restoreSpawn()
  Object.defineProperty(process, 'platform', originalPlatform)
  rmSync(join(home, 'Library'), { recursive: true, force: true })
  rmSync(join(home, '.bakin'), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  rmSync(join(service.socket, '..'), { recursive: true, force: true })
})
const plistPath = () => join(home, 'Library/LaunchAgents', `${service.label}.plist`)
function oldPlist() {
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true })
  writeFileSync(plistPath(), '<plist><dict><key>ProgramArguments</key><array><string>/opt/homebrew/bin/tmux</string></array></dict></plist>')
}

describe('terminal service managed binary', () => {
  it('prefers the managed bin directory without forwarding provider secrets', () => {
    const previous = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'test-only-secret'
    try {
      const env = terminalEnvironment()
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.PATH.split(':')[0]).toBe(join(home, '.bakin/bin'))
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = previous
    }
  })
  it('resolves only the managed binary, and picks up a repair on the same instance', () => {
    rmSync(managedTmux)
    const which = spyOn(Bun, 'which').mockImplementation(() => '/opt/homebrew/bin/tmux')
    try {
      expect(service.tmux).toBeNull()
      installManagedTmux()
      expect(service.tmux).toBe(managedTmux)
    } finally { which.mockRestore() }
  })
  it('migrates an idle Homebrew service to the managed binary and the generated config', async () => {
    oldPlist()
    expect(await service.updateRequired()).toBe(true)
    await service.install()
    expect(readFileSync(plistPath(), 'utf8')).toContain(`<string>${managedTmux}</string>`)
    expect(readFileSync(join(root, 'tmux.conf'), 'utf8')).toBe(tmuxConfig())
    expect(commands.filter(args => args[0] === 'launchctl').map(args => args[1])).toEqual(['bootout', 'bootstrap'])
    expect(await service.updateRequired()).toBe(false)
  })
  it('requires an update when the running service has no verified fingerprint, even on the managed path', async () => {
    await service.install()
    rmSync(join(root, 'service.json'))
    expect(await service.updateRequired()).toBe(true)
    commands = []
    await service.install()
    expect(commands.filter(args => args[0] === 'launchctl').map(args => args[1])).toEqual(['bootout', 'bootstrap'])
    expect(await service.updateRequired()).toBe(false)
  })
  it('requires an update when the LaunchAgent runs another executable despite a matching record', async () => {
    await service.install()
    const plist = readFileSync(plistPath(), 'utf8')
    writeFileSync(plistPath(), plist.replace(`<string>${managedTmux}</string>`, '<string>/opt/homebrew/bin/tmux</string>'))
    expect(await service.updateRequired()).toBe(true)
    commands = []
    await service.install()
    expect(commands.filter(args => args[0] === 'launchctl').map(args => args[1])).toEqual(['bootout', 'bootstrap'])
  })
  it('requires an update when the recorded fingerprint differs from the desired one', async () => {
    await service.install()
    writeFileSync(join(root, 'service.json'), JSON.stringify({ fingerprint: 'stale' }))
    expect(await service.updateRequired()).toBe(true)
  })
  it('records nothing when the restarted service never becomes ready', async () => {
    oldPlist()
    const spawn = Bun.spawn as unknown as { mockImplementation: (fn: unknown) => void }
    const original = (Bun.spawn as unknown as { getMockImplementation: () => (args: string[]) => unknown }).getMockImplementation()
    spawn.mockImplementation((args: string[]) => {
      if (args.includes('show-options') && commands.some(c => c[1] === 'bootstrap')) { commands.push(args); return { stdout: new Response('').body, stderr: new Response('').body, exited: Promise.resolve(1) } }
      return original(args)
    })
    await expect(service.install()).rejects.toThrow('did not become ready')
    expect(existsSync(join(root, 'service.json'))).toBe(false)
    expect(await service.updateRequired()).toBe(true)
  })
  it('leaves the service and plist untouched when any live pane remains, naming the sessions', async () => {
    oldPlist(); panes = 'terminal-a 0\nterminal-b 1\nterminal-c 0\n'
    const before = readFileSync(plistPath(), 'utf8')
    await expect(service.install()).rejects.toThrow('2 live terminal sessions (terminal-a, terminal-c)')
    expect(readFileSync(plistPath(), 'utf8')).toBe(before)
    expect(commands.some(args => args[0] === 'launchctl')).toBe(false)
  })
  it('fails closed when pane state cannot be verified', async () => {
    oldPlist(); panes = 'terminal-a 0\n'; paneError = true
    await expect(service.install()).rejects.toThrow('cannot inspect panes')
    expect(commands.some(args => args[1] === 'bootout')).toBe(false)
  })
  it('does not restart a loaded service whose process state is unknown', async () => {
    oldPlist(); running = false
    await expect(service.install()).rejects.toThrow('process state is unknown')
    expect(commands.some(args => args[1] === 'bootout')).toBe(false)
  })
  it('bootstraps an unloaded old plist and shares concurrent setup requests', async () => {
    oldPlist(); running = false; loaded = false
    await Promise.all([service.install(), service.install()])
    expect(commands.filter(args => args[1] === 'bootstrap')).toHaveLength(1)
  })
  it('reports the Bakin repair when tmux is missing', async () => {
    rmSync(managedTmux)
    await expect(service.install()).rejects.toThrow('bakin install plugin-assets')
  })
})
