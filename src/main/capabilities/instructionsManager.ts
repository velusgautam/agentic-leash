import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homeDir, leashDir } from "../../shared/constants";
import type { AgentId, CoreInstructionItem } from "../../shared/types";

export interface InstructionTarget {
  agentId: AgentId | "all";
  scope: "global" | "project";
  path: string;
}

export function getGlobalInstructionTargets(home = homeDir()): InstructionTarget[] {
  return [
    { agentId: "claude-code", scope: "global", path: join(home, ".claude/CLAUDE.md") },
    { agentId: "antigravity", scope: "global", path: join(home, ".gemini/config/AGENTS.md") },
    { agentId: "gemini", scope: "global", path: join(home, ".gemini/GEMINI.md") },
    { agentId: "all", scope: "global", path: join(home, ".agents/AGENTS.md") },
  ];
}

export function getProjectInstructionTargets(projectPath: string): InstructionTarget[] {
  return [
    { agentId: "claude-code", scope: "project", path: join(projectPath, "CLAUDE.md") },
    { agentId: "antigravity", scope: "project", path: join(projectPath, "AGENTS.md") },
    { agentId: "gemini", scope: "project", path: join(projectPath, "GEMINI.md") },
  ];
}

function readInstructionItem(target: InstructionTarget): CoreInstructionItem {
  let isSymlink = false;
  let symlinkTarget: string | undefined;
  let content = "";

  try {
    if (existsSync(target.path) || (lstatSync(target.path).isSymbolicLink())) {
      const stat = lstatSync(target.path);
      if (stat.isSymbolicLink()) {
        isSymlink = true;
        symlinkTarget = readlinkSync(target.path);
      }
      if (existsSync(target.path)) {
        content = readFileSync(target.path, "utf8");
      }
    }
  } catch {
    /* file may not exist or error reading */
  }

  return {
    agentId: target.agentId,
    scope: target.scope,
    path: target.path,
    content,
    isSymlink,
    target: symlinkTarget,
  };
}

export function listCoreInstructions(projectPath?: string, home = homeDir()): CoreInstructionItem[] {
  const globalTargets = getGlobalInstructionTargets(home);
  const items = globalTargets.map(readInstructionItem);

  if (projectPath && existsSync(projectPath)) {
    const projectTargets = getProjectInstructionTargets(projectPath);
    for (const t of projectTargets) {
      items.push(readInstructionItem(t));
    }
  }

  return items;
}

export function saveCoreInstruction(item: CoreInstructionItem): void {
  mkdirSync(dirname(item.path), { recursive: true });
  writeFileSync(item.path, item.content, "utf8");
}

function instructionsStorageDir(home: string): string {
  return join(leashDir(home), "instructions");
}

export function unifyCoreInstructions(scope: "global" | "project", projectPath?: string, home = homeDir()): void {
  const storageDir = instructionsStorageDir(home);
  mkdirSync(storageDir, { recursive: true });

  let canonicalPath: string;
  let targets: InstructionTarget[];

  if (scope === "global") {
    canonicalPath = join(storageDir, "global-AGENTS.md");
    targets = getGlobalInstructionTargets(home);
  } else {
    if (!projectPath) return;
    const safeProj = basename(projectPath).replace(/[^a-zA-Z0-9_\-]/g, "_");
    canonicalPath = join(storageDir, `project-${safeProj}-AGENTS.md`);
    targets = getProjectInstructionTargets(projectPath);
  }

  // If canonical file does not exist, pick existing content from targets
  if (!existsSync(canonicalPath)) {
    let contentToSeed = "";
    for (const t of targets) {
      if (existsSync(t.path)) {
        try {
          const c = readFileSync(t.path, "utf8");
          if (c.trim().length > 0) {
            contentToSeed = c;
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (!contentToSeed) {
      contentToSeed = `# Project Instructions\n\nShared instructions for AI coding agents.\n`;
    }

    writeFileSync(canonicalPath, contentToSeed, "utf8");
  }

  // Now symlink each target to canonicalPath
  for (const t of targets) {
    mkdirSync(dirname(t.path), { recursive: true });

    try {
      const stat = lstatSync(t.path);
      if (stat.isSymbolicLink()) {
        const currentLink = resolve(dirname(t.path), readlinkSync(t.path));
        if (currentLink === canonicalPath) {
          continue; // Already correctly pointing
        }
        unlinkSync(t.path);
      } else {
        rmSync(t.path, { recursive: true, force: true });
      }
    } catch {
      /* ignore if not exists */
    }

    try {
      symlinkSync(canonicalPath, t.path, "file");
    } catch {
      /* ignore */
    }
  }
}
