import { describe, it, expect } from 'bun:test'
import { terminalEnvironment } from '../lib/service'

describe('terminalEnvironment', () => {
  it('never forwards Bakin-injected provider secrets to the shell', () => {
    // The env passed to tmux/PTY is an allowlist, so secrets that Bakin injects
    // into the server process must not reach a spawned shell.
    const injected = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'BAKIN_MCP_SECRET', 'GITHUB_TOKEN']
    for (const key of injected) process.env[key] = `leaked-${key}`
    try {
      const env = terminalEnvironment()
      for (const key of injected) expect(env[key]).toBeUndefined()
      // Sanity: allowlisted vars still come through.
      expect(env.TERM).toBe('xterm-256color')
      expect(env.PATH).toBeTruthy()
    } finally {
      for (const key of injected) delete process.env[key]
    }
  })
})
