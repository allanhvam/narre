#!/usr/bin/env node
// Narre: a fake coding agent with a terminal UI, for tests. It looks and behaves
// like other coding harnesses (a transcript with tool calls, a spinner, an
// input box, questions, /cost), but every reply, token and dollar is made up (fake.ts).
//
//   narre                          interactive, a new conversation
//   narre --continue | -c          continue the last conversation in this directory
//   narre --resume <id>            continue a conversation by id
//   narre -p "<prompt>"            answer once and exit; --output-format json for JSON
//   narre --model <name>           use snu-1.0, nar-1.0 (the default) or dum-1.0 (fake.ts)
//   narre --acp                    serve the Agent Client Protocol on stdin and stdout (acp.ts)
//   narre --acp --port <port>      the same over TCP, on 127.0.0.1 unless --host says otherwise
//   narre --latest <dir>          print the id of the last conversation in <dir>
//   narre --usage                  print the usage of the last conversation here (JSON)
//
// It runs hooks in the format coding agents share (SessionStart, UserPromptSubmit, Notification, Stop,
// SessionEnd), so its status can be followed like a real agent's (hooks.ts).
//
// Runs on Node 24+ as is (type stripping); needs only Node's own modules.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  addUsage, defaultModel, emptyTotals, finalStep, finalText, findModel, models, formatCost, formatTokens, formatTotals, quotaUsed, reply, speed, turnUsage,
  type Model, type Question, type Reply, type Totals,
} from "./fake.ts";
import {
  commands, costPanel, dim, footer, gold, helpLines, inverse, noteBlock, palette, promptBlock, questionPanel, red, shortcuts,
  box, charWidth, modelLines, textBlock, toolBlock, truncate, welcome, fg, notification, notifyMode, popTitle, pushTitle, shortPath, terminalTitle,
} from "./screen.ts";
import { runAcp, serveAcp } from "./acp.ts";
import { hookCount, hookRunner, loadHooks, settingsFiles } from "./hooks.ts";
import { contextTokens, loadInstructions } from "./instructions.ts";
import {
  findConversation, latestConversation, loadConversation, newConversation, saveTurn, totalsOf,
  type Conversation, type StoredStep, type StoredTurn,
} from "./store.ts";
import { version } from "./version.ts";

process.title = "narre";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    print: { type: "string", short: "p" },
    continue: { type: "boolean", short: "c" },
    resume: { type: "string", short: "r" },
    model: { type: "string", short: "m" },
    acp: { type: "boolean" },
    stdio: { type: "boolean" },
    port: { type: "string" },
    host: { type: "string" },
    "output-format": { type: "string" },
    latest: { type: "string" },
    usage: { type: "boolean" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});
const option = (name: string) => typeof options[name] === "string" ? options[name] as string : undefined;
const cwd = process.cwd();

/** The usage as printed by --usage and -p --output-format json. */
function usageRecord(totals: Totals, session: string | undefined, model: Model) {
  return {
    session,
    model: model.id,
    cost: formatCost(totals.cost),
    tokens: formatTotals(totals),
    limits: [`North Pole quota: ${quotaUsed(totals)}% used · resets Dec 25`],
    turns: totals.turns,
    totals,
    updated: new Date().toISOString(),
  };
}

function openConversation(): Conversation {
  const id = option("resume");
  if (id !== undefined) {
    const file = findConversation(id);
    if (!file) {
      process.stderr.write(`narre: no conversation with id ${id}\n`);
      process.exit(1);
    }
    return loadConversation(file);
  }
  if (options.continue) {
    const file = latestConversation(cwd);
    if (file) { return loadConversation(file); }
  }
  return newConversation(cwd);
}

