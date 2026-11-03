import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ControlClient } from '../lib/control'
import { TmuxProcesses } from '../lib/processes'
import type { TerminalService } from '../lib/service'

const root = mkdtempSync(join(tmpdir(), 'bakin-paste-cleanup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A tmux whose answers the test sets: the service's own clients, and one session's control connection. */
function fixture() {
  const buffers = new Set<string>()
  const calls: string[] = []
  let serviceDown = false
  let pasteFails = false
  /** tmux stops answering the service's clients when the paste fails (the cleanup cannot reach it). */
  let downWithPaste = false
  const service = {
    root,
    // As the real service: `optional` turns a failed tmux client into empty output.
    command: async (args: string[], optional = false) => {
      calls.push(args[0]!)
      if (serviceDown) { if (optional) return ''; throw new Error('tmux unreachable') }
      if (args[0] === 'list-buffers') return [...buffers].join('\n')
      if (args[0] === 'delete-buffer') buffers.delete(args[2]!)
      return ''
    },
  } as unknown as TerminalService
  const control = {
    ready: Promise.resolve(), isClosed: false,
    command: async (args: string[]) => {
      if (args[0] === 'display-message') return ['0']
      if (args[0] === 'load-buffer') buffers.add(args[2]!)
      if (args[0] === 'paste-buffer') {
        if (pasteFails) { if (downWithPaste) serviceDown = true; throw new Error('paste failed') }
        buffers.delete(args[6]!)
      }
      return []
    },
    sendKeys: async () => {},
  } as unknown as ControlClient
  const processes = new TmuxProcesses(service)
  ;(processes as unknown as { controls: Map<string, ControlClient> }).controls.set('s', control)
  return {
    processes, buffers, calls,
    down: (value: boolean) => { serviceDown = value },
    failPaste: (value: boolean, down = false) => { pasteFails = value; downWithPaste = down },
  }
}

describe('paste cleanup', () => {
  it('deletes the buffer of a paste that failed after its load, and leaves no file', async () => {
    const f = fixture()
    f.failPaste(true)
    await expect(f.processes.write('s', 'text', { paste: true })).rejects.toThrow('paste failed')
    expect([...f.buffers]).toEqual([])
    expect(existsSync(join(root, 'paste')) ? readdirSync(join(root, 'paste')) : []).toEqual([])
  })
  it('a cleanup tmux could not answer is retried by the next paste sweep, until it succeeds', async () => {
    const f = fixture()
    // The first paste sweeps (nothing to find); then its paste fails and tmux cannot be reached to clean up.
    f.failPaste(true, true)
    await expect(f.processes.write('s', 'one', { paste: true })).rejects.toThrow('paste failed')
    expect(f.buffers.size).toBe(1)
    // tmux is back: the next paste sweeps first, and the left buffer goes.
    f.down(false)
    f.failPaste(false)
    const before = f.calls.length
    await f.processes.write('s', 'two', { paste: true })
    expect(f.calls.slice(before).filter((call) => call === 'list-buffers').length).toBeGreaterThan(0)
    expect([...f.buffers]).toEqual([])
    // Clean now: the following paste does not sweep again.
    const after = f.calls.length
    await f.processes.write('s', 'three', { paste: true })
    expect(f.calls.slice(after)).toEqual([])
  })
})
