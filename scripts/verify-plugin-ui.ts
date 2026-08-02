#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(import.meta.dir, '..')
const REPORT_ROOT = join(REPO_ROOT, 'test-results/plugin-ui-conformance')

export type OfficialBitsPluginUiEnrollment =
  | { id: string; root: string; status: 'conformant'; migrationTask: string }
  | { id: string; root: string; status: 'migration-pending'; migrationTask: string }
  | { id: string; root: string; status: 'server-only'; reason: string }

/** Every official package is named before any migration can silently skip it. */
export const OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT: readonly OfficialBitsPluginUiEnrollment[] = [
  { id: '_template', root: 'plugins/_template', status: 'conformant', migrationTask: 'T42b' },
  { id: 'messaging', root: 'plugins/messaging', status: 'migration-pending', migrationTask: 'T67-T68' },
  { id: 'projects', root: 'plugins/projects', status: 'migration-pending', migrationTask: 'T69-T70' },
] as const

function manifestId(root: string, packageRoot: string): string | undefined {
  const path = join(root, packageRoot, 'bakin-plugin.json')
  if (!existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, 'utf8')) as { id?: string }).id
}

/** Refuse omissions, stale records, fake server-only labels, and config-less graduates. */
export function validateOfficialBitsPluginUiEnrollment(
  root = REPO_ROOT,
  enrollment: readonly OfficialBitsPluginUiEnrollment[] = OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT,
): string[] {
  const errors: string[] = []
  const pluginsRoot = join(root, 'plugins')
  const discovered = existsSync(pluginsRoot)
    ? readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .filter((entry) => existsSync(join(pluginsRoot, entry.name, 'bakin-plugin.json')))
        .map((entry) => `plugins/${entry.name}`)
        .sort()
    : []
  const byRoot = new Map(enrollment.map((entry) => [entry.root, entry]))

  for (const packageRoot of discovered) {
    if (!byRoot.has(packageRoot)) errors.push(`${packageRoot} is missing from official plugin UI enrollment`)
  }
  for (const entry of enrollment) {
    const absoluteRoot = join(root, entry.root)
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      errors.push(`${entry.id} enrollment root does not exist: ${entry.root}`)
      continue
    }
    if (!discovered.includes(entry.root)) errors.push(`${entry.id} enrollment is stale: ${entry.root}`)
    const actualId = manifestId(root, entry.root)
    if (actualId !== entry.id) errors.push(`${entry.root} manifest id is ${actualId ?? '<missing>'}, expected ${entry.id}`)

    const hasClient = existsSync(join(absoluteRoot, 'client.tsx')) || existsSync(join(absoluteRoot, 'client.ts'))
    if (entry.status === 'server-only') {
      if (hasClient) errors.push(`${entry.id} is labeled server-only but has a browser client entrypoint`)
      continue
    }
    if (!hasClient) errors.push(`${entry.id} is ${entry.status} but has no browser client entrypoint`)
    if (entry.status === 'conformant') {
      if (!existsSync(join(absoluteRoot, 'bakin.ui-test.ts'))) {
        errors.push(`${entry.id} is conformant but has no bakin.ui-test.ts`)
      }
      const packageJsonPath = join(absoluteRoot, 'package.json')
      const packageJson = existsSync(packageJsonPath)
        ? JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> }
        : undefined
      if (packageJson?.scripts?.['test:ui'] !== 'bakin-plugin-test-ui') {
        errors.push(`${entry.id} is conformant but does not expose the canonical test:ui command`)
      }
    }
  }
  return errors.sort((left, right) => left.localeCompare(right))
}

function run(command: string, args: string[], cwd: string, env = process.env): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
}

function packSdk(sdkPackageDir: string, scratchRoot: string): string {
  const result = spawnSync('npm', [
    'pack',
    sdkPackageDir,
    '--pack-destination',
    scratchRoot,
    '--json',
  ], {
    cwd: scratchRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(scratchRoot, '.npm-cache') },
  })
  if (result.status !== 0) {
    throw new Error(`Could not pack the assembled SDK:\n${result.stdout}${result.stderr}`)
  }
  const records = JSON.parse(result.stdout) as Array<{ filename?: string }>
  const filename = records[0]?.filename
  if (!filename) throw new Error('npm pack did not report an SDK tarball filename')
  return join(scratchRoot, filename)
}

function runConformantPackage(entry: Extract<OfficialBitsPluginUiEnrollment, { status: 'conformant' }>, sdkTarball: string): void {
  const scratchRoot = mkdtempSync(join(tmpdir(), `bakin-bits-${entry.id}-ui-`))
  const consumerRoot = join(scratchRoot, 'plugin')
  try {
    cpSync(join(REPO_ROOT, entry.root), consumerRoot, {
      recursive: true,
      filter: (source) => !/(?:^|\/)(?:dist|node_modules|test-results)(?:\/|$)/.test(source),
    })
    const packageJsonPath = join(consumerRoot, 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    packageJson.devDependencies = {
      ...packageJson.devDependencies,
      '@makinbakin/sdk': sdkTarball,
    }
    writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const env = { ...process.env, TMPDIR: scratchRoot }
    run('bun', ['install'], consumerRoot, env)
    run('bun', ['run', 'typecheck'], consumerRoot, env)
    run('bun', ['test'], consumerRoot, env)
    run('bun', ['run', 'test:ui'], consumerRoot, env)

    const sourceReport = join(consumerRoot, 'test-results/bakin-ui')
    const destinationReport = join(REPORT_ROOT, entry.id)
    rmSync(destinationReport, { recursive: true, force: true })
    mkdirSync(REPORT_ROOT, { recursive: true })
    cpSync(sourceReport, destinationReport, { recursive: true })
    console.log(`✓ ${entry.id}: clean installed-package conformance passed`)
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const errors = validateOfficialBitsPluginUiEnrollment()
  if (errors.length > 0) {
    throw new Error(`Official Bits plugin UI enrollment is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  }

  const coverageOnly = process.argv.includes('--coverage-only')
  let sdkTarball = ''
  let packRoot = ''
  if (!coverageOnly) {
    const sdkPackageDir = process.env.BAKIN_SDK_PACKAGE_DIR
    if (!sdkPackageDir || !existsSync(join(sdkPackageDir, 'package.json'))) {
      throw new Error('BAKIN_SDK_PACKAGE_DIR must point to an assembled @makinbakin/sdk package directory')
    }
    packRoot = mkdtempSync(join(tmpdir(), 'bakin-bits-sdk-pack-'))
    sdkTarball = packSdk(resolve(sdkPackageDir), packRoot)
  }

  try {
    for (const entry of OFFICIAL_BITS_PLUGIN_UI_ENROLLMENT) {
      if (entry.status === 'conformant') {
        if (!coverageOnly) runConformantPackage(entry, sdkTarball)
        else console.log(`✓ ${entry.id}: conformant package enrolled`)
      } else if (entry.status === 'migration-pending') {
        console.log(`↷ ${entry.id}: enrolled; conformance becomes required with ${entry.migrationTask}`)
      } else {
        console.log(`— ${entry.id}: server-only — ${entry.reason}`)
      }
    }
  } finally {
    if (packRoot) rmSync(packRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
