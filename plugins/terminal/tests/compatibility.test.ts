import { expect, test } from 'bun:test'
import { semver } from 'bun'
import manifest from '../bakin-plugin.json'
import pkg from '../package.json'

test('Terminal requires the Bakin release with declared entity links (rc.50; it also has rc.45\'s full screen hook) and accepts later releases', () => {
  const ranges = [manifest.bakin, pkg.peerDependencies['@makinbakin/sdk']]
  for (const range of ranges) {
    for (const version of ['0.0.1-rc.50', '0.0.1-rc.100', '0.0.1', '0.0.2', '0.1.0', '1.0.0']) {
      expect(semver.satisfies(version, range), `${version} satisfies ${range}`).toBe(true)
    }
    // rc.49 and older have no entityHref, which the task and project links call.
    for (const version of ['0.0.1-rc.36', '0.0.1-rc.44', '0.0.1-rc.45', '0.0.1-rc.49']) {
      expect(semver.satisfies(version, range), `${version} does not satisfy ${range}`).toBe(false)
    }
  }
  expect(manifest.bakin).toBe(pkg.peerDependencies['@makinbakin/sdk'])
})

test('the manifest, package.json and the plugin definition carry one version', async () => {
  const { default: plugin } = await import('../index')
  const versions: string[] = [pkg.version, plugin.version]
  expect(versions).toEqual([manifest.version, manifest.version])
})
