import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const agentsRoot = join(import.meta.dir);
const textFilePattern = /\.(json|md|txt|yaml|yml)$/i;
const disallowedPersonalPatterns = [
  /~\/go\/src\/github\.com\/markhayden/i,
  /roscoe/i,
  /\bbasil\b/i,
  /\bnemo\b/i,
  /\bscout\b/i,
  /\bzen\b/i,
  /\bbetterfit\b/i,
  /profile="user"/i,
  /Chrome "Work" profile/i,
  /Work profile/i,
  /current year is \*\*2026\*\*/i,
  // Hardcoded install-location / machine paths (Bakin's default install is the binary,
  // not Homebrew — and global node_modules paths are non-portable).
  /\/opt\/homebrew/i,
  /\/usr\/local\//i,
  /lib\/node_modules/i,
  // Hardcoded model ids go stale fast — agents inherit the Bakin/runtime default.
  /anthropic\/claude-opus-4-6/i,
  /openai-codex\/gpt-/i,
  /eleven_monolingual/i,
];

type AgentManifest = {
  id?: string;
  kind?: string;
  name?: string;
  version?: string;
  description?: string;
  secrets?: Array<{
    name?: string;
    description?: string;
    required?: boolean;
  }>;
  agent?: {
    identity?: { name?: string; emoji?: string };
    defaultModel?: string;
    allowedTools?: string[];
    allowedSkills?: string[];
  };
  install?: Record<string, unknown>;
  contributions?: {
    workspaceFiles?: string[];
    skills?: string[];
    workflows?: string[];
    workflowSkills?: string[];
    lessons?: string[];
    assets?: string[];
  };
};

function listAgentPackageDirs(): string[] {
  return readdirSync(agentsRoot)
    .filter(
      (entry) =>
        !entry.startsWith("_") &&
        !entry.endsWith(".test.ts") &&
        entry !== "README.md",
    )
    .filter((entry) => statSync(join(agentsRoot, entry)).isDirectory())
    .filter((entry) => existsSync(join(agentsRoot, entry, "bakin-package.json")))
    .sort();
}

function readManifest(agentId: string): AgentManifest {
  return JSON.parse(
    readFileSync(join(agentsRoot, agentId, "bakin-package.json"), "utf-8"),
  );
}

function expectPath(agentId: string, relativePath: string): void {
  expect(
    existsSync(join(agentsRoot, agentId, relativePath)),
    `${agentId}: missing ${relativePath}`,
  ).toBe(true);
}

function listTextFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return listTextFiles(fullPath);
    return textFilePattern.test(entry) ? [fullPath] : [];
  });
}

