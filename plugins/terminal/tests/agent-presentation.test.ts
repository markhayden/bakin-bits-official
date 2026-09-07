import { expect, test } from 'bun:test'
import { terminalAgentOptions } from '../components/use-terminal-agents'

test('agent choices carry kit identity without changing terminal access policy', () => {
  const choices = terminalAgentOptions(
    [{ id: 'patch', name: 'runtime name', enabled: false }, { id: 'other', name: 'Other', enabled: true }],
    [{ id: 'patch', name: 'Patch', headshot: '/portrait.png' }],
    { patch: { displayName: 'Patch Dev', accentColor: '#123456' } },
  )
  expect(choices[0]).toEqual({ id: 'patch', name: 'Patch Dev (access disabled)', imageSrc: '/portrait.png', color: '#123456', disabled: true })
  expect(choices[1]).toEqual({ id: 'other', name: 'Other', imageSrc: undefined, color: undefined, disabled: false })
})
