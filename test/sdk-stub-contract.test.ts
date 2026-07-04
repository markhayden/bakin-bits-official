import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// Guards against test-sdk/ drifting behind the real @makinbakin/sdk surface.
// Plugin tests resolve @makinbakin/sdk to the local test-sdk/ stub via a
// `file:` dependency; when a plugin starts importing an SDK export the stub
// doesn't define, every test touching that module dies with an opaque
// "SyntaxError: Export named 'X' not found". This test turns that into a
// named failure at the source: scan every runtime import from
// @makinbakin/sdk(/subpath) across plugins/, then assert the stub module
// actually exports each imported name.

const repoRoot = join(import.meta.dir, "..");
const pluginsRoot = join(repoRoot, "plugins");

const SKIP_DIRS = new Set(["node_modules", "dist", ".whiskit"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP_DIRS.has(entry)) return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

type ImportUse = { file: string; module: string; names: string[] };

// Matches `import <clause> from "@makinbakin/sdk[/sub]"` (line-anchored so
// prose in comments can't match), including multiline brace clauses. Type-only
// imports are erased at runtime and don't need a stub export, so
// `import type ...` statements and inline `type X` specifiers are skipped.
const IMPORT_RE =
  /^import\s+(type\s+)?([\w$*,\s]*(?:\{[^}]*\})?[\w$*,\s]*)\s*from\s*["']@makinbakin\/sdk(\/[a-z-]+)?["']/gm;

function parseImports(file: string): ImportUse[] {
  const content = readFileSync(file, "utf-8");
  const uses: ImportUse[] = [];
  for (const match of content.matchAll(IMPORT_RE)) {
    const [, typeOnly, clause, subpath] = match;
    if (typeOnly) continue;
    const module = subpath ? subpath.slice(1) : "index";
    const names: string[] = [];
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const raw of braced[1].split(",")) {
        const spec = raw.trim();
        if (!spec || spec.startsWith("type ")) continue;
        names.push(spec.split(/\s+as\s+/)[0].trim());
      }
    }
    const outsideBraces = clause.replace(/\{[\s\S]*?\}/, "").trim();
    if (/^\*\s+as\s+/.test(outsideBraces)) {
      // Namespace import — can't know which members are used statically;
      // module existence is checked by the dynamic import below.
    } else if (outsideBraces.replace(/^,|,$/g, "").trim()) {
      names.push("default");
    }
    uses.push({ file, module, names });
  }
  return uses;
}

describe("test-sdk stub contract", () => {
  const uses = sourceFiles(pluginsRoot).flatMap(parseImports);

  it("finds SDK imports to check (sanity)", () => {
    expect(uses.length).toBeGreaterThan(0);
  });

  const byModule = new Map<string, ImportUse[]>();
  for (const use of uses) {
    byModule.set(use.module, [...(byModule.get(use.module) ?? []), use]);
  }

  for (const [module, moduleUses] of byModule) {
    it(`test-sdk/${module}.js exports everything plugins import from @makinbakin/sdk${module === "index" ? "" : `/${module}`}`, async () => {
      const stub = await import(join(repoRoot, "test-sdk", `${module}.js`));
      const exported = new Set(Object.keys(stub));
      for (const use of moduleUses) {
        for (const name of use.names) {
          expect(
            exported.has(name),
            `${use.file.replace(repoRoot + "/", "")} imports '${name}' from @makinbakin/sdk/${module}, but test-sdk/${module}.js does not export it — add the stub export (and run bun install)`,
          ).toBe(true);
        }
      }
    });
  }
});
