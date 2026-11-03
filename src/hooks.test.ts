import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { hookCount, hookRunner, loadHooks } from "./hooks.ts";

/** narre.ts next to this file in src/, narre.js in dist/. */
const narre = join(import.meta.dirname, `narre${import.meta.filename.slice(-3)}`);

/** A project folder with these hooks in .narre/settings.json, and a home of its own, removed after the test. */
function project(t: TestContext, hooks: object) {
  // The real path: on macOS the temporary folder is behind a symlink (/var is /private/var), and
  // Narre's working directory is always the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "narre-hooks-")));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(cwd, ".narre"), { recursive: true });
  writeFileSync(join(cwd, ".narre", "settings.json"), JSON.stringify({ hooks }));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd, env: { ...process.env, NARRE_HOME: home, NARRE_SPEED: "0" } };
}

const logTo = (file: string) => [{ hooks: [{ type: "command", command: `cat >> ${file}; echo >> ${file}` }] }];

test("-p fires SessionStart, UserPromptSubmit, Stop and SessionEnd, with the common hook fields", async (t) => {
  const log = join(tmpdir(), `narre-hooks-${process.pid}.log`);
  const folder = project(t, Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].map((event) => [event, logTo(log)])));
  await promisify(execFile)(process.execPath, [narre, "-p", "hello quick"], { cwd: folder.cwd, env: folder.env });
  const events = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, string>);
  rmSync(log);
  assert.deepEqual(events.map((event) => event.hook_event_name), ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
  assert.ok(events.every((event) => event.session_id === events[0]!.session_id && event.cwd === folder.cwd));
  assert.equal(events[0]!.source, "startup");
  assert.equal(events[1]!.prompt, "hello quick");
  assert.match(events[2]!.transcript_path!, /\.jsonl$/);
});

test("exit code 2 from UserPromptSubmit blocks the prompt", async (t) => {
  const folder = project(t, { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'not today' >&2; exit 2" }] }] });
  const result = await promisify(execFile)(process.execPath, [narre, "-p", "hello"], { cwd: folder.cwd, env: folder.env })
    .then(() => undefined, (error: { code: number; stderr: string }) => error);
  assert.equal(result?.code, 2);
  assert.match(result!.stderr, /blocked the prompt: not today/);
});

test("matchers pick hooks by source, and events run in the order fired", async (t) => {
  const log = join(tmpdir(), `narre-matchers-${process.pid}.log`);
  const folder = project(t, {
    SessionStart: [
      { matcher: "startup|resume", hooks: [{ type: "command", command: `sleep 0.2; echo started >> ${log}` }] },
      { matcher: "clear", hooks: [{ type: "command", command: `echo cleared >> ${log}` }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: `echo stopped >> ${log}` }] }],
  });
  const hooks = loadHooks(folder.cwd, folder.env);
  assert.equal(hookCount(hooks), 3);
  const fire = hookRunner(hooks, folder.cwd);
  const session = { id: "1", file: "1.jsonl" };
  void fire("SessionStart", session, { source: "startup" });
  await fire("Stop", session);
  assert.equal(readFileSync(log, "utf8"), "started\nstopped\n");
  rmSync(log);
});
