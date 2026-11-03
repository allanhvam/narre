// What Narre draws: colours, text measuring and wrapping, the elf, and the blocks of the
// transcript and panels. Pure functions of their input and the width, for the TUI and tests.

import { stripVTControlCharacters } from "node:util";
import { defaultModel, formatCost, formatTokens, formatTotals, models, quotaUsed, type Model, type Question, type Totals } from "./fake.ts";
import type { StoredStep } from "./store.ts";
import { version } from "./version.ts";

type Rgb = readonly [number, number, number];

export const palette = {
  hat: [46, 160, 67], hatDark: [30, 122, 60], red: [215, 38, 61], white: [244, 244, 244],
  gold: [242, 193, 78], skin: [246, 199, 161], eye: [43, 43, 43], cheek: [242, 139, 130], mouth: [179, 58, 58],
  dim: [140, 140, 140], text: [220, 220, 220],
} as const satisfies Record<string, Rgb>;

const fgCode = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const bgCode = ([r, g, b]: Rgb) => `\x1b[48;2;${r};${g};${b}m`;
export const reset = "\x1b[0m";
export const fg = (color: Rgb, text: string) => `${fgCode(color)}${text}${reset}`;
export const bold = (text: string) => `\x1b[1m${text}${reset}`;
export const dim = (text: string) => fg(palette.dim, text);
export const inverse = (text: string) => `\x1b[7m${text}${reset}`;
export const green = (text: string) => fg(palette.hat, text);
export const red = (text: string) => fg(palette.red, text);
export const gold = (text: string) => fg(palette.gold, text);

