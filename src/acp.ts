// Narre over ACP, the Agent Client Protocol (agentclientprotocol.com), for editors that run an
// agent as a subprocess: `narre --acp`. JSON-RPC 2.0, one message per line on stdin and stdout,
// and nothing else on stdout. With `--port`, the same over TCP instead, a session per connection.
//
// It answers initialize, authenticate, session/new, session/load (replaying the conversation),
// session/prompt, session/cancel and session/set_config_option (the model), and sends each reply
// as session/update notifications: its tool calls as they run, then the answer in chunks. A
// question (`ask`) becomes a session/request_permission with an option per answer.
// Conversations are saved and hooks run as in the interactive mode.
//
// The protocol's types come from the official SDK, @agentclientprotocol/sdk (stable v1), as types
// only: they're checked when building, and Narre needs nothing but Node to run.

import type {
  ContentBlock, InitializeResponse, LoadSessionResponse, NewSessionResponse, PromptResponse, ProtocolVersion,
  RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification, SessionUpdate,
  SetSessionConfigOptionResponse, ToolCall, ToolCallContent, ToolKind,
} from "@agentclientprotocol/sdk";
import { createServer, type AddressInfo, type Server } from "node:net";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addUsage, defaultModel, finalStep, finalText, findModel, models, reply, speed, turnUsage,
  type Model, type Question, type Step, type Totals,
} from "./fake.ts";
import { hookRunner, loadHooks } from "./hooks.ts";
import { contextTokens, loadInstructions, type Instructions } from "./instructions.ts";
import { findConversation, loadConversation, newConversation, saveTurn, totalsOf, type Conversation, type StoredStep } from "./store.ts";
import { version } from "./version.ts";

export const protocolVersion: ProtocolVersion = 1;

type Id = number | string;
type Message = {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

/** A JSON-RPC error, sent back as the response's `error`. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
const invalidParams = (message: string) => new RpcError(-32602, message);

type Session = {
  conversation: Conversation;
  cwd: string;
  model: Model;
  instructions: Instructions[];
  fire: ReturnType<typeof hookRunner>;
  totals: Totals;
  /** Set while a prompt runs; session/cancel aborts it. */
  controller?: AbortController;
};

type ToolStep = Pick<Extract<Step, { kind: "tool" }>, "name" | "target"> | StoredStep;

/** ACP's tool kinds for Narre's fake tools. */
const toolKinds: Record<string, ToolKind> = { Read: "read", Search: "search", Bash: "execute", Edit: "edit" };

const textContent = (text: string): ToolCallContent[] => [{ type: "content", content: { type: "text", text } }];

/** The text of a prompt's content blocks: text as is, resources by their link or text. */
export function promptText(blocks: unknown): string {
  if (!Array.isArray(blocks)) { throw invalidParams("prompt must be a list of content blocks"); }
  return (blocks as Array<ContentBlock | null>).map((block) => {
    if (block?.type === "text") { return String(block.text ?? ""); }
    if (block?.type === "resource_link") { return `@${block.uri}`; }
    if (block?.type === "resource") { return "text" in block.resource ? block.resource.text : `@${block.resource.uri}`; }
    return "";
  }).filter(Boolean).join("\n");
}

