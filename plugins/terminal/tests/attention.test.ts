import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxProcesses } from '../lib/processes'
import type { TerminalService } from '../lib/service'
import { ACTIVE_MS, activity, ATTENTION_ENV, bellHook, attentionLaunch, attentionPaths, claudeSettings, codexOverrides, HELPER_SCRIPT, parseAttention } from '../lib/attention'

const root = mkdtempSync(join(tmpdir(), 'bakin-terminal-attention-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const launch = (program: 'shell' | 'claude' | 'codex', dir = root) => attentionLaunch(program, { root: dir, tmux: '/managed/tmux', socket: '/tmp/s.sock', sessionId: 'terminal-abc' })

describe('parseAttention', () => {
  test('a state, trimmed; anything else is unknown', () => {
    expect(parseAttention('needs-you\n')).toBe('needs-you')
    expect(parseAttention('turn-finished')).toBe('turn-finished')
    expect(parseAttention('working')).toBe('working')
    expect(parseAttention('')).toBeUndefined()
    expect(parseAttention('idle')).toBeUndefined()
  })
})

describe('adapters', () => {
  test('a shell gets no hooks and no environment', () => {
    expect(launch('shell')).toEqual({ args: [], env: {} })
  })
  test('Claude Code: --settings with the generated hooks, mapping prompts, turns and starts', () => {
    const { args, env } = launch('claude')
    const paths = attentionPaths(root)
    expect(args).toEqual(['--settings', paths.claudeSettings])
    expect(env).toEqual({ [ATTENTION_ENV.tmux]: '/managed/tmux', [ATTENTION_ENV.socket]: '/tmp/s.sock', [ATTENTION_ENV.target]: 'terminal-abc' })
    const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))
    expect(settings).toEqual(claudeSettings(paths.helper))
    const commandOf = (event: string, index = 0) => settings.hooks[event][index].hooks[0].command as string
    expect(commandOf('Notification')).toBe(`'${paths.helper}' 'needs-you' always`)
    // An idle prompt is never "needs you": it only clears what an interrupted turn left behind.
    expect(settings.hooks.Notification[0].matcher.split('|')).not.toContain('idle_prompt')
    expect(settings.hooks.Notification[0].matcher.split('|')).toContain('permission_prompt')
    expect(settings.hooks.Notification[1].matcher).toBe('idle_prompt')
    expect(commandOf('Notification', 1)).toBe(`'${paths.helper}' '' stale`)
    expect(commandOf('Stop')).toBe(`'${paths.helper}' 'turn-finished' always`)
    expect(commandOf('UserPromptSubmit')).toBe(`'${paths.helper}' 'working' always`)
    // A subagent's tool run never resets the main agent's state.
    expect(commandOf('PostToolUse')).toBe(`'${paths.helper}' 'working' main`)
    expect(commandOf('SessionStart')).toBe(`'${paths.helper}' '' always`)
    expect(commandOf('SessionEnd')).toBe(`'${paths.helper}' '' always`)
    expect(statSync(paths.claudeSettings).mode & 0o777).toBe(0o600)
  })
  test('Codex: -c hook overrides for approval, turns and starts', () => {
    const { args } = launch('codex')
    const { helper } = attentionPaths(root)
    expect(args).toEqual(codexOverrides(helper))
    const overrides = args.filter((_, index) => index % 2 === 1)
    expect(args.filter((_, index) => index % 2 === 0).every((flag) => flag === '-c')).toBe(true)
    expect(overrides).toContain(`hooks.PermissionRequest=[{hooks=[{type="command",command=${JSON.stringify(`'${helper}' 'needs-you' always`)}}]}]`)
    expect(overrides.some((entry) => entry.startsWith('hooks.Stop=') && entry.includes('turn-finished'))).toBe(true)
    // An interrupted turn clears; a subagent's tool run does not reset it.
    expect(overrides).toContain(`hooks.Interrupt=[{hooks=[{type="command",command=${JSON.stringify(`'${helper}' '' always`)}}]}]`)
    expect(overrides.find((entry) => entry.startsWith('hooks.PostToolUse='))).toContain("'working' main")
    // Never past Codex's hook trust.
    expect(args.join(' ')).not.toContain('bypass')
  })
  test('every hook command is the same in every session (Codex trusts a hook by its hash)', () => {
    const one = attentionLaunch('codex', { root, tmux: '/a', socket: '/s1', sessionId: 'terminal-one' })
    const two = attentionLaunch('codex', { root, tmux: '/b', socket: '/s2', sessionId: 'terminal-two' })
    expect(one.args).toEqual(two.args)
    expect(one.env).not.toEqual(two.env)
  })
  test('the helper is written executable, once, and rewritten when it differs', () => {
    const dir = mkdtempSync(join(root, 'helper-'))
    launch('codex', dir)
    const { helper } = attentionPaths(dir)
    expect(readFileSync(helper, 'utf8')).toBe(HELPER_SCRIPT)
    expect(statSync(helper).mode & 0o777).toBe(0o700)
    writeFileSync(helper, 'stale')
    chmodSync(helper, 0o644)
    launch('codex', dir)
    expect(readFileSync(helper, 'utf8')).toBe(HELPER_SCRIPT)
    expect(statSync(helper).mode & 0o777).toBe(0o700)
  })
})

