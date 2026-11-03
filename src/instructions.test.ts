import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { instructionTokens, loadInstructions } from "./instructions.ts";

/** narre.ts next to this file in src/, narre.js in dist/. */
const narre = join(import.meta.dirname, `narre${import.meta.filename.slice(-3)}`);

test("AGENTS.md from Narre's home, then the repository's root down to the working directory", async (t) => {
  // The real path: on macOS the temporary folder is behind a symlink (/var is /private/var), and
  // Narre's working directory is always the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "narre-instructions-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repository = join(root, "repository");
  const cwd = join(repository, "packages", "app");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, "AGENTS.md"), "Be brief.\n");
  writeFileSync(join(repository, "AGENTS.md"), "Run npm test before committing.\n");
  writeFileSync(join(cwd, "AGENTS.md"), "This package is the app.\n");
  // Above the repository, so not read.
  writeFileSync(join(root, "AGENTS.md"), "Not this one.\n");
  const env = { ...process.env, NARRE_HOME: home, NARRE_SPEED: "0" };

  const instructions = loadInstructions(cwd, env);
  assert.deepEqual(instructions.map(({ file }) => file), [join(home, "AGENTS.md"), join(repository, "AGENTS.md"), join(cwd, "AGENTS.md")]);
  assert.ok(instructionTokens(instructions) > 0);

  const run = async (folder: string) => JSON.parse((await promisify(execFile)(process.execPath, [narre, "-p", "hello", "--output-format", "json"], { cwd: folder, env })).stdout) as
    { instructions: string[]; usage: { totals: { cacheRead: number } } };
  const withInstructions = await run(cwd);
  assert.deepEqual(withInstructions.instructions, instructions.map(({ file }) => file));
  rmSync(join(home, "AGENTS.md"));
  rmSync(join(repository, "AGENTS.md"));
  rmSync(join(cwd, "AGENTS.md"));
  const without = await run(join(repository, "packages"));
  assert.deepEqual(without.instructions, []);
  // The instructions are counted in the context, read from the cache.
  assert.ok(withInstructions.usage.totals.cacheRead > without.usage.totals.cacheRead);
});
