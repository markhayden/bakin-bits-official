import { expect, it } from 'bun:test'
import manifest from '../package.json'

it('the browser and the server run the same xterm core release (spec D13: viewers and the replica parse alike)', () => {
  const deps = manifest.dependencies as Record<string, string>
  expect(deps['@xterm/xterm']).toMatch(/^\d+\.\d+\.\d+$/)
  expect(deps['@xterm/headless']).toBe(deps['@xterm/xterm'])
})
