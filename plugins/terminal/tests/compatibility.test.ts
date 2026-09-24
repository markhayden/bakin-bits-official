import { expect, test } from 'bun:test'
import { semver } from 'bun'
import manifest from '../bakin-plugin.json'
import pkg from '../package.json'

test('Terminal accepts the current published host and SDK and later releases', () => {
  const ranges = [manifest.bakin, pkg.peerDependencies['@makinbakin/sdk']]
  for (const range of ranges) {
    for (const version of ['0.0.1-rc.35', '0.0.1-rc.36', '0.0.1-rc.100', '0.0.1', '0.0.2', '0.1.0', '1.0.0']) {
      expect(semver.satisfies(version, range), `${version} satisfies ${range}`).toBe(true)
    }
    expect(semver.satisfies('0.0.1-rc.34', range)).toBe(false)
  }
  expect(manifest.bakin).toBe(pkg.peerDependencies['@makinbakin/sdk'])
})
