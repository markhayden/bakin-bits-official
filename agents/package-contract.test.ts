import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const agentsRoot = join(import.meta.dir);
const textFilePattern = /\.(json|md|txt|yaml|yml)$/i;
const disallowedPersonalPatterns = [
  /~\/go\/src\/github\.com\/markhayden/i,
  /roscoe/i,
  /profile="user"/i,
  /Chrome "Work" profile/i,
  /Work profile/i,
  /current year is \*\*2026\*\*/i,
  /anthropic\/claude-opus-4-6/i,
];

type AgentManifest = {
  id?: string;
  kind?: string;
  name?: string;
  version?: string;
  description?: string;
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
    expect(manifest.agent?.defaultModel).toBe("openai-codex/gpt-5.5");
    expect(manifest.agent?.allowedSkills ?? []).toContain("git-isolation");
    expect(manifest.contributions?.lessons ?? []).toContain(
      "lessons/dev-discipline.md",
    );
    expect(manifest.contributions?.skills ?? []).toContain(
      "skills/git-isolation",
    );
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
