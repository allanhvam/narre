import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { cost, defaultModel, findModel, models, reply } from "./fake.ts";

/** narre.ts next to this file in src/, narre.js in dist/. */
const narre = join(import.meta.dirname, `narre${import.meta.filename.slice(-3)}`);

const snu = findModel("snu-1.0")!;
const nar = findModel("nar-1.0")!;
const dum = findModel("dum-1.0")!;

test("three models, by intelligence, with nar-1.0 the default", () => {
  assert.deepEqual(models.map((model) => model.id), ["snu-1.0", "nar-1.0", "dum-1.0"]);
  assert.equal(defaultModel, nar);
  assert.equal(findModel("gpt-5"), undefined);
});

test("snu is slower, dearer and does more; dum is quicker, cheaper and terse", () => {
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  assert.ok(cost(usage, snu) > cost(usage, nar) && cost(usage, nar) > cost(usage, dum));
  const prompts = Array.from({ length: 30 }, (_, i) => `fix bug ${i}`);
  const tools = (model: typeof nar) => prompts.map((prompt) => reply(prompt, 0, 1, model).steps.filter((step) => step.kind === "tool").length);
  assert.ok(tools(snu).every((count) => count >= 2 && count <= 4));
  assert.ok(tools(nar).every((count) => count >= 1 && count <= 3));
  assert.ok(tools(dum).every((count) => count === 1));
  const time = (model: typeof nar) => reply("fix the build", 0, 1, model).steps.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(time(snu) > time(nar) && time(nar) > time(dum));
  const text = (model: typeof nar) => (reply("fix the build", 0, 0, model).steps.at(-1) as { text: string }).text;
  assert.ok(text(snu).length > text(nar).length && text(nar).length > text(dum).length);
});

test("--model and NARRE_MODEL choose; a resumed conversation keeps its model", async (t) => {
  // The real path: on macOS the temporary folder is behind a symlink (/var is /private/var), and
  // Narre's working directory is always the real path.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "narre-models-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, NARRE_HOME: home, NARRE_SPEED: "0" };
  const run = async (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    JSON.parse((await promisify(execFile)(process.execPath, [narre, ...args, "--output-format", "json"], { cwd: home, env: { ...env, ...extra } })).stdout) as
      { session: string; model: string; usage: { model: string } };
  assert.equal((await run(["-p", "hello"])).model, "nar-1.0");
  assert.equal((await run(["-p", "hello", "--model", "snu-1.0"])).model, "snu-1.0");
  const first = await run(["-p", "hello"], { NARRE_MODEL: "dum-1.0" });
  assert.equal(first.model, "dum-1.0");
  assert.equal(first.usage.model, "dum-1.0");
  assert.equal((await run(["-p", "again", "--resume", first.session])).model, "dum-1.0");
  assert.equal((await run(["-p", "again", "--resume", first.session, "--model", "snu-1.0"])).model, "snu-1.0");
  const wrong = await promisify(execFile)(process.execPath, [narre, "-p", "hello", "--model", "smart-9"], { cwd: home, env })
    .then(() => undefined, (error: { code: number; stderr: string }) => error);
  assert.equal(wrong?.code, 1);
  assert.match(wrong!.stderr, /no model called smart-9; choose snu-1.0, nar-1.0, dum-1.0/);
});
