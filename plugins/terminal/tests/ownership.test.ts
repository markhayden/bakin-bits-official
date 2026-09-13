import { expect, test } from 'bun:test'
import { authorize, type Session } from '../lib/contracts'

const session: Session = {
  id: 'one', title: 'Shell', cwd: '/tmp', program: 'shell', agentId: 'patch',
  owner: { kind: 'agent', id: 'patch' }, generation: 1, inputSequence: 0,
  cols: 80, rows: 24, state: 'running', createdAt: 0, lastActivityAt: 0,
}
test('assignment, enablement and input generation are independent gates', () => {
  expect(() => authorize(session, { kind: 'agent', id: 'patch' }, ['patch'], true, 1)).not.toThrow()
  expect(() => authorize(session, { kind: 'agent', id: 'other' }, ['other'])).toThrow()
  expect(() => authorize(session, { kind: 'agent', id: 'patch' }, [])).toThrow()
  const taken = { ...session, owner: { kind: 'human' as const, id: 'tab' }, generation: 2 }
  expect(() => authorize(taken, { kind: 'agent', id: 'patch' }, ['patch'], true, 1)).toThrow()
  expect(() => authorize(taken, { kind: 'agent', id: 'patch' }, ['patch'])).not.toThrow()
  // The operator is not the tab: any human client may drive a human-owned
  // session, but only at the current generation (a takeover invalidates the rest).
  expect(() => authorize(taken, { kind: 'human', id: 'other-tab' }, [], true, 2)).not.toThrow()
  expect(() => authorize(taken, { kind: 'human', id: 'tab' }, [], true, 2)).not.toThrow()
  expect(() => authorize(taken, { kind: 'human', id: 'other-tab' }, [], true, 1)).toThrow()
})