/** The model asked for with --model, else NARRE_MODEL; exits if there's no such model. */
function explicitModel(): Model | undefined {
  const id = option("model") ?? process.env.NARRE_MODEL;
  if (id === undefined) { return undefined; }
  const model = findModel(id);
  if (!model) {
    process.stderr.write(`narre: no model called ${id}; choose ${models.map((known) => known.id).join(", ")}\n`);
    process.exit(1);
  }
  return model;
}

/** --model, else NARRE_MODEL, else the model the conversation last used, else the default. */
function chooseModel(conversation: Conversation): Model {
  return explicitModel() ?? findModel(conversation.turns.at(-1)?.model) ?? defaultModel;
}

if (options.version) {
  process.stdout.write(`${version} (Narre)\n`);
  process.exit(0);
}
if (options.help) {
  process.stdout.write([
    "Usage: narre [--continue | --resume <id>] [--model <name>]",
    "       narre -p <prompt> [--output-format text|json]",
    "       narre --acp [--stdio | --port <port> [--host <host>]] [--model <name>]",
    "       narre --latest <dir> | --usage | --version",
    "",
    `Models: ${models.map((model) => `${model.id} (${model.description})`).join(", ")}.`,
    "A fake coding agent for tests: made-up replies, tokens and cost. Prompt words:",
    "ask (asks a question), slow, long, fail, quick. NARRE_SPEED=0 answers at once.",
    "Hooks are read from ~/.narre/settings.json and .narre/settings.json.",
    "",
  ].join("\n"));
  process.exit(0);
}
if (option("latest") !== undefined) {
  const file = latestConversation(option("latest")!);
  if (file) { process.stdout.write(`${loadConversation(file).id}\n`); }
  process.exit(0);
}
if (options.usage) {
  const file = latestConversation(cwd);
  const conversation = file ? loadConversation(file) : undefined;
  const model = findModel(conversation?.turns.at(-1)?.model) ?? defaultModel;
  process.stdout.write(JSON.stringify(usageRecord(totalsOf(conversation?.turns ?? []), conversation?.id, model), null, 2) + "\n");
  process.exit(0);
}
const printPrompt = option("print") ?? (options.print === true ? positionals.join(" ") : undefined);
if (options.acp) {
  await startAcp();
} else if (printPrompt !== undefined) {
  process.exit(await printOnce(printPrompt));
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("narre: the interactive mode needs a terminal; use -p <prompt> without one\n");
    process.exit(2);
  }
  interactive();
}

/** --acp: on stdin and stdout until stdin ends, or with --port on TCP until stopped. */
async function startAcp(): Promise<void> {
  const port = option("port");
  if (port === undefined) {
    await runAcp({ model: explicitModel() });
    process.exit(0);
  }
  if (options.stdio) {
    process.stderr.write("narre: --stdio and --port can't be used together\n");
    process.exit(1);
  }
  if (!/^\d+$/.test(port) || Number(port) > 65_535) {
    process.stderr.write(`narre: --port must be a number from 0 to 65535, not ${port}\n`);
    process.exit(1);
  }
  // Only this machine by default: Narre has no authentication.
  await serveAcp({ model: explicitModel(), port: Number(port), host: option("host") ?? "127.0.0.1" }).catch((error: Error) => {
    process.stderr.write(`narre: can't listen on port ${port}: ${error.message}\n`);
    process.exit(1);
  });
}

