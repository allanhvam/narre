// Narre's hooks, in the format coding agents share, so whatever drives a real agent through hooks can
// drive Narre the same way. Read from $NARRE_HOME/settings.json, <cwd>/.narre/settings.json
// and <cwd>/.narre/settings.local.json, all of them adding up:
//
//   { "hooks": { "Stop": [ { "matcher": "", "hooks": [ { "type": "command", "command": "…", "timeout": 60 } ] } ] } }
//
// Each command runs in `sh -c` with the event as JSON on stdin (session_id, transcript_path,
// cwd, hook_event_name and the event's own fields) and NARRE_PROJECT_DIR set. The matcher is
// a regular expression on SessionStart's source, the tool events' tool_name, Notification's
// notification_type and SessionEnd's reason; other events ignore it. Exit code 2 on UserPromptSubmit blocks the
// prompt, with stderr as the reason. Hooks run one at a time, in the order they're fired.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { narreHome } from "./store.ts";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Notification" | "Stop" | "SessionEnd";

type Command = { type: "command"; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: Command[] };
export type Hooks = Partial<Record<HookEvent, Matcher[]>>;

export type HookResult = { blocked: boolean; reason: string };

/** The settings files hooks are read from, most general first. */
export function settingsFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [join(narreHome(env), "settings.json"), join(cwd, ".narre", "settings.json"), join(cwd, ".narre", "settings.local.json")];
}

/** The hooks of every settings file that exists, added up; an unreadable file is skipped. */
export function loadHooks(cwd: string, env: NodeJS.ProcessEnv = process.env): Hooks {
  const hooks: Hooks = {};
  for (const file of settingsFiles(cwd, env)) {
    if (!existsSync(file)) { continue; }
    try {
      const settings = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Hooks };
      for (const [event, matchers] of Object.entries(settings.hooks ?? {}) as Array<[HookEvent, Matcher[]]>) {
        if (Array.isArray(matchers)) { (hooks[event] ??= []).push(...matchers); }
      }
    } catch {
      process.stderr.write(`narre: skipping ${file}, which isn't valid JSON\n`);
    }
  }
  return hooks;
}

export function hookCount(hooks: Hooks): number {
  return Object.values(hooks).reduce((sum, matchers) => sum + matchers.reduce((n, matcher) => n + (matcher.hooks?.length ?? 0), 0), 0);
}

/** What a matcher is matched against, per event. */
const matchField: Partial<Record<HookEvent, string>> = {
  SessionStart: "source", PreToolUse: "tool_name", PostToolUse: "tool_name", Notification: "notification_type", SessionEnd: "reason",
};

function matches(matcher: string | undefined, value: unknown): boolean {
  if (!matcher || matcher === "*" || typeof value !== "string") { return true; }
  try {
    return new RegExp(`^(?:${matcher})$`).test(value);
  } catch {
    return matcher === value;
  }
}

function runCommand(hook: Command, input: string, cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", hook.command], {
      cwd, env: { ...process.env, NARRE_PROJECT_DIR: cwd }, stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), (hook.timeout ?? 60) * 1000);
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 1, stderr: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }); });
  });
}

/** Fires events in order: each waits for the hooks of the one before. */
export function hookRunner(hooks: Hooks, cwd: string) {
  let last: Promise<unknown> = Promise.resolve();
  return (event: HookEvent, session: { id: string; file: string }, fields: Record<string, unknown> = {}): Promise<HookResult> => {
    const run = async (): Promise<HookResult> => {
      const commands = (hooks[event] ?? []).filter((matcher) => matches(matcher.matcher, fields[matchField[event] ?? ""]))
        .flatMap((matcher) => matcher.hooks ?? []).filter((hook) => hook.type === "command" && hook.command);
      if (!commands.length) { return { blocked: false, reason: "" }; }
      const input = JSON.stringify({ session_id: session.id, transcript_path: session.file, cwd, hook_event_name: event, ...fields });
      const results = await Promise.all(commands.map((hook) => runCommand(hook, input, cwd)));
      const blocking = results.filter((result) => result.code === 2);
      return { blocked: event === "UserPromptSubmit" && blocking.length > 0, reason: blocking.map((result) => result.stderr.trim()).filter(Boolean).join("\n") };
    };
    const result = last.then(run, run);
    last = result;
    return result;
  };
}
