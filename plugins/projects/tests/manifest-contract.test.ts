/**
 * The manifest advertises only what the plugin registers: every CLI command
 * dispatches to an exec tool that exists, and every declared exec tool is
 * registered (a removed tool must take its command with it).
 */
import { expect, it } from 'bun:test'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import manifest from '../bakin-plugin.json'
import projectsPlugin from '../index'
import { activatePlugin } from '../test-helpers'

it('every CLI dispatch and declared exec tool is registered', async () => {
  const dir = join(tmpdir(), `bakin-test-projects-manifest-${Date.now()}`)
  mkdirSync(join(dir, 'projects'), { recursive: true })
  const plugin = await activatePlugin(projectsPlugin, dir)
  const registered = new Set(plugin.execTools.map((tool: { name: string }) => tool.name))
  const dispatched = manifest.contributes.cliCommands
    .map(command => (command as { dispatch?: { type: string; name: string } }).dispatch)
    .filter(dispatch => dispatch?.type === 'execTool')
    .map(dispatch => dispatch!.name)
  for (const name of dispatched) expect(registered.has(name), `CLI dispatches to unregistered ${name}`).toBe(true)
  for (const tool of manifest.contributes.execTools) expect(registered.has(tool.name), `manifest declares unregistered ${tool.name}`).toBe(true)
})
