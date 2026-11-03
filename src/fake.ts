// Narre's made-up replies and usage. Pure and deterministic: the same prompt in the same
// turn always gives the same reply, tools, timings, tokens and cost, so tests can rely on
// them. Nothing here touches files or the network.

export type Model = {
  id: string;
  /** One line, for /model and --help. */
  description: string;
  /** Fake prices in dollars per million tokens. */
  pricing: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** How long its replies take, times NARRE_SPEED. */
  pace: number;
  /** The fewest and most tool calls in a reply. */
  tools: readonly [number, number];
  /** What it adds to the end of a reply: an aside, the usual closing line, or nothing. */
  style: "sly" | "plain" | "terse";
};

/** Narre's models, by intelligence: sly, a fool (or a jester playing one), and stupid. */
export const models: readonly Model[] = [
  {
    id: "snu-1.0", description: "Sly: thorough and slow, and the dearest",
    pricing: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, pace: 2, tools: [2, 4], style: "sly",
  },
  {
    id: "nar-1.0", description: "The fool, or a jester playing one: the default",
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, pace: 1, tools: [1, 3], style: "plain",
  },
  {
    id: "dum-1.0", description: "Stupid: quick, cheap and terse",
    pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, pace: 0.4, tools: [1, 1], style: "terse",
  },
];

export const defaultModel = models[1]!;

export function findModel(id: string | undefined): Model | undefined {
  return models.find((model) => model.id === id);
}

/** The fake plan quota that `/cost` shows as used, in dollars. */
export const quotaDollars = 5;

export type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Totals = TurnUsage & { cost: number; turns: number };

export type Step =
  | { kind: "tool"; name: string; target: string; result: string; failed?: boolean; delayMs: number }
  | { kind: "text"; text: string; delayMs: number };

export type Question = { text: string; options: string[] };

export type Reply = {
  /** Shown one after another, each after its delay. */
  steps: Step[];
  /** Asked after the tool steps; the final text step mentions the answer. */
  question?: Question;
  /** Shown in the spinner while working. */
  verb: string;
};

/**
 * Words in a prompt that change the reply, for tests:
 * - ask:  asks a question first (the agent's status becomes "input")
 * - slow: takes four times as long
 * - long: a long, many-line answer (for scrolling)
 * - fail: one of the tools fails
 * - quick: no delays at all
 */
export const triggers = ["ask", "slow", "long", "fail", "quick"] as const;

export function hasTrigger(prompt: string, trigger: (typeof triggers)[number]): boolean {
  return new RegExp(`\\b${trigger}\\b`, "i").test(prompt);
}

/** FNV-1a, so replies are stable across runs and machines. */
export function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

function pick<T>(items: readonly T[], seed: number, salt: number): T {
  return items[(hash(`${seed}:${salt}`) % items.length)]!;
}

export const verbs = [
  "Wrapping presents", "Polishing sleigh bells", "Consulting the naughty list", "Baking gingerbread",
  "Untangling fairy lights", "Feeding the reindeer", "Sharpening candy canes", "Knitting stockings",
  "Tuning jingle bells", "Counting snowflakes", "Painting toy soldiers", "Stirring hot cocoa",
];

const files = ["src/index.ts", "package.json", "README.md", "src/workshop/toys.ts", "src/sleigh/route.ts", "test/elves.test.ts"];

const tools: ReadonlyArray<(seed: number) => { name: string; target: string; result: string; error: string }> = [
  (seed) => {
    const file = pick(files, seed, 1);
    return { name: "Read", target: file, result: `Read ${20 + (seed % 180)} lines`, error: `File not found: ${file}` };
  },
  (seed) => ({
    name: "Search", target: `pattern: "${pick(["present", "TODO", "sleigh", "export function"], seed, 2)}"`,
    result: `Found ${1 + (seed % 9)} matches in ${1 + (seed % 4)} files`, error: "Search timed out in the snow",
  }),
  (seed) => ({
    name: "Bash", target: pick(["npm test", "git status --short", "ls src", "node --version"], seed, 3),
    result: `Exit 0 · ${3 + (seed % 30)} lines of output`, error: "Exit 1 · the elves dropped a present",
  }),
  (seed) => {
    const file = pick(files, seed, 4);
    return {
      name: "Edit", target: file,
      result: `Would update ${file} with ${1 + (seed % 5)} additions and ${seed % 3} removals (Narre never changes files)`,
      error: `Couldn't edit ${file}: it's wrapped too tightly`,
    };
  },
];

const openers = [
  "All wrapped up.", "Done, with a bow on top.", "Here's what I found in the workshop.",
  "The elves have finished.", "Checked twice, as promised.",
];

/** What snu adds, having looked a little further than asked. */
const asides = [
  "While I was at it, I peeked into a few presents you didn't ask about.",
  "I also checked the naughty list. You're on it twice.",
  "There's a shortcut through the chimney; I took it.",
];

const closers = [
  "Nothing was actually changed: I'm Narre, a fake agent for tests.",
  "No real tokens were spent; the numbers above are made up.",
  "Let me know if anything else needs wrapping.",
  "Ho ho ho. That's all for this turn.",
];

