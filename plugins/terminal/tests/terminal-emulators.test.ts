import { expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Spec D13: every emulator the plugin builds (server replica, viewers, the
// checkpoint verifier) is built with the shared options and the profile, so
// they parse alike and a join restores exactly what the replica holds.
it('every emulator in the plugin is built with TERMINAL_OPTIONS and the shared profile', () => {
  const root = join(import.meta.dir, '..')
  const files = ['components', 'lib'].flatMap(dir => readdirSync(join(root, dir)).filter(name => /\.tsx?$/.test(name)).map(name => join(root, dir, name)))
  const builders = files.filter(file => /new (?:headless\.)?Terminal\(/.test(readFileSync(file, 'utf8')))
  expect(builders.length).toBeGreaterThan(0)
  for (const file of builders) {
    const source = readFileSync(file, 'utf8')
    for (const call of source.match(/new (?:headless\.)?Terminal\([^)]*\)/g) ?? []) expect(call, file).toContain('...TERMINAL_OPTIONS')
    expect(source, file).toContain('applyTerminalProfile(')
  }
})
