import { expect, test } from 'bun:test'
import { semver } from 'bun'
import manifest from '../bakin-plugin.json'
import pkg from '../package.json'

test('Terminal requires the Bakin release with the host-provided zod contract (rc.42) and accepts later releases', () => {
  const ranges = [manifest.bakin, pkg.peerDependencies['@makinbakin/sdk']]
  for (const range of ranges) {
    for (const version of ['0.0.1-rc.42', '0.0.1-rc.100', '0.0.1', '0.0.2', '0.1.0', '1.0.0']) {
      expect(semver.satisfies(version, range), `${version} satisfies ${range}`).toBe(true)
    }
    // Older hosts serve the pre-#948 externals contract (no host-provided zod) this build no longer matches.
    for (const version of ['0.0.1-rc.36', '0.0.1-rc.39', '0.0.1-rc.40', '0.0.1-rc.41']) {
      expect(semver.satisfies(version, range), `${version} does not satisfy ${range}`).toBe(false)
    }
  }
  expect(manifest.bakin).toBe(pkg.peerDependencies['@makinbakin/sdk'])
})

test('the manifest, package.json and the plugin definition carry one version', async () => {
  const { default: plugin } = await import('../index')
  expect(pkg.version).toBe(manifest.version)
  expect(plugin.version).toBe(manifest.version)
})
