#!/usr/bin/env bun
/**
 * Build prebuilt dist/ artifacts for every plugin under plugins/*.
 *
 * Mirrors Bakin's in-binary user-plugin builder
 * (packages/host/src/plugin-host/user-plugin-builder.ts) so the artifacts
 * we ship here drop straight into ~/.bakin/plugins/<id>/dist/ without
 * re-bundling on install/upgrade.
 *
 * Key invariant: the SERVER bundle inlines the SDK. The plugin's runtime
 * import path on a user's machine is `<bakin-binary>/<dynamic-import>/dist/index.js`
 * — Node's resolver can't find @makinbakin/sdk there because it lives in
 * a build-only scratch dir on the publisher's machine. Externalizing the
 * SDK server-side would produce a bundle that throws ResolveMessage on
 * activation. The CLIENT bundle DOES externalize the SDK because the
 * host shell's import map wires @makinbakin/sdk/* → /vendor/*.js in the
 * browser.
 *
 * Run with: bun run build
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const PLUGINS_ROOT = join(REPO_ROOT, 'plugins')
// SDK source for server bundles. BAKIN_SDK_DIR (an assembled package dir —
// `bun run scripts/publish-sdk.ts --dry-run --package-dir <dir>` in a Bakin
// checkout) lets CI and local dev build against an UNPUBLISHED SDK; the
// .build-sdk npm pin is the fallback and only works until plugins start
// using SDK surface newer than the last npm publish.
const BUILD_SDK_ROOT = process.env.BAKIN_SDK_DIR
  ? resolve(process.env.BAKIN_SDK_DIR)
  : join(REPO_ROOT, '.build-sdk', 'node_modules', '@makinbakin', 'sdk')

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
]

/**
 * Map @makinbakin/sdk[/subpath] specifiers to the real npm package
 * installed under .build-sdk/. Used by server builds so the SDK gets
 * bundled into dist/index.js. The mapping mirrors the package's
 * exports field — keep it in sync if the SDK adds new sub-paths.
 */
const SDK_ENTRYPOINTS: Record<string, string> = {
  '@makinbakin/sdk': join(BUILD_SDK_ROOT, 'index.js'),
  '@makinbakin/sdk/ui': join(BUILD_SDK_ROOT, 'ui', 'index.js'),
  '@makinbakin/sdk/hooks': join(BUILD_SDK_ROOT, 'hooks', 'index.js'),
  '@makinbakin/sdk/components': join(BUILD_SDK_ROOT, 'components', 'index.js'),
  '@makinbakin/sdk/slots': join(BUILD_SDK_ROOT, 'slots', 'index.js'),
  '@makinbakin/sdk/types': join(BUILD_SDK_ROOT, 'types', 'index.js'),
  '@makinbakin/sdk/utils': join(BUILD_SDK_ROOT, 'utils', 'index.js'),
  '@makinbakin/sdk/metadata': join(BUILD_SDK_ROOT, 'metadata', 'index.js'),
  '@makinbakin/sdk/routing': join(BUILD_SDK_ROOT, 'routing', 'index.js'),
}

const sdkResolverPlugin = {
  name: 'makinbakin-sdk-resolver',
  setup(build: { onResolve: (filter: { filter: RegExp }, callback: (args: { path: string }) => { path: string } | undefined) => void }) {
    build.onResolve({ filter: /^@makinbakin\/sdk(\/.*)?$/ }, (args) => {
      const target = SDK_ENTRYPOINTS[args.path]
      if (!target) return
      return { path: target }
    })
  },
}

function assertBuildSdkPresent(): void {
  if (!existsSync(join(BUILD_SDK_ROOT, 'package.json'))) {
    throw new Error(
      `No SDK at ${BUILD_SDK_ROOT}. Either set BAKIN_SDK_DIR to an assembled\n` +
      `SDK package dir (in a Bakin checkout:\n` +
      `  bun run scripts/publish-sdk.ts --dry-run --version 0.0.0-local --package-dir <dir> --keep-package-dir\n` +
      `) or install the npm fallback: (cd .build-sdk && bun install).`,
    )
  }
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
    const result = await Bun.build({
      entrypoints: [serverEntry],
      outdir: distDir,
      target: 'bun',
      format: 'esm',
      naming: 'index.[ext]',
      external: SERVER_EXTERNAL,
      plugins: [sdkResolverPlugin],
    })
    if (!result.success) {
      throw new Error(`server build failed for ${name}:\n${result.logs.join('\n')}`)
    }
  }

  if (hasClient) {
    const result = await Bun.build({
      entrypoints: [clientEntry],
      outdir: distDir,
      target: 'browser',
      format: 'esm',
      naming: 'client.[ext]',
      external: CLIENT_EXTERNAL,
    })
    if (!result.success) {
      throw new Error(`client build failed for ${name}:\n${result.logs.join('\n')}`)
    }
  }
}

async function main(): Promise<void> {
  if (!existsSync(PLUGINS_ROOT)) {
    console.error(`plugins/ not found at ${PLUGINS_ROOT}`)
    process.exit(1)
  }
  assertBuildSdkPresent()

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
