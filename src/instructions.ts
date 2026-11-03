// The instruction files Narre reads, as coding agents do: AGENTS.md in $NARRE_HOME (for every
// project), then in each folder from the repository's root down to the working directory, so
// the nearest one comes last. Without a repository, only the working directory's. Narre
// doesn't follow them, but counts them in its context and says it uses them.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tokens } from "./fake.ts";
import { narreHome, type StoredTurn } from "./store.ts";

export const instructionsName = "AGENTS.md";

export type Instructions = { file: string; text: string };

/** The repository's root: the nearest folder up from `cwd` with a .git in it. */
function repositoryRoot(cwd: string): string | undefined {
  for (let folder = cwd; ; folder = dirname(folder)) {
    if (existsSync(join(folder, ".git"))) { return folder; }
    if (dirname(folder) === folder) { return undefined; }
  }
}

export function loadInstructions(cwd: string, env: NodeJS.ProcessEnv = process.env): Instructions[] {
  const root = repositoryRoot(cwd) ?? cwd;
  const parts = relative(root, cwd).split(sep).filter(Boolean);
  const folders = [narreHome(env), root, ...parts.map((_, i) => join(root, ...parts.slice(0, i + 1)))];
  return folders.map((folder) => join(folder, instructionsName)).filter((file) => existsSync(file))
    .map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/** What the instructions add to every turn's context. */
export function instructionTokens(instructions: readonly Instructions[]): number {
  return instructions.reduce((sum, { text }) => sum + tokens(text), 0);
}

/** What the instructions and earlier turns add to each new one's context. */
export function contextTokens(turns: readonly StoredTurn[], instructions: readonly Instructions[]): number {
  return instructionTokens(instructions) + turns.reduce((sum, turn) => sum + turn.usage.input + turn.usage.output, 0);
}