/** -p: answers at once, picking the first option of any question. Returns the exit code. */
async function printOnce(prompt: string): Promise<number> {
  const conversation = openConversation();
  const model = chooseModel(conversation);
  const instructions = loadInstructions(cwd);
  const fire = hookRunner(loadHooks(cwd), cwd);
  void fire("SessionStart", conversation, { source: conversation.turns.length ? "resume" : "startup", model: model.id });
  const submitted = await fire("UserPromptSubmit", conversation, { prompt });
  if (submitted.blocked) {
    process.stderr.write(`narre: a UserPromptSubmit hook blocked the prompt${submitted.reason ? `: ${submitted.reason}` : ""}\n`);
    await fire("SessionEnd", conversation, { reason: "other" });
    return 2;
  }
  const answer = reply(prompt, conversation.turns.length, 0, model);
  const text = finalText(finalStep(answer).text, answer.question?.options[0]);
  const steps = toolSteps(answer);
  const usage = turnUsage(prompt, text, steps.length, contextTokens(conversation.turns, instructions));
  saveTurn(conversation, { prompt, steps, text, usage, model: model.id, at: new Date().toISOString() });
  if (option("output-format") === "json") {
    process.stdout.write(JSON.stringify({
      result: text, session: conversation.id, model: model.id, steps, instructions: instructions.map(({ file }) => file),
      usage: usageRecord(addUsage(emptyTotals, usage, model), conversation.id, model),
    }) + "\n");
  } else {
    process.stdout.write(`${text}\n`);
  }
  void fire("Stop", conversation);
  await fire("SessionEnd", conversation, { reason: "other" });
  return 0;
}

function toolSteps(answer: Reply): StoredStep[] {
  return answer.steps.flatMap((step) => step.kind === "tool"
    ? [{ name: step.name, target: step.target, result: step.result, ...(step.failed ? { failed: true } : {}) }] : []);
}

