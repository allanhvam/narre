// Narre's saved conversations, one JSONL file each, kept per working directory:
// $NARRE_HOME (default ~/.narre)/projects/<cwd with non-alphanumerics as ->/<id>.jsonl.
// The first line describes the conversation, each further line is one turn.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addUsage, defaultModel, emptyTotals, findModel, type Totals, type TurnUsage } from "./fake.ts";

export type StoredStep = { name: string; target: string; result: string; failed?: boolean };

export type StoredTurn = {
  prompt: string;
  steps: StoredStep[];
  /** The final answer; empty when interrupted before it. */
  text: string;
  usage: TurnUsage;
  /** The model's id; turns saved before there were models are the default's. */
  model?: string;
  interrupted?: boolean;
  at: string;
};

export type Conversation = { id: string; cwd: string; created: string; file: string; turns: StoredTurn[] };

export function narreHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.NARRE_HOME || join(homedir(), ".narre");
}

export function projectDirectory(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(narreHome(env), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

/** A new conversation; its file is written with the first turn, so empty ones aren't kept. */
export function newConversation(cwd: string, env: NodeJS.ProcessEnv = process.env): Conversation {
  const id = randomUUID();
  return { id, cwd, created: new Date().toISOString(), file: join(projectDirectory(cwd, env), `${id}.jsonl`), turns: [] };
}

export function saveTurn(conversation: Conversation, turn: StoredTurn): void {
  if (!existsSync(conversation.file)) {
    mkdirSync(join(conversation.file, ".."), { recursive: true });
    writeFileSync(conversation.file, JSON.stringify({ type: "conversation", id: conversation.id, cwd: conversation.cwd, created: conversation.created }) + "\n");
  }
  appendFileSync(conversation.file, JSON.stringify({ type: "turn", ...turn }) + "\n");
  conversation.turns.push(turn);
}

export function loadConversation(file: string): Conversation {
  const [first, ...rest] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (first?.type !== "conversation" || typeof first.id !== "string") {
    throw new Error(`${file} isn't a Narre conversation`);
  }
  const turns = rest.filter((line) => line.type === "turn").map((line) => { const turn = { ...line }; delete turn.type; return turn as StoredTurn; });
  return { id: first.id, cwd: String(first.cwd), created: String(first.created), file, turns };
}

/** The file of the conversation in `cwd` that changed last, if any. */
export function latestConversation(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directory = projectDirectory(cwd, env);
  if (!existsSync(directory)) { return undefined; }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => ({ file: join(directory, name), time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time)[0]?.file;
}

/** A conversation's file by id, in any directory, so a moved one can still be resumed. */
export function findConversation(id: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!/^[A-Za-z0-9-]+$/.test(id)) { return undefined; }
  const root = join(narreHome(env), "projects");
  if (!existsSync(root)) { return undefined; }
  return readdirSync(root).map((directory) => join(root, directory, `${id}.jsonl`)).find((file) => existsSync(file));
}

export function totalsOf(turns: readonly StoredTurn[]): Totals {
  return turns.reduce((totals, turn) => addUsage(totals, turn.usage, findModel(turn.model) ?? defaultModel), emptyTotals);
}