describe('helper script', () => {
  const dir = mkdtempSync(join(root, 'run-'))
  launch('claude', dir)
  const { helper } = attentionPaths(dir)
  // A stand-in tmux that records its arguments.
  const fakeTmux = join(dir, 'tmux')
  const record = join(dir, 'args')
  writeFileSync(fakeTmux, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o700 })
  const managed = { [ATTENTION_ENV.tmux]: fakeTmux, [ATTENTION_ENV.socket]: '/tmp/s.sock', [ATTENTION_ENV.target]: 'terminal-abc' }
  const run = async (args: string[], env: Record<string, string>, input = '{"hook_event_name":"Stop"}') => {
    rmSync(record, { force: true })
    const child = Bun.spawn([helper, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' })
    return { stdout: await new Response(child.stdout).text(), code: await child.exited }
  }
  const recorded = () => { try { return readFileSync(record, 'utf8').split('\n').slice(0, -1) } catch { return undefined } }
  test('sets the session pane option through the named tmux and socket, and prints {}', async () => {
    const result = await run(['needs-you', 'always'], managed)
    expect(result).toEqual({ stdout: '{}\n', code: 0 })
    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['-S', '/tmp/s.sock', 'set-option', '-p', '-t', 'terminal-abc', '@bakin_attention', 'needs-you'])
  })
  test('main: a subagent hook (a top-level agent_id) changes nothing; the main agent\'s does, even with agent_id nested', async () => {
    expect(await run(['working', 'main'], managed, '{"hook_event_name":"PostToolUse","agent_id":"sub-1","tool_name":"Bash"}')).toEqual({ stdout: '{}\n', code: 0 })
    expect(recorded()).toBeUndefined()
    await run(['working', 'main'], managed, '{ "session_id": "s", "agent_id" : "sub-2" }')
    expect(recorded()).toBeUndefined()
    for (const input of ['{"hook_event_name":"PostToolUse","tool_name":"Bash"}', '{"tool_response":{"agent_id":"n"},"x":"\\"agent_id\\":"}', '{"tool_input":["agent_id",{"agent_id":1}]}']) {
      await run(['working', 'main'], managed, input)
      expect(recorded()?.at(-1)).toBe('working')
    }
  })
  test('stale: one tmux command that clears only working or needs-you (decided by tmux, so a newer state survives)', async () => {
    await run(['', 'stale'], managed, '{"hook_event_name":"Notification","notification_type":"idle_prompt"}')
    expect(recorded()).toEqual(['-S', '/tmp/s.sock', 'if-shell', '-F', '-t', 'terminal-abc', '#{m/r:^(working|needs-you)$,#{@bakin_attention}}', "set-option -p -t terminal-abc @bakin_attention ''"])
  })
  test('a session target tmux would parse as more than a name is refused', async () => {
    expect(await run(['', 'stale'], { ...managed, [ATTENTION_ENV.target]: 'x; kill-server' })).toEqual({ stdout: '{}\n', code: 0 })
    expect(recorded()).toBeUndefined()
  })
  test('without its environment (run outside Bakin) it does nothing and still succeeds', async () => {
    rmSync(record, { force: true })
    expect(await run(['working', 'always'], {})).toEqual({ stdout: '{}\n', code: 0 })
    expect(() => statSync(record)).toThrow()
  })
  test('a failing tmux never fails the hook', async () => {
    expect(await run(['working', 'always'], { [ATTENTION_ENV.tmux]: '/nonexistent/tmux', [ATTENTION_ENV.socket]: '/tmp/s.sock', [ATTENTION_ENV.target]: 'terminal-abc' })).toEqual({ stdout: '{}\n', code: 0 })
  })
})

describe('bellHook', () => {
  test('a per-session alert-bell hook that counts bells in @bakin_bell', () => {
    expect(bellHook('terminal-abc')).toEqual(['set-hook', '-t', 'terminal-abc', 'alert-bell', 'set-option -F -t terminal-abc @bakin_bell "#{e|+:#{@bakin_bell},1}"'])
  })
})

describe('launch', () => {
  test('the session is made and its bell hook set in one tmux command (no program output is read in between)', async () => {
    const commands: string[][] = []
    const service = { root, tmux: '/managed/tmux', socket: '/tmp/s.sock', ready: async () => true, command: async (args: string[]) => { commands.push(args); return '' } } as unknown as TerminalService
    const session = { id: 'terminal-new', title: 'New', cwd: root, program: 'codex', cols: 80, rows: 24 } as Parameters<TmuxProcesses['create']>[0]
    await new TmuxProcesses(service).create({ ...session, program: 'shell' })
    const made = commands[0]
    expect(made[0]).toBe('new-session')
    expect(made.slice(made.lastIndexOf(';') + 1)).toEqual(bellHook('terminal-new'))
    expect(made.indexOf(';')).toBe(made.lastIndexOf(';'))
  })
})

describe('activity', () => {
  test('active within ACTIVE_MS of real output, quiet after or without any, exited once the program ended', () => {
    const running = { state: 'running' } as const
    expect(activity(running, 1000, 1000 + ACTIVE_MS - 1)).toBe('active')
    expect(activity(running, 1000, 1000 + ACTIVE_MS)).toBe('quiet')
    expect(activity(running, undefined, 1000)).toBe('quiet')
    expect(activity({ state: 'exited' }, 1000, 1000)).toBe('exited')
    expect(activity({ state: 'completed' }, undefined, 1000)).toBe('exited')
  })
})
