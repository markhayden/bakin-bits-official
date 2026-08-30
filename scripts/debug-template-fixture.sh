#!/usr/bin/env bash
# TEMPORARY CI diagnostic for the _template fixture crash ("Q3 is not a function").
# Rebuilds the fixture bundle exactly like the harness and prints identity data.
set -euo pipefail
SDK_DIR="${BAKIN_SDK_PACKAGE_DIR:?}"
T="${RUNNER_TEMP:-/tmp}/debug-tpl"; rm -rf "$T"; cp -R plugins/_template "$T"; rm -rf "$T/node_modules" "$T/dist"
cd "$SDK_DIR" && rm -rf node_modules && TGZ="$(npm pack --pack-destination "$T" 2>/dev/null | tail -1)"
cd "$T"
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.devDependencies=p.devDependencies||{};p.devDependencies['@makinbakin/sdk']='file:./'+process.argv[1];fs.writeFileSync('package.json',JSON.stringify(p,null,2))" "$TGZ"
bun install 2>&1 | tail -1
cat > build-fixture.ts <<'TS'
const r = await Bun.build({ entrypoints: [`${process.cwd()}/tests/ui.fixture.tsx`], outdir: `${process.cwd()}/stage`, target: 'browser', format: 'esm', splitting: true, sourcemap: 'none', minify: false,
  naming: { entry: 'fixture.[ext]', chunk: 'chunks/[name]-[hash].[ext]', asset: 'assets/[name]-[hash].[ext]' }, define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'css', setup(b) { b.onResolve({ filter: /^@makinbakin\/sdk\/styles\.css$/ }, () => ({ path: 'sdk-styles', namespace: 'sdkcss' })); b.onLoad({ filter: /.*/, namespace: 'sdkcss' }, () => ({ contents: '', loader: 'css' })) } }] })
console.log('build success:', r.success, r.logs.map(String).join('\n'))
TS
bun run build-fixture.ts
echo "== stage"; ls -R stage | head -20
echo "== md5 + lines"; md5sum stage/fixture.js; wc -l stage/fixture.js
echo "== Q3 bindings"; grep -nE "\bQ3\b" stage/fixture.js | head -10
echo "== sdk tgz md5"; md5sum "$TGZ"; echo "== sdk ui/patterns md5"; (cd "$SDK_DIR" && md5sum ui/index.js patterns/index.js)
echo "== react"; node -p "require('./node_modules/react/package.json').version"
echo "== harness report (if any)"; ls -R /tmp/bakin-bits-_template-ui-* 2>/dev/null | head -20 || true
