#!/usr/bin/env bun
/**
 * Build prebuilt dist/ artifacts for every plugin under plugins/*.
 *
 * Mirrors the externals + naming used by Bakin's in-binary user-plugin
 * builder (packages/host/src/plugin-host/user-plugin-builder.ts) so the
 * artifacts we ship here drop straight into ~/.bakin/plugins/<id>/dist/
 * without re-bundling on install/upgrade.
 *
 * Run with: bun run build
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PLUGINS_ROOT = join(REPO_ROOT, 'plugins')

const CLIENT_EXTERNAL = [
  'react', 'react-dom', 'react-dom/client',
  'react/jsx-runtime', 'react/jsx-dev-runtime',
  '@tanstack/react-router',
  '@makinbakin/sdk', '@makinbakin/sdk/ui', '@makinbakin/sdk/hooks',
  '@makinbakin/sdk/components', '@makinbakin/sdk/slots',
  '@makinbakin/sdk/types', '@makinbakin/sdk/utils',
  '@makinbakin/sdk/metadata', '@makinbakin/sdk/routing',
]

const SERVER_EXTERNAL = [
  'react', 'react-dom', 'react-dom/client',
  'react/jsx-runtime', 'react/jsx-dev-runtime',
  '@tanstack/react-router',
  '@makinbakin/sdk', '@makinbakin/sdk/ui', '@makinbakin/sdk/hooks',
  '@makinbakin/sdk/components', '@makinbakin/sdk/slots',
  '@makinbakin/sdk/types', '@makinbakin/sdk/utils',
  '@makinbakin/sdk/metadata', '@makinbakin/sdk/routing',
]

interface RunResult {
  exitCode: number
  stderr: string
  stdout: string
}

function runSubprocess(cmd: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 0, stderr, stdout })
    })
  })
}

async function buildPlugin(pluginDir: string): Promise<void> {
  const name = pluginDir.split('/').pop()
  const serverEntry = join(pluginDir, 'index.ts')
  const clientEntry = join(pluginDir, 'client.tsx')
  const distDir = join(pluginDir, 'dist')
  const hasServer = existsSync(serverEntry)
  const hasClient = existsSync(clientEntry)
  if (!hasServer && !hasClient) {
    console.log(`[skip] ${name} — no index.ts or client.tsx`)
    return
  }

  console.log(`[build] ${name}`)

  if (hasServer) {
    const result = await runSubprocess('bun', [
      'build', serverEntry,
      '--outdir', distDir,
      '--target', 'bun',
      '--format', 'esm',
      '--entry-naming', 'index.[ext]',
      ...SERVER_EXTERNAL.flatMap((e) => ['--external', e]),
    ], pluginDir)
    if (result.exitCode !== 0) {
      throw new Error(`server build failed for ${name}:\n${result.stderr}`)
    }
  }

  if (hasClient) {
    const result = await runSubprocess('bun', [
      'build', clientEntry,
      '--outdir', distDir,
      '--target', 'browser',
      '--format', 'esm',
      '--entry-naming', 'client.[ext]',
      ...CLIENT_EXTERNAL.flatMap((e) => ['--external', e]),
    ], pluginDir)
    if (result.exitCode !== 0) {
      throw new Error(`client build failed for ${name}:\n${result.stderr}`)
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(PLUGINS_ROOT)) {
    console.error(`plugins/ not found at ${PLUGINS_ROOT}`)
    process.exit(1)
  }
  const entries = readdirSync(PLUGINS_ROOT)
  const pluginDirs = entries
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .map((name) => join(PLUGINS_ROOT, name))
    .filter((dir) => statSync(dir).isDirectory())
    .filter((dir) => existsSync(join(dir, 'bakin-plugin.json')))

  if (pluginDirs.length === 0) {
    console.log('no plugins found')
    return
  }

  for (const dir of pluginDirs) {
    await buildPlugin(dir)
  }
  console.log(`built ${pluginDirs.length} plugin(s)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
