import { expect, test } from 'bun:test'
import { terminalSettings } from '../lib/contracts'

test('the agent toggle grid resolves enablement; main is on until configured', () => {
  // Never configured (no enabledAgents) → the main agent is enabled by default.
  expect(terminalSettings({}).enabledAgents).toEqual([{ id: 'main' }])
  expect(terminalSettings({ maxSessions: 5 }).enabledAgents).toEqual([{ id: 'main' }])
  // The stored id array resolves to exactly those agents.
  expect(terminalSettings({ enabledAgents: ['patch', 'chef'] }).enabledAgents).toEqual([{ id: 'patch' }, { id: 'chef' }])
  // Explicitly turning everything off is respected — not overridden back to main.
  expect(terminalSettings({ enabledAgents: [] }).enabledAgents).toEqual([])
  // Non-string junk is dropped.
  expect(terminalSettings({ enabledAgents: ['patch', 42, null] }).enabledAgents).toEqual([{ id: 'patch' }])
  // Bounds still apply alongside the toggles.
  const b = terminalSettings({ enabledAgents: ['main'], maxSessions: 999, idleDays: 0 })
  expect(b.maxSessions).toBe(10)
  expect(b.idleDays).toBe(30)
})
