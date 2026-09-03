import { expect, test } from 'bun:test'
import { human } from '../lib/http'
test('browser boundary rejects missing client markers and cross-site requests', () => {
  const incoming = (headers: Record<string, string>) => ({
    url: 'http://localhost:3737/api/plugins/terminal/sessions',
    headers: { get: (name: string) => headers[name] ?? null },
  }) as Request
  expect(() => human(new Request('http://localhost:3737/api/plugins/terminal/sessions'))).toThrow()
  const headers = { 'x-bakin-terminal-client': 'browser-123456789', origin: 'http://localhost:3737' }
  expect(human(new Request('http://localhost:3737/api/plugins/terminal/sessions', { headers })).kind).toBe('human')
  expect(() => human(incoming({ ...headers, origin: 'https://attacker.example' }))).toThrow()
})
