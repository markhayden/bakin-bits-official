import { expect, test } from 'bun:test'
import { semver } from 'bun'
import manifest from '../bakin-plugin.json'
import pkg from '../package.json'

test('Projects requires the Bakin navigation-indicator release and accepts later releases', () => {
  const ranges = [manifest.bakin, pkg.peerDependencies['@makinbakin/sdk']]
  for (const range of ranges) {
    for (const version of ['0.0.1-rc.39', '0.0.1-rc.100', '0.0.1', '0.0.2', '0.1.0', '1.0.0']) {
      expect(semver.satisfies(version, range), `${version} satisfies ${range}`).toBe(true)
    }
    for (const version of ['0.0.1-rc.34', '0.0.1-rc.35', '0.0.1-rc.36', '0.0.1-rc.37', '0.0.1-rc.38']) {
      expect(semver.satisfies(version, range), `${version} does not satisfy ${range}`).toBe(false)
    }
  }
  expect(manifest.bakin).toBe(pkg.peerDependencies['@makinbakin/sdk'])
})