function currentBranch(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function interactive(): void {
  const out = process.stdout;
  const hooks = loadHooks(cwd);
  const fire = hookRunner(hooks, cwd);
  const notifyWith = notifyMode(process.env.NARRE_NOTIFY);
  let instructions = loadInstructions(cwd);
  let conversation = openConversation();
  let model = chooseModel(conversation);
  let totals = totalsOf(conversation.turns);
  const branch = currentBranch();
  /** The transcript as blocks, redrawn whole when the terminal is resized. */
  let transcript: Array<(width: number) => string[]> = [];
  /** Lines the live area (spinner, input, footer) takes on screen now. */
  let liveHeight = 0;
  let input: string[] = [];
  let cursor = 0;
  let history: string[] = conversation.turns.map((turn) => turn.prompt);
  let historyIndex = history.length;
  const queued: string[] = [];
  let working: { started: number; verb: string; outputTokens: number; controller: AbortController } | undefined;
  let question: { question: Question; selected: number; answer: (choice: string | undefined) => void } | undefined;
  let panel: "cost" | "shortcuts" | undefined;
  let notice: { text: string; until: number } | undefined;
  let lastCtrlC = 0;
  let frameIndex = 0;
  let pasting = false;
  let pasted = "";

  const width = () => Math.max(20, out.columns || 80);
  const height = () => Math.max(5, out.rows || 24);

  const spinnerLine = () => {
    if (!working) { return []; }
    const glyph = ["·", "✢", "✳", "❄", "✻", "✽", "✻", "❄", "✳", "✢"][frameIndex % 10]!;
    const seconds = Math.floor((Date.now() - working.started) / 1000);
    const state = question ? "waiting for your answer" : `${seconds}s · ↓ ${formatTokens(working.outputTokens)} tokens · esc to interrupt`;
    return ["", `${fg(palette.red, glyph)} ${fg(palette.red, `${working.verb}…`)} ${dim(`(${state})`)}`];
  };

  const inputLines = (textWidth: number): string[] => {
    if (!input.length) {
      const placeholder = working ? "Queue another message…" : 'Try "ask me something", "long", "fail" or /help';
      return [inverse(placeholder[0]!) + dim(placeholder.slice(1))];
    }
    const lines: string[] = [];
    let line = "";
    let used = 0;
    for (let i = 0; i <= input.length; i++) {
      const char = i < input.length ? input[i]! : " ";
      const here = i === cursor;
      if (char === "\n") {
        lines.push(line + (here ? inverse(" ") : ""));
        line = "";
        used = 0;
        continue;
      }
      const size = charWidth(char);
      if (used + size > textWidth) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += here ? inverse(char) : char;
      used += size;
    }
    lines.push(line);
    return lines;
  };

  const liveLines = (): string[] => {
    const columns = width();
    // A blank line between the transcript and the input, or the spinner and its own.
    const lines = working ? spinnerLine() : [""];
    for (const message of queued) {
      lines.push(...noteBlock(`Queued: ${message.replace(/\s+/g, " ")}`, columns).map((line) => truncate(line, columns)));
    }
    if (question) {
      lines.push(...questionPanel(question.question, question.selected, columns));
      return lines;
    }
    // Command suggestions go above the input, so the last line showing a typed command is
    // the input itself (a program typing /cost into the terminal checks that line before Enter).
    const typed = input.join("");
    if (/^\/\S*$/.test(typed)) {
      const matches = commands.filter((command) => command.name.startsWith(typed));
      lines.push(...(matches.length ? matches : [{ name: "", description: "No such command" }])
        .map((command) => `  ${gold(command.name.padEnd(10))}${dim(command.description)}`));
    }
    const text = inputLines(columns - 6).map((line, i) => (i === 0 ? fg(palette.hat, "❯ ") : "  ") + line);
    // Leaves room for the spinner and footer when the input is taller than the screen.
    const room = Math.max(1, height() - lines.length - 6);
    lines.push(...box(text.slice(-room), columns, { color: working ? palette.dim : palette.hat }));
    if (panel === "cost") {
      lines.push(...costPanel(totals, conversation.turns.length ? conversation.id : undefined, columns, model));
    } else if (panel === "shortcuts") {
      lines.push(...shortcuts.map((shortcut) => dim(`  ${shortcut}`)));
    } else {
      lines.push(footer(columns, { cwd, branch, model, totals }));
      lines.push(notice && notice.until > Date.now() ? gold(`  ${notice.text}`) : dim("  ? for shortcuts · /help for commands"));
    }
    return lines.map((line) => truncate(line, columns));
  };

  /** Redraws the live area, writing `committed` lines into the transcript above it first. */
  const render = (committed: string[] = []) => {
    let output = "\x1b[?2026h";
    if (liveHeight > 0) { output += `\r${liveHeight > 1 ? `\x1b[${liveHeight - 1}A` : ""}\x1b[J`; }
    if (committed.length) { output += committed.map((line) => `${line}\x1b[0m\x1b[K`).join("\r\n") + "\r\n"; }
    const lines = liveLines().slice(-(height() - 1));
    output += lines.join("\r\n") + "\x1b[?2026l";
    liveHeight = lines.length;
    out.write(output);
  };

  const commit = (block: (width: number) => string[]) => {
    transcript.push(block);
    render(block(width()));
  };

  const redrawAll = () => {
    liveHeight = 0;
    out.write("\x1b[2J\x1b[3J\x1b[H");
    render(transcript.flatMap((block) => block(width())));
  };

  function notify(text: string) {
    notice = { text, until: Date.now() + 2_000 };
  }

  /** Sets the terminal's title and, with an alert, rings the bell or notifies (NARRE_NOTIFY). */
  const signal = (title: string, alert?: string) => {
    out.write(terminalTitle(title) + (alert ? notification(alert, notifyWith, !!process.env.TMUX) : ""));
  };
  const workingTitle = (prompt: string) => `✻ Narre: ${truncate(prompt.replace(/\s+/g, " "), 50)}`;

  const showTurn = (turn: StoredTurn) => {
    commit((w) => promptBlock(turn.prompt, w));
    for (const step of turn.steps) { commit((w) => toolBlock(step, w)); }
    if (turn.text) { commit((w) => textBlock(turn.text, w)); }
    if (turn.interrupted) { commit((w) => noteBlock("Interrupted · What should Narre do instead?", w, red)); }
  };

  const startScreen = (resumed: boolean) => {
    const details = { cwd, model, instructions: instructions.map(({ file }) => file), ...(resumed ? { resumed: { id: conversation.id, turns: conversation.turns.length } } : {}) };
    commit((w) => welcome(w, details));
    for (const turn of conversation.turns) { showTurn(turn); }
  };

  const ask = (asked: Question) => new Promise<string | undefined>((resolve) => {
    question = { question: asked, selected: 0, answer: (choice) => { question = undefined; resolve(choice); } };
    void fire("Notification", conversation, { message: `Narre needs your input: ${asked.text}`, notification_type: "question" });
    signal("? Narre: needs your input", `Narre needs your input: ${asked.text}`);
    render();
  });

  const runTurn = async (prompt: string) => {
    // The model the turn started with, even if /model switches while it works.
    const used = model;
    const answer = reply(prompt, conversation.turns.length, speed(), used);
    const controller = new AbortController();
    const text = finalStep(answer);
    working = { started: Date.now(), verb: answer.verb, outputTokens: 0, controller };
    history.push(prompt);
    historyIndex = history.length;
    commit((w) => promptBlock(prompt, w));
    signal(workingTitle(prompt));
    const submitted = await fire("UserPromptSubmit", conversation, { prompt });
    if (submitted.blocked) {
      commit((w) => noteBlock(`A UserPromptSubmit hook blocked the prompt${submitted.reason ? `: ${submitted.reason}` : ""}`, w, red));
      working = undefined;
      signal("Narre");
      next();
      return;
    }
    const steps: StoredStep[] = [];
    let picked: string | undefined;
    let interrupted = false;
    try {
      for (const step of answer.steps) {
        if (step.kind !== "tool") { continue; }
        const toolInput = { target: step.target };
        void fire("PreToolUse", conversation, { tool_name: step.name, tool_input: toolInput });
        await sleep(step.delayMs, undefined, { signal: controller.signal });
        const stored: StoredStep = { name: step.name, target: step.target, result: step.result, ...(step.failed ? { failed: true } : {}) };
        steps.push(stored);
        working.outputTokens += 25;
        commit((w) => toolBlock(stored, w));
        void fire("PostToolUse", conversation, { tool_name: step.name, tool_input: toolInput, tool_response: { result: step.result, failed: !!step.failed } });
      }
      if (answer.question) {
        picked = await ask(answer.question);
        if (controller.signal.aborted) { throw controller.signal.reason; }
        const chosen = picked;
        commit((w) => noteBlock(chosen === undefined ? "No answer; Narre will choose itself" : `Answered: ${chosen}`, w, gold));
        signal(workingTitle(prompt));
      }
      await sleep(text.delayMs, undefined, { signal: controller.signal });
    } catch {
      interrupted = true;
    }
    const final = interrupted ? "" : finalText(text.text, picked ?? (answer.question ? answer.question.options[0] : undefined));
    if (interrupted) {
      commit((w) => noteBlock("Interrupted · What should Narre do instead?", w, red));
    } else {
      commit((w) => textBlock(final, w));
    }
    const usage = turnUsage(prompt, final, steps.length, contextTokens(conversation.turns, instructions));
    saveTurn(conversation, { prompt, steps, text: final, usage, model: used.id, ...(interrupted ? { interrupted: true } : {}), at: new Date().toISOString() });
    totals = addUsage(totals, usage, used);
    working = undefined;
    // Like other agents, not when the user interrupted.
    if (!interrupted) { void fire("Stop", conversation); }
    signal("Narre", interrupted ? undefined : "Narre has finished");
    next();
  };

  /** Runs the next queued prompt, if any. */
  const next = () => {
    const prompt = queued.shift();
    if (prompt !== undefined) {
      void runTurn(prompt);
    } else {
      render();
    }
  };

  const runCommand = (line: string): boolean => {
    const [name, argument] = line.trim().split(/\s+/);
    switch (name) {
      case "/help":
        commit((w) => ["", ...box(helpLines(), Math.min(w, 100), { title: "Help", color: palette.hat })]);
        return true;
      case "/cost":
      case "/usage":
        panel = "cost";
        render();
        return true;
      case "/model": {
        if (argument === undefined) {
          commit((w) => ["", ...box(modelLines(model), Math.min(w, 100), { title: "Models", color: palette.hat })]);
          return true;
        }
        const chosen = findModel(argument);
        if (!chosen) {
          commit((w) => noteBlock(`No model called ${argument}. Try ${models.map((known) => known.id).join(", ")}.`, w, red));
          return true;
        }
        model = chosen;
        commit((w) => noteBlock(`Switched to ${model.id}: ${model.description}`, w, gold));
        return true;
      }
      case "/status":
        commit((w) => ["", ...box([
          `Version:      ${version}`,
          `Model:        ${model.id}`,
          `Session:      ${conversation.turns.length ? conversation.id : "new (no turns yet)"}`,
          `Directory:    ${cwd}`,
          `Instructions: ${instructions.length ? instructions.map(({ file }) => shortPath(file)).join(", ") : "none (no AGENTS.md)"}`,
          `Hooks:        ${hookCount(hooks)} (${settingsFiles(cwd).join(", ")})`,
          `Speed:        ${speed()} (NARRE_SPEED)`,
        ], Math.min(w, 100), { title: "Status", color: palette.hat })]);
        return true;
      case "/clear":
        void fire("SessionEnd", conversation, { reason: "clear" });
        conversation = newConversation(cwd);
        instructions = loadInstructions(cwd);
        void fire("SessionStart", conversation, { source: "clear", model: model.id });
        totals = totalsOf([]);
        history = [];
        historyIndex = 0;
        transcript = [];
        redrawAll();
        startScreen(false);
        return true;
      case "/exit":
      case "/quit":
        void quit();
        return true;
      default:
        if (name?.startsWith("/") && !name.includes("/", 1)) {
          commit((w) => noteBlock(`Unknown command ${name}. Try /help.`, w, red));
          return true;
        }
        return false;
    }
  };

  const submit = () => {
    const text = input.join("");
    if (!text.trim()) { return; }
    input = [];
    cursor = 0;
    panel = undefined;
    if (runCommand(text)) { return; }
    if (working) {
      queued.push(text);
      render();
      return;
    }
    void runTurn(text);
  };

  const insert = (text: string) => {
    const chars = Array.from(text);
    input.splice(cursor, 0, ...chars);
    cursor += chars.length;
  };

  const quit = async () => {
    out.write(`\r${liveHeight > 1 ? `\x1b[${liveHeight - 1}A` : ""}\x1b[J`);
    if (conversation.turns.length) {
      out.write(dim(`Resume this conversation with: narre --resume ${conversation.id}`) + "\r\n");
    }
    out.write("\x1b[?2004l\x1b[?25h" + popTitle);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    await fire("SessionEnd", conversation, { reason: "prompt_input_exit" });
    process.exit(0);
  };

  const onKey = (key: string) => {
    if (panel && key !== "?") {
      const wasOpen = panel;
      panel = undefined;
      if (key === "\x1b" || (wasOpen === "cost" && key === "\r")) { return; }
    }
    if (question) {
      const count = question.question.options.length;
      if (key === "\x1b[A") { question.selected = (question.selected + count - 1) % count; }
      else if (key === "\x1b[B") { question.selected = (question.selected + 1) % count; }
      else if (/^[1-9]$/.test(key) && Number(key) <= count) { question.answer(question.question.options[Number(key) - 1]); }
      else if (key === "\r") { question.answer(question.question.options[question.selected]); }
      else if (key === "\x1b") { question.answer(undefined); }
      else if (key === "\x03") { working?.controller.abort(); question.answer(undefined); }
      return;
    }
    switch (key) {
      case "\r":
        if (input[cursor - 1] === "\\") {
          input.splice(cursor - 1, 1, "\n");
        } else {
          submit();
        }
        return;
      case "\n":
      case "\x1b\r":
        insert("\n");
        return;
      case "\x7f":
      case "\b":
        if (cursor > 0) { input.splice(--cursor, 1); }
        return;
      case "\x1b[3~":
        input.splice(cursor, 1);
        return;
      case "\x1b[D":
        cursor = Math.max(0, cursor - 1);
        return;
      case "\x1b[C":
        cursor = Math.min(input.length, cursor + 1);
        return;
      case "\x01": case "\x1b[H": case "\x1bOH": case "\x1b[1~":
        cursor = 0;
        return;
      case "\x05": case "\x1b[F": case "\x1bOF": case "\x1b[4~":
        cursor = input.length;
        return;
      case "\x15":
        input.splice(0, cursor);
        cursor = 0;
        return;
      case "\x17": {
        let start = cursor;
        while (start > 0 && input[start - 1] === " ") { start--; }
        while (start > 0 && input[start - 1] !== " ") { start--; }
        input.splice(start, cursor - start);
        cursor = start;
        return;
      }
      case "\x1b[A":
      case "\x1b[B": {
        if (input.includes("\n") || !history.length) { return; }
        historyIndex = Math.min(history.length, Math.max(0, historyIndex + (key === "\x1b[A" ? -1 : 1)));
        input = Array.from(history[historyIndex] ?? "");
        cursor = input.length;
        return;
      }
      case "\x0c":
        redrawAll();
        return;
      case "\x1b":
        if (working) { working.controller.abort(); }
        return;
      case "\x03":
        if (working) {
          working.controller.abort();
        } else if (input.length) {
          input = [];
          cursor = 0;
        } else if (Date.now() - lastCtrlC < 2_000) {
          void quit();
        } else {
          lastCtrlC = Date.now();
          notify("Press Ctrl+C again to exit");
        }
        return;
      case "\x04":
        if (!input.length) { void quit(); }
        return;
      case "?":
        if (!input.length) {
          panel = panel === "shortcuts" ? undefined : "shortcuts";
          return;
        }
        insert(key);
        return;
      case "\t":
        return;
      default:
        if (key.startsWith("\x1b") || key < " ") { return; }
        insert(key);
    }
  };

  const onData = (data: string) => {
    let i = 0;
    while (i < data.length) {
      if (pasting) {
        const end = data.indexOf("\x1b[201~", i);
        if (end < 0) {
          pasted += data.slice(i);
          break;
        }
        pasted += data.slice(i, end);
        i = end + 6;
        pasting = false;
        if (!question) {
          panel = undefined;
          insert(pasted.replace(/\r\n?/g, "\n"));
        }
        pasted = "";
        continue;
      }
      if (data.startsWith("\x1b[200~", i)) {
        pasting = true;
        i += 6;
        continue;
      }
      if (data[i] === "\x1b") {
        // eslint-disable-next-line no-control-regex
        const sequence = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O[@-~]|\r)/.exec(data.slice(i))?.[0];
        if (sequence) {
          onKey(sequence);
          i += sequence.length;
          continue;
        }
        onKey("\x1b");
        i++;
        continue;
      }
      const char = String.fromCodePoint(data.codePointAt(i)!);
      onKey(char);
      i += char.length;
    }
    render();
  };

  out.on("error", () => process.exit(0));
  process.on("SIGHUP", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  out.on("resize", redrawAll);
  // Hidden cursor (the input draws its own), bracketed paste on, the old title saved.
  out.write("\x1b[?25l\x1b[?2004h" + pushTitle);
  signal("Narre");
  startScreen(conversation.turns.length > 0);
  void fire("SessionStart", conversation, { source: conversation.turns.length ? "resume" : "startup", model: model.id });
  setInterval(() => {
    frameIndex++;
    if (working || (notice && notice.until > Date.now() - 200)) { render(); }
  }, 120);
}