describe("agent package contracts", () => {
  const agentIds = listAgentPackageDirs();

  it("contains at least one official agent package", () => {
    expect(agentIds).toContain("patch");
  });

  for (const agentId of agentIds) {
    it(`${agentId} has a valid package shape`, () => {
      const manifest = readManifest(agentId);

      expect(manifest.id).toBe(agentId);
      expect(manifest.kind).toBe("agent");
      expect(manifest.name).toBeTruthy();
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
      expect(manifest.agent?.identity?.name).toBeTruthy();
      expect(manifest.install).toBeTruthy();
      expect(manifest.contributions).toBeTruthy();

      for (const secret of manifest.secrets ?? []) {
        expect(secret.name).toMatch(/^[A-Z_][A-Z0-9_]*$/);
        expect(secret.description).toBeTruthy();
        expect(typeof secret.required).toBe("boolean");
      }

      for (const filePath of manifest.contributions?.workspaceFiles ?? []) {
        expectPath(agentId, filePath);
      }
      for (const skillPath of manifest.contributions?.skills ?? []) {
        expectPath(agentId, join(skillPath, "SKILL.md"));
      }
      for (const workflowPath of manifest.contributions?.workflows ?? []) {
        expectPath(agentId, workflowPath);
      }
      for (const workflowSkillPath of manifest.contributions?.workflowSkills ??
        []) {
        expectPath(agentId, workflowSkillPath);
      }
      for (const lessonPath of manifest.contributions?.lessons ?? []) {
        expectPath(agentId, lessonPath);
      }
      for (const assetPath of manifest.contributions?.assets ?? []) {
        expectPath(agentId, assetPath);
      }
    });
  }

  it("patch exposes the expected developer-agent controls", () => {
    const manifest = readManifest("patch");

    expect(manifest.agent?.allowedTools ?? []).toEqual([]);
    expect(manifest.agent?.allowedSkills ?? []).toContain("git-isolation");
    expect(manifest.contributions?.lessons ?? []).toContain(
      "lessons/dev-discipline.md",
    );
    expect(manifest.contributions?.skills ?? []).toContain(
      "skills/git-isolation",
    );
  });

  // Agents whose JOB requires a capability the runtime default lacks may pin
  // a model. enrich (H'enrich): needs image input; the current default is
  // catalog-declared text-only, so inheriting would make Bakin's capability
  // probe skip every image — vision enrichment would silently stop working.
  const MODEL_PIN_EXCEPTIONS = new Set(["enrich"]);

  it("no agent hardcodes a model (inherits the Bakin/runtime default)", () => {
    for (const agentId of agentIds) {
      if (MODEL_PIN_EXCEPTIONS.has(agentId)) continue;
      const manifest = readManifest(agentId);
      expect(
        manifest.agent?.defaultModel,
        `${agentId} sets agent.defaultModel — models go stale; inherit the runtime default`,
      ).toBeUndefined();
    }
  });

  it("model-pin exceptions still pin a REAL model string (the exception is not a free pass)", () => {
    for (const agentId of MODEL_PIN_EXCEPTIONS) {
      const manifest = readManifest(agentId);
      expect(
        typeof manifest.agent?.defaultModel === "string" && manifest.agent.defaultModel.length > 0,
        `${agentId} is in MODEL_PIN_EXCEPTIONS but pins no model — remove the exception`,
      ).toBe(true);
    }
  });

  it("declares allowedTools explicitly", () => {
    for (const agentId of agentIds) {
      const manifest = readManifest(agentId);
      expect(
        Array.isArray(manifest.agent?.allowedTools),
        `${agentId} must declare agent.allowedTools as an array`,
      ).toBe(true);
    }
  });

  it("keeps always-loaded workspace files within a context budget", () => {
    const wordCount = (s: string): number =>
      s.trim().split(/\s+/).filter(Boolean).length;
    const budgets: Record<string, number> = {
      "workspace/SOUL.md": 250,
      "workspace/AGENTS.md": 350,
    };
    for (const agentId of agentIds) {
      for (const [relativePath, max] of Object.entries(budgets)) {
        const fullPath = join(agentsRoot, agentId, relativePath);
        if (!existsSync(fullPath)) continue;
        const words = wordCount(readFileSync(fullPath, "utf-8"));
        expect(
          words,
          `${agentId}/${relativePath} is ${words} words (budget ${max}) — these load every session, push depth to lessons/skills`,
        ).toBeLessThanOrEqual(max);
      }
    }
  });

  it("install.enableLessons matches lessons marked defaultEnabled", () => {
    for (const agentId of agentIds) {
      const manifest = readManifest(agentId);
      const lessonPaths = manifest.contributions?.lessons ?? [];
      const defaultEnabled: string[] = [];
      for (const lessonPath of lessonPaths) {
        const slug = lessonPath.replace(/^.*\//, "").replace(/\.md$/i, "");
        const content = readFileSync(
          join(agentsRoot, agentId, lessonPath),
          "utf-8",
        );
        const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
        const isEnabled = frontmatter
          ? /(^|\n)\s*defaultEnabled:\s*true\b/i.test(frontmatter[1])
          : false;
        if (isEnabled) defaultEnabled.push(slug);
      }
      const enableLessons =
        ((manifest.install as Record<string, unknown> | undefined)
          ?.enableLessons as string[] | undefined) ?? [];
      expect(
        [...enableLessons].sort(),
        `${agentId}: install.enableLessons must equal the lessons whose frontmatter sets defaultEnabled: true ` +
          `(enableLessons=${JSON.stringify([...enableLessons].sort())}, defaultEnabled=${JSON.stringify([...defaultEnabled].sort())})`,
      ).toEqual([...defaultEnabled].sort());
    }
  });

  it("rolo declares required runtime secrets without values", () => {
    const manifest = readManifest("rolo");

    expect(manifest.secrets).toEqual([
      {
        name: "RUNWAY_API_KEY",
        description: "Runway API key used for video generation workflows.",
        required: true,
      },
      {
        name: "ELEVENLABS_API_KEY",
        description:
          "ElevenLabs API key used for sound effects, music, and voice generation.",
        required: true,
      },
    ]);
  });

  it("agent package text does not include local machine assumptions", () => {
    for (const agentId of agentIds) {
      for (const filePath of listTextFiles(join(agentsRoot, agentId))) {
        const content = readFileSync(filePath, "utf-8");
        for (const pattern of disallowedPersonalPatterns) {
          expect(content, `${filePath} includes ${pattern}`).not.toMatch(
            pattern,
          );
        }
      }
    }
  });
});
