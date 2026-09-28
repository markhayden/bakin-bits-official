import { afterAll, afterEach, beforeEach, describe, it, expect, mock, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'terminal-service-test-'))
mock.module('node:os', () => ({ homedir: () => home, tmpdir }))
const { TerminalService, terminalEnvironment } = await import('../lib/service')
afterAll(() => rmSync(home, { recursive: true, force: true }))
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let root: string
let service: InstanceType<typeof TerminalService>
let resolved: string | null
let running: boolean
let loaded: boolean
let panes: string
let paneError: boolean
let commands: string[][]
let restoreSpawn: () => void
let restoreWhich: () => void

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  root = mkdtempSync(join(home, 'data-'))
  resolved = join(home, '.bakin/bin/tmux')
  running = true; loaded = true; panes = ''; paneError = false; commands = []
  const which = spyOn(Bun, 'which').mockImplementation(() => resolved)
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
    else if (args.includes('list-sessions')) output = panes ? 'test\n' : ''
    else if (args.includes('list-panes')) {
      output = panes
      if (paneError) { exit = 1; error = 'cannot inspect panes' }
    }
    return { stdout: new Response(output).body, stderr: new Response(error).body, exited: Promise.resolve(exit) }
  }) as typeof Bun.spawn)
  restoreSpawn = () => spawn.mockRestore(); restoreWhich = () => which.mockRestore()
  service = new TerminalService(root)
})
afterEach(() => {
  restoreSpawn(); restoreWhich()
  Object.defineProperty(process, 'platform', originalPlatform)
  rmSync(join(home, 'Library'), { recursive: true, force: true })
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
  it('resolves a repaired binary on the same service instance', () => {
    resolved = null
    expect(service.tmux).toBeNull()
    resolved = join(home, '.bakin/bin/tmux')
    expect(service.tmux).toBe(resolved)
  })
  it('migrates an idle Homebrew service to the absolute managed path', async () => {
    oldPlist()
    expect(await service.migrationRequired()).toBe(true)
    await service.install()
    expect(readFileSync(plistPath(), 'utf8')).toContain(`<string>${resolved}</string>`)
    expect(commands.filter(args => args[0] === 'launchctl').map(args => args[1])).toEqual(['bootout', 'bootstrap'])
    expect(await service.migrationRequired()).toBe(false)
  })
  it('leaves the service and plist untouched when any live pane remains', async () => {
    oldPlist(); panes = '0\n1\n0\n'
    const before = readFileSync(plistPath(), 'utf8')
    await expect(service.install()).rejects.toThrow('2 live terminal panes')
    expect(readFileSync(plistPath(), 'utf8')).toBe(before)
    expect(commands.some(args => args[0] === 'launchctl')).toBe(false)
  })
  it('fails closed when pane state cannot be verified', async () => {
    oldPlist(); panes = '0\n'; paneError = true
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
    resolved = null
    await expect(service.install()).rejects.toThrow('bakin install plugin-assets')
  })
})