/** Columns a character takes: 2 for wide CJK and emoji, 0 for combining marks. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) { return 0; }
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f) || /^[\p{Mn}\p{Me}]$/u.test(char)) { return 0; }
  const wide = (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd);
  return wide ? 2 : 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const char of stripVTControlCharacters(text)) { width += charWidth(char); }
  return width;
}

/** Cuts `text` (which may hold colours) to `width` columns. */
export function truncate(text: string, width: number): string {
  let out = "";
  let used = 0;
  // eslint-disable-next-line no-control-regex
  for (const [, escape, char] of text.matchAll(/(\x1b\[[0-9;?]*[ -/]*[@-~])|([\s\S])/gu)) {
    if (escape) { out += escape; continue; }
    const size = charWidth(char!);
    if (used + size > width) { return out + reset; }
    out += char;
    used += size;
  }
  return out;
}

/** Pads with spaces (or cuts) to exactly `width` columns. */
export function fit(text: string, width: number): string {
  const cut = truncate(text, width);
  return cut + " ".repeat(Math.max(0, width - textWidth(cut)));
}

/** Word-wraps plain text to `width` columns; long words are split. */
export function wrap(text: string, width: number): string[] {
  const size = Math.max(1, width);
  return text.split("\n").flatMap((paragraph) => {
    const lines: string[] = [];
    let line = "";
    for (const word of paragraph.split(/(?<= )/)) {
      if (textWidth(line + word.trimEnd()) <= size) { line += word; continue; }
      if (line) { lines.push(line.trimEnd()); }
      let rest = word;
      while (textWidth(rest.trimEnd()) > size) {
        // eslint-disable-next-line no-control-regex
        const part = truncate(rest, size).replace(/\x1b\[0m$/, "");
        lines.push(part);
        rest = rest.slice(part.length);
      }
      line = rest;
    }
    lines.push(line.trimEnd());
    return lines;
  });
}

/**
 * Narre's logo, a Christmas elf, 18×16 pixels: a green hat with a white pompom and a red
 * band with gold bells, pointy ears, rosy cheeks and a smile. Also the source of icon.svg.
 */
export const elfPixels = [
  "..............WW..",
  ".............WWWW.",
  "............GGWW..",
  "...........GGG....",
  "..........GGGD....",
  "........GGGGGD....",
  "......GGGGGGGDD...",
  "....GGGGGGGGGGDD..",
  "..RRYRRRYRRRYRRR..",
  "S..SSSSSSSSSSSS..S",
  ".SSSSEESSSSEESSSS.",
  "..SSSEESSSSEESSS..",
  "...SKKSSSSSSKKS...",
  "...SSSSMSSMSSSS...",
  "....SSSSMMSSSS....",
  "......SSSSSS......",
];

export const elfColors: Record<string, Rgb> = {
  W: palette.white, G: palette.hat, D: palette.hatDark, R: palette.red, Y: palette.gold,
  S: palette.skin, E: palette.eye, K: palette.cheek, M: palette.mouth,
};

/** The elf in half blocks: two pixels a character, 18 columns by 8 lines. */
export function elf(): string[] {
  const lines: string[] = [];
  for (let row = 0; row < elfPixels.length; row += 2) {
    let line = "";
    for (let column = 0; column < elfPixels[row]!.length; column++) {
      const top = elfColors[elfPixels[row]![column]!];
      const bottom = elfColors[elfPixels[row + 1]?.[column] ?? "."];
      if (top && bottom) { line += `${fgCode(top)}${bgCode(bottom)}▀${reset}`; }
      else if (top) { line += `${fgCode(top)}▀${reset}`; }
      else if (bottom) { line += `${fgCode(bottom)}▄${reset}`; }
      else { line += " "; }
    }
    lines.push(line);
  }
  return lines;
}

/** The elf as SVG, one rect per run of a colour, for the web UI's agent icon. */
export function elfSvg(): string {
  const rects: string[] = [];
  elfPixels.forEach((row, y) => {
    for (const match of row.matchAll(/([^.])\1*/g)) {
      const [r, g, b] = elfColors[match[1]!]!;
      const hex = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      rects.push(`<rect x="${match.index}" y="${y}" width="${match[0].length}" height="1" fill="${hex}"/>`);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 16" shape-rendering="crispEdges">\n  ${rects.join("\n  ")}\n</svg>\n`;
}

/** A rounded box around `lines`, `width` columns wide, with an optional title and footer in its borders. */
export function box(lines: string[], width: number, options: { title?: string; footer?: string; color?: Rgb } = {}): string[] {
  const color = options.color ?? palette.dim;
  const inner = Math.max(2, width - 2);
  const border = (left: string, label: string | undefined, right: string) => {
    const text = label ? `─ ${label} ` : "";
    return fg(color, left) + fg(color, text) + fg(color, "─".repeat(Math.max(0, inner - textWidth(text)))) + fg(color, right);
  };
  return [
    border("╭", options.title, "╮"),
    ...lines.map((line) => `${fg(color, "│")} ${fit(line, inner - 2)} ${fg(color, "│")}`),
    border("╰", options.footer, "╯"),
  ];
}

/** "/workspace/app" as "~/app" when it's under HOME. */
export function shortPath(path: string, home = process.env.HOME): string {
  return home && home !== "/" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

/** The welcome box at the top, with the elf. */
export function welcome(width: number, details: { cwd: string; model?: Model; instructions?: string[]; resumed?: { id: string; turns: number } }): string[] {
  const boxWidth = Math.min(width, 78);
  const right = [
    "",
    bold("Welcome to Narre!"),
    dim("A fake coding agent for tests"),
    "",
    `${(details.model ?? defaultModel).id} · made-up usage, nothing is spent`,
    dim(shortPath(details.cwd)),
    details.instructions?.length ? dim(`Using ${details.instructions.map((file) => shortPath(file)).join(", ")}`) : "",
    details.resumed
      ? green(`Resumed ${details.resumed.id.slice(0, 8)} · ${details.resumed.turns} turns`)
      : dim(`Try "ask", "long", "fail", "slow" or /help`),
  ];
  const art = boxWidth >= 50 ? elf() : [];
  const lines = right.map((text, i) => art.length ? `${art[i] ?? " ".repeat(18)}   ${text}` : text);
  return ["", ...box(lines, boxWidth, { title: `${green("Narre")} ${dim(`v${version}`)}`, color: palette.hat })];
}

export function promptBlock(prompt: string, width: number): string[] {
  return ["", ...wrap(prompt, width - 2).map((line, i) => (i === 0 ? fg(palette.hat, "❯ ") : "  ") + bold(line))];
}

export function toolBlock(step: StoredStep, width: number): string[] {
  const head = `${(step.failed ? red : green)("⏺")} ${bold(step.name)}(${step.target})`;
  const result = wrap(step.result, width - 5).map((line, i) => `${i === 0 ? "  ⎿  " : "     "}${step.failed ? red(line) : dim(line)}`);
  return ["", truncate(head, width), ...result];
}

export function textBlock(text: string, width: number): string[] {
  return ["", ...wrap(text, width - 2).map((line, i) => `${i === 0 ? `${fg(palette.text, "⏺")} ` : "  "}${line}`)];
}

export function noteBlock(text: string, width: number, color: (text: string) => string = dim): string[] {
  return wrap(text, width - 5).map((line, i) => `${i === 0 ? "  ⎿  " : "     "}${color(line)}`);
}

/** What the `/cost` panel shows. */
export function costLines(totals: Totals, session: string | undefined, { id, pricing } = defaultModel): string[] {
  const used = quotaUsed(totals);
  const bar = "█".repeat(Math.round(used / 10)) + "░".repeat(10 - Math.round(used / 10));
  const row = (label: string, value: string) => `${dim(`${label}:`.padEnd(19))}${value}`;
  return [
    row("Session", session?.slice(0, 8) ?? "new (no turns yet)"),
    row("Total cost", bold(formatCost(totals.cost))),
    row("Total tokens", formatTotals(totals)),
    row("Turns", String(totals.turns)),
    row("Model", `${id} (fake: $${pricing.input} in · $${pricing.output} out per Mtok)`),
    row("North Pole quota", `${green(bar)} ${used}% used · resets Dec 25`),
  ];
}

export function costPanel(totals: Totals, session: string | undefined, width: number, model = defaultModel): string[] {
  return box(costLines(totals, session, model), width, { title: "Usage", footer: "Esc to close", color: palette.gold });
}

export function questionPanel(question: Question, selected: number, width: number): string[] {
  return [
    ...box([
      bold(question.text),
      "",
      ...question.options.map((option, i) => i === selected ? green(`❯ ${i + 1}. ${option}`) : `  ${i + 1}. ${option}`),
    ], width, { title: "Narre has a question", color: palette.gold }),
    dim("  ↑/↓ or 1-3 to choose · Enter to confirm · Esc to skip"),
  ];
}

/** The footer below the input: where, and what it has cost so far. */
export function footer(width: number, details: { cwd: string; branch?: string; model?: Model; totals: Totals }): string {
  const left = dim(`  ${shortPath(details.cwd)}${details.branch ? ` [⎇ ${details.branch}]` : ""}`);
  const right = dim(`${(details.model ?? defaultModel).id} · ↑${formatTokens(details.totals.input + details.totals.cacheRead + details.totals.cacheWrite)} ↓${formatTokens(details.totals.output)} · `) +
    gold(formatCost(details.totals.cost)) + " ";
  const space = width - textWidth(left) - textWidth(right);
  return space >= 1 ? left + " ".repeat(space) + right : truncate(left, width);
}

export const commands: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/help", description: "Show what Narre can do" },
  { name: "/cost", description: "Show the made-up cost and tokens of this conversation" },
  { name: "/usage", description: "Same as /cost" },
  { name: "/model", description: "Show the models, or switch with /model <name>" },
  { name: "/status", description: "Show the session, version and hooks" },
  { name: "/clear", description: "Start a new conversation" },
  { name: "/exit", description: "Quit Narre" },
];

export function helpLines(): string[] {
  return [
    bold("Narre: a fake coding agent for tests"),
    "Every prompt gets a made-up reply with fake tool calls, tokens and cost. Nothing is changed or sent anywhere.",
    "",
    "Words in a prompt that change the reply:",
    `  ${gold("ask")}    asks a question first (status "input")`,
    `  ${gold("slow")}   takes four times as long`,
    `  ${gold("long")}   a long answer, for scrolling`,
    `  ${gold("fail")}   one of the tools fails`,
    `  ${gold("quick")}  answers at once`,
    "",
    "Commands:",
    ...commands.map((command) => `  ${gold(command.name.padEnd(8))} ${command.description}`),
    "",
    "Keys: Enter sends · \\ then Enter or Ctrl+J for a new line · Esc interrupts · Ctrl+C twice quits",
    "Environment: NARRE_SPEED (0 instant, 1 normal), NARRE_HOME (default ~/.narre), NARRE_NOTIFY (bell, osc9, both, off),",
    "  NARRE_MODEL (snu-1.0, nar-1.0 or dum-1.0)",
  ];
}

export const shortcuts = [
  "/ for commands", "Esc to interrupt", "\\⏎ or Ctrl+J for a new line",
  "↑/↓ for earlier prompts", "Ctrl+L to redraw", "Ctrl+C twice to quit",
];

// Signals to the terminal, for whoever watches it: the title (OSC 0, a tmux pane's title),
// the bell, and desktop notifications (OSC 9). Control characters are dropped from the
// text, so it can't end the sequence early.
const plain = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]+/g, " ");

export function terminalTitle(text: string): string {
  return `\x1b]0;${plain(text)}\x07`;
}

/** Saves and restores the title on the terminal's stack (xterm's), around Narre's own. */
export const pushTitle = "\x1b[22;0t";
export const popTitle = "\x1b[23;0t";

export type NotifyMode = "bell" | "osc9" | "both" | "off";

export function notifyMode(value: string | undefined): NotifyMode {
  return value === "osc9" || value === "both" || value === "off" ? value : "bell";
}

/** The bell and/or an OSC 9 notification; inside tmux, OSC 9 goes through its passthrough. */
export function notification(message: string, mode: NotifyMode, inTmux: boolean): string {
  const osc9 = `\x1b]9;${plain(message)}\x07`;
  return (mode === "bell" || mode === "both" ? "\x07" : "") +
    (mode === "osc9" || mode === "both" ? (inTmux ? `\x1bPtmux;${osc9.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : osc9) : "");
}

/** The models, the current one marked, for /model. */
export function modelLines(current: Model): string[] {
  return [
    ...models.map((model) => {
      const line = `${model.id.padEnd(8)} ${model.description} ${dim(`($${model.pricing.input} in · $${model.pricing.output} out per Mtok)`)}`;
      return model.id === current.id ? `${green("❯")} ${bold(line)}` : `  ${line}`;
    }),
    "",
    dim("Switch with /model <name>, or start Narre with --model <name>."),
  ];
}