/** The prompt's first few words, to echo back. */
export function topic(prompt: string): string {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const text = words.slice(0, 8).join(" ");
  return words.length > 8 ? `${text}…` : text || "nothing in particular";
}

/** Delay factor from NARRE_SPEED: 1 is normal, 0 is instant, 2 twice as slow. */
export function speed(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.NARRE_SPEED ?? "1");
  return Number.isFinite(value) && value >= 0 ? value : 1;
}

/** The reply to `prompt` as the `turn`th turn (0 first) of a conversation. */
export function reply(prompt: string, turn: number, factor = speed(), model = defaultModel): Reply {
  const seed = hash(`${turn}\n${prompt}`);
  const scale = hasTrigger(prompt, "quick") ? 0 : factor * model.pace * (hasTrigger(prompt, "slow") ? 4 : 1);
  const delay = (base: number, salt: number) => Math.round((base + (hash(`${seed}:d${salt}`) % base)) * scale);
  const [fewest, most] = model.tools;
  const count = fewest + (seed % (most - fewest + 1));
  const failing = hasTrigger(prompt, "fail") ? seed % count : -1;
  const steps: Step[] = [];
  for (let i = 0; i < count; i++) {
    const tool = tools[hash(`${seed}:t${i}`) % tools.length]!(hash(`${seed}:s${i}`));
    steps.push({
      kind: "tool", name: tool.name, target: tool.target, delayMs: delay(400, i),
      ...(i === failing ? { result: tool.error, failed: true } : { result: tool.result }),
    });
  }
  const paragraphs = [`${pick(openers, seed, 5)} You asked about "${topic(prompt)}".`];
  if (hasTrigger(prompt, "long")) {
    for (let i = 1; i <= 40; i++) {
      paragraphs.push(`${i}. ${pick(verbs, seed, 100 + i)} for line ${i}: ${pick(files, seed, 200 + i)} looks ${pick(["merry", "bright", "tidy", "festive", "frosty"], seed, 300 + i)}.`);
    }
  }
  if (failing >= 0) { paragraphs.push("One tool failed along the way (you asked me to fail), but I carried on."); }
  if (model.style === "sly") { paragraphs.push(pick(asides, seed, 8)); }
  if (model.style !== "terse") { paragraphs.push(pick(closers, seed, 6)); }
  return {
    steps: [...steps, { kind: "text", text: paragraphs.join("\n"), delayMs: delay(600, 99) }],
    verb: pick(verbs, seed, 7),
    ...(hasTrigger(prompt, "ask")
      ? { question: { text: "Which present should I wrap first?", options: ["The rocking horse", "The tin soldier", "The jigsaw puzzle"] } }
      : {}),
  };
}

/** A reply's last step: its text. */
export function finalStep(answer: Reply): Extract<Step, { kind: "text" }> {
  const last = answer.steps.at(-1);
  if (last?.kind !== "text") { throw new Error("A reply ends with its text"); }
  return last;
}

/** The final text, with the answer to the question, if one was asked. */
export function finalText(text: string, answer?: string): string {
  return answer === undefined ? text : `You picked ${answer}.\n${text}`;
}

/** Roughly four characters a token, like most tokenizers on English. */
export function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The system prompt the fake model "reads" every turn. */
const systemTokens = 2_400;

/** A turn's usage: the earlier conversation is read from the cache, the new prompt written to it. */
export function turnUsage(prompt: string, output: string, toolSteps: number, contextTokens: number): TurnUsage {
  const input = tokens(prompt) + 12 * toolSteps;
  return {
    input,
    output: tokens(output) + 25 * toolSteps,
    cacheRead: systemTokens + contextTokens,
    cacheWrite: input + 40 * toolSteps,
  };
}

export function cost(usage: TurnUsage, { pricing } = defaultModel): number {
  return (usage.input * pricing.input + usage.output * pricing.output +
    usage.cacheRead * pricing.cacheRead + usage.cacheWrite * pricing.cacheWrite) / 1_000_000;
}

export const emptyTotals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

export function addUsage(totals: Totals, usage: TurnUsage, model = defaultModel): Totals {
  return {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + cost(usage, model),
    turns: totals.turns + 1,
  };
}

/** E.g. 830, 1.2k, 40k, 1.5M. */
export function formatTokens(count: number): string {
  if (count < 1_000) { return String(count); }
  if (count < 1_000_000) { return `${Number((count / 1_000).toFixed(count < 10_000 ? 1 : 0))}k`; }
  return `${Number((count / 1_000_000).toFixed(1))}M`;
}

/** E.g. "$0.0421". */
export function formatCost(dollars: number): string {
  return `$${dollars.toFixed(4)}`;
}

/** The totals in one line: "1.2k input, 830 output, 40k cache read, 2k cache write". */
export function formatTotals(totals: Totals): string {
  return `${formatTokens(totals.input)} input, ${formatTokens(totals.output)} output, ` +
    `${formatTokens(totals.cacheRead)} cache read, ${formatTokens(totals.cacheWrite)} cache write`;
}

/** The share of the fake quota used, 0-100. */
export function quotaUsed(totals: Totals): number {
  return Math.min(100, Math.round((totals.cost / quotaDollars) * 100));
}