/** Serves ACP on `input` and `output` (stdin and stdout by default) until the input ends. */
export function runAcp(options: { model?: Model; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const { input = process.stdin, output = process.stdout } = options;
  const sessions = new Map<string, Session>();
  const pending = new Map<Id, (message: Message) => void>();
  let nextId = 0;

  const send = (message: Omit<Message, "jsonrpc">) => {
    // A client that has gone away can't be told anything more.
    if ((output as { writable?: boolean }).writable !== false) { output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
  };
  const request = (method: string, params: Record<string, unknown>) => new Promise<Message>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
  const update = (session: Session, change: SessionUpdate) => {
    const params: SessionNotification = { sessionId: session.conversation.id, update: change };
    send({ method: "session/update", params });
  };

  /** The session's configuration: only the model, as a select. */
  const configOptions = (model: Model): SessionConfigOption[] => [{
    id: "model", name: "Model", category: "model", type: "select", currentValue: model.id,
    options: models.map((known) => ({ value: known.id, name: known.id, description: known.description })),
  }];

  const toolCall = (session: Session, id: string, step: ToolStep): ToolCall => ({
    toolCallId: id,
    title: `${step.name} ${step.target}`,
    kind: toolKinds[step.name] ?? "other",
    rawInput: { target: step.target },
    ...(step.name === "Read" || step.name === "Edit" ? { locations: [{ path: join(session.cwd, step.target) }] } : {}),
  });

  const open = (conversation: Conversation, cwd: string): Session => {
    const model = options.model ?? findModel(conversation.turns.at(-1)?.model) ?? defaultModel;
    const fire = hookRunner(loadHooks(cwd), cwd);
    const session: Session = { conversation, cwd, model, instructions: loadInstructions(cwd), fire, totals: totalsOf(conversation.turns) };
    sessions.set(conversation.id, session);
    void fire("SessionStart", conversation, { source: conversation.turns.length ? "resume" : "startup", model: model.id });
    return session;
  };

  const sessionOf = (params: Message["params"]): Session => {
    const session = sessions.get(String(params?.sessionId));
    if (!session) { throw invalidParams(`No session ${String(params?.sessionId)}`); }
    return session;
  };

  const cwdOf = (params: Message["params"]): string => {
    const cwd = params?.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) { throw invalidParams("cwd must be an absolute path"); }
    return cwd;
  };

  /** session/load: the conversation so far, as the updates it was first sent as. */
  const replay = (session: Session) => {
    session.conversation.turns.forEach((turn, n) => {
      update(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text: turn.prompt } });
      turn.steps.forEach((step, i) => update(session, {
        sessionUpdate: "tool_call", ...toolCall(session, `${n}-${i}`, step),
        status: step.failed ? "failed" : "completed", content: textContent(step.result),
      }));
      if (turn.text) { update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.text } }); }
    });
  };

  /** Asks the client to pick an answer; undefined when it doesn't. */
  const ask = async (session: Session, id: string, question: Question, signal: AbortSignal): Promise<string | undefined> => {
    void session.fire("Notification", session.conversation, { message: `Narre needs your input: ${question.text}`, notification_type: "question" });
    const params: RequestPermissionRequest = {
      sessionId: session.conversation.id,
      toolCall: { toolCallId: id, title: question.text, kind: "other", status: "pending" },
      options: question.options.map((option, i) => ({ optionId: String(i + 1), name: option, kind: "allow_once" })),
    };
    const answered = request("session/request_permission", params);
    const cancelled = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const response = await Promise.race([answered, cancelled]);
    const outcome = (response.result as RequestPermissionResponse | undefined)?.outcome;
    if (signal.aborted) { throw signal.reason; }
    return outcome?.outcome === "selected" ? question.options[Number(outcome.optionId) - 1] : undefined;
  };

  const prompt = async (session: Session, params: Message["params"]): Promise<PromptResponse> => {
    if (session.controller) { throw invalidParams("This session is already working on a prompt"); }
    const text = promptText(params?.prompt);
    const controller = new AbortController();
    session.controller = controller;
    const { conversation, fire } = session;
    // The model the turn started with, even if the client switches while it works.
    const model = session.model;
    try {
      const submitted = await fire("UserPromptSubmit", conversation, { prompt: text });
      if (submitted.blocked) {
        update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `A UserPromptSubmit hook blocked the prompt${submitted.reason ? `: ${submitted.reason}` : ""}` } });
        return { stopReason: "refusal" };
      }
      const answer = reply(text, conversation.turns.length, speed(), model);
      const turn = conversation.turns.length;
      const steps: StoredStep[] = [];
      let final = "";
      let cancelled = false;
      try {
        for (const [i, step] of answer.steps.entries()) {
          if (step.kind !== "tool") { continue; }
          const id = `${turn}-${i}`;
          const toolInput = { target: step.target };
          update(session, { sessionUpdate: "tool_call", ...toolCall(session, id, step), status: "pending" });
          void fire("PreToolUse", conversation, { tool_name: step.name, tool_input: toolInput });
          update(session, { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
          await sleep(step.delayMs, undefined, { signal: controller.signal });
          const stored: StoredStep = { name: step.name, target: step.target, result: step.result, ...(step.failed ? { failed: true } : {}) };
          steps.push(stored);
          update(session, { sessionUpdate: "tool_call_update", toolCallId: id, status: step.failed ? "failed" : "completed", content: textContent(step.result) });
          void fire("PostToolUse", conversation, { tool_name: step.name, tool_input: toolInput, tool_response: { result: step.result, failed: !!step.failed } });
        }
        const picked = answer.question ? await ask(session, `${turn}-question`, answer.question, controller.signal) : undefined;
        const last = finalStep(answer);
        const full = finalText(last.text, picked ?? answer.question?.options[0]);
        // The answer in chunks of a few words, spread over the reply's delay.
        const chunks = full.match(/(?:\S+\s*){1,4}/g) ?? [full];
        for (const chunk of chunks) {
          await sleep(Math.round(last.delayMs / chunks.length), undefined, { signal: controller.signal });
          update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
        }
        final = full;
      } catch {
        cancelled = true;
      }
      const usage = turnUsage(text, final, steps.length, contextTokens(conversation.turns, session.instructions));
      saveTurn(conversation, { prompt: text, steps, text: final, usage, model: model.id, ...(cancelled ? { interrupted: true } : {}), at: new Date().toISOString() });
      session.totals = addUsage(session.totals, usage, model);
      // Like other agents, not when the user interrupted.
      if (!cancelled) { void fire("Stop", conversation); }
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    } finally {
      session.controller = undefined;
    }
  };

  const dispatch = async (method: string, params: Message["params"]): Promise<unknown> => {
    switch (method) {
      case "initialize":
        return {
          protocolVersion,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
          authMethods: [],
          agentInfo: { name: "narre", title: "Narre", version },
        } satisfies InitializeResponse;
      case "authenticate":
        return {};
      case "session/new": {
        const cwd = cwdOf(params);
        const session = open(newConversation(cwd), cwd);
        return { sessionId: session.conversation.id, configOptions: configOptions(session.model) } satisfies NewSessionResponse;
      }
      case "session/load": {
        const cwd = cwdOf(params);
        const file = findConversation(String(params?.sessionId));
        if (!file) { throw invalidParams(`No conversation with id ${String(params?.sessionId)}`); }
        const session = open(loadConversation(file), cwd);
        replay(session);
        return { configOptions: configOptions(session.model) } satisfies LoadSessionResponse;
      }
      case "session/prompt":
        return prompt(sessionOf(params), params);
      case "session/cancel":
        sessionOf(params).controller?.abort();
        return null;
      case "session/set_config_option": {
        const session = sessionOf(params);
        if (params?.configId !== "model") { throw invalidParams(`No configuration option ${String(params?.configId)}; there's only model`); }
        const model = findModel(String(params?.value));
        if (!model) { throw invalidParams(`No model called ${String(params?.value)}; choose ${models.map((known) => known.id).join(", ")}`); }
        session.model = model;
        return { configOptions: configOptions(model) } satisfies SetSessionConfigOptionResponse;
      }
      default:
        throw new RpcError(-32601, `Narre doesn't know the method ${method}`);
    }
  };

  const handle = async (message: Message) => {
    if (message.method === undefined) {
      // A response to one of Narre's own requests.
      if (message.id !== undefined && message.id !== null) {
        pending.get(message.id)?.(message);
        pending.delete(message.id);
      }
      return;
    }
    const { id, method, params } = message;
    try {
      const result = await dispatch(method, params);
      if (id !== undefined && id !== null) { send({ id, result: result ?? null }); }
    } catch (error) {
      if (id === undefined || id === null) { return; }
      send({ id, error: error instanceof RpcError ? { code: error.code, message: error.message } : { code: -32603, message: (error as Error).message } });
    }
  };

  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) { return; }
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        send({ id: null, error: { code: -32700, message: "Not valid JSON" } });
        return;
      }
      // Messages are handled side by side: a prompt waits for answers that come in later lines.
      void handle(message);
    });
    lines.on("close", async () => {
      for (const session of sessions.values()) { session.controller?.abort(); }
      await Promise.all([...sessions.values()].map((session) => session.fire("SessionEnd", session.conversation, { reason: "other" })));
      resolve();
    });
  });
}

/** `--port`: ACP over TCP, like stdin and stdout but a session per connection. */
export function serveAcp(options: { model?: Model; port: number; host: string }): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    void runAcp({ model: options.model, input: socket, output: socket }).then(() => socket.end());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const { address, port } = server.address() as AddressInfo;
      process.stderr.write(`narre: ACP on ${address}:${port}\n`);
      resolve(server);
    });
  });
}
