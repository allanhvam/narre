import { client, methods, ndJsonStream, type ClientContext, type RequestPermissionRequest, type RequestPermissionResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { promptText } from "./acp.ts";

// Narre's ACP is checked with the official SDK's client, which validates every message Narre
// sends against the protocol's schemas.

/** narre.ts next to this file in src/, narre.js in dist/. */
const narre = join(import.meta.dirname, `narre${import.meta.filename.slice(-3)}`);

function folder(t: TestContext) {
  // The real path: on macOS the temporary folder is behind a symlink (/var is /private/var), and
  // Narre's working directory is always the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "narre-acp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  return { cwd, home: join(root, "home") };
}

type Project = ReturnType<typeof folder>;

function start(t: TestContext, project: Project, args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [narre, ...args], {
    cwd: project.cwd, env: { ...process.env, NARRE_HOME: project.home, NARRE_SPEED: "0", ...env },
  });
  t.after(() => child.kill());
  return child;
}

/**
 * Runs `work` as an ACP client connected to `input` and `output`, collecting the session
 * updates, and answering permission requests with `answer` (cancelled by default).
 */
async function connect<T>(
  input: Readable, output: Writable,
  work: (agent: ClientContext, updates: SessionUpdate[]) => Promise<T>,
  answer: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({ outcome: { outcome: "cancelled" } }),
): Promise<T> {
  const updates: SessionUpdate[] = [];
  const app = client({ name: "narre-tests" })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update); })
    .onRequest(methods.client.session.requestPermission, ({ params }) => answer(params));
  const stream = ndJsonStream(Writable.toWeb(output) as WritableStream<Uint8Array>, Readable.toWeb(input) as ReadableStream<Uint8Array>);
  return app.connectWith(stream, (agent) => work(agent, updates));
}

/** `narre --acp` on stdin and stdout, as an editor runs it. */
async function overStdio<T>(t: TestContext, project: Project, work: Parameters<typeof connect<T>>[2], options: {
  env?: NodeJS.ProcessEnv; answer?: Parameters<typeof connect<T>>[3];
} = {}): Promise<T> {
  const child = start(t, project, ["--acp"], options.env);
  const closed = new Promise((resolve) => child.on("close", resolve));
  const result = await connect(child.stdout, child.stdin, work, options.answer);
  child.stdin.end();
  await closed;
  return result;
}

const initialize = (agent: ClientContext) => agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
const text = (updates: SessionUpdate[]) =>
  updates.flatMap((update) => update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? [update.content.text] : []).join("");
const failure = (code: number) => (error: unknown) => (error as { code?: number }).code === code;

test("prompt content blocks become one prompt", () => {
  assert.equal(promptText([{ type: "text", text: "fix" }, { type: "resource_link", uri: "file:///a.ts", name: "a.ts" }, { type: "image", data: "", mimeType: "image/png" }]), "fix\n@file:///a.ts");
  assert.throws(() => promptText("fix"), /list of content blocks/);
});

test("initialize, a new session and a prompt with tool calls, a question and a streamed answer", async (t) => {
  const project = folder(t);
  let asked: RequestPermissionRequest | undefined;
  await overStdio(t, project, async (agent, updates) => {
    const initialized = await initialize(agent);
    assert.equal(initialized.protocolVersion, 1);
    assert.equal(initialized.agentCapabilities?.loadSession, true);
    assert.equal(initialized.agentInfo?.name, "narre");

    const created = await agent.request(methods.agent.session.new, { cwd: project.cwd, mcpServers: [] });
    const [model] = created.configOptions ?? [];
    assert.equal(model?.id, "model");
    assert.equal(model?.type === "select" && model.currentValue, "nar-1.0");

    const prompted = await agent.request(methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "ask about the presents" }] });
    assert.equal(prompted.stopReason, "end_turn");

    const calls = updates.filter((update) => update.sessionUpdate === "tool_call");
    assert.ok(calls.length >= 1 && calls.every((call) => call.status === "pending" && call.kind));
    const finished = updates.filter((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
    assert.equal(finished.length, calls.length);
    assert.ok(updates.filter((update) => update.sessionUpdate === "agent_message_chunk").length > 1);
    assert.match(text(updates), /^You picked The tin soldier\./);
    assert.match(text(updates), /You asked about "ask about the presents"/);

    await assert.rejects(agent.request("session/fly", {}), failure(-32601));
    await assert.rejects(agent.request(methods.agent.session.new, { cwd: "project", mcpServers: [] }), failure(-32602));
  }, { answer: (request) => { asked = request; return { outcome: { outcome: "selected", optionId: "2" } }; } });
  assert.deepEqual(asked?.options.map((option) => option.name), ["The rocking horse", "The tin soldier", "The jigsaw puzzle"]);
});

test("session/cancel stops a prompt", async (t) => {
  const project = folder(t);
  await overStdio(t, project, async (agent, updates) => {
    await initialize(agent);
    const { sessionId } = await agent.request(methods.agent.session.new, { cwd: project.cwd, mcpServers: [] });
    const prompted = agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow work" }] });
    while (!updates.some((update) => update.sessionUpdate === "tool_call")) { await new Promise((resolve) => setTimeout(resolve, 10)); }
    await agent.notify(methods.agent.session.cancel, { sessionId });
    assert.equal((await prompted).stopReason, "cancelled");
  }, { env: { NARRE_SPEED: "1" } });
});

test("session/load replays the conversation, and session/set_config_option switches models", async (t) => {
  const project = folder(t);
  const { sessionId, answered } = await overStdio(t, project, async (agent, updates) => {
    await initialize(agent);
    const { sessionId } = await agent.request(methods.agent.session.new, { cwd: project.cwd, mcpServers: [] });
    const set = await agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "dum-1.0" });
    assert.equal(set.configOptions[0]?.type === "select" && set.configOptions[0].currentValue, "dum-1.0");
    await assert.rejects(agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "model", value: "smart-9" }), failure(-32602));
    await assert.rejects(agent.request(methods.agent.session.setConfigOption, { sessionId, configId: "mood", value: "merry" }), failure(-32602));
    await agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
    return { sessionId, answered: text(updates) };
  });

  await overStdio(t, project, async (agent, updates) => {
    await initialize(agent);
    const loaded = await agent.request(methods.agent.session.load, { sessionId, cwd: project.cwd, mcpServers: [] });
    assert.equal(loaded.configOptions?.[0]?.type === "select" && loaded.configOptions[0].currentValue, "dum-1.0");
    const [first] = updates;
    assert.equal(first?.sessionUpdate === "user_message_chunk" && first.content.type === "text" && first.content.text, "hello");
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call" && update.status === "completed"));
    assert.equal(text(updates), answered);
    await assert.rejects(agent.request(methods.agent.session.load, { sessionId: "nope", cwd: project.cwd, mcpServers: [] }), failure(-32602));
  });
});

test("--port serves ACP over TCP, a session per connection", async (t) => {
  const project = folder(t);
  const server = start(t, project, ["--acp", "--port", "0"]);
  const port = await new Promise<number>((resolve, reject) => {
    let output = "";
    server.stderr.setEncoding("utf8").on("data", (data: string) => {
      output += data;
      const match = /ACP on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) { resolve(Number(match[1])); }
    });
    server.on("exit", (code) => reject(new Error(`exited with ${code}: ${output}`)));
  });
  const overTcp = async <T>(work: Parameters<typeof connect<T>>[2]) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    try {
      return await connect(socket, socket, work);
    } finally {
      socket.end();
    }
  };

  // The second connection starts while the first is still open.
  await overTcp(async (first) => {
    await initialize(first);
    const one = (await first.request(methods.agent.session.new, { cwd: project.cwd, mcpServers: [] })).sessionId;
    const two = await overTcp(async (second) => {
      await initialize(second);
      const created = (await second.request(methods.agent.session.new, { cwd: project.cwd, mcpServers: [] })).sessionId;
      // A connection only knows its own sessions.
      await assert.rejects(second.request(methods.agent.session.prompt, { sessionId: one, prompt: [{ type: "text", text: "hello" }] }), failure(-32602));
      return created;
    });
    assert.notEqual(one, two);
    assert.equal((await first.request(methods.agent.session.prompt, { sessionId: one, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn");
  });
});

test("--port can't go with --stdio, and must be a port number", async () => {
  const run = (args: string[]) => promisify(execFile)(process.execPath, [narre, "--acp", ...args])
    .then(() => undefined, (error: { code: number; stderr: string }) => error);
  const both = await run(["--stdio", "--port", "3000"]);
  assert.equal(both?.code, 1);
  assert.match(both!.stderr, /--stdio and --port can't be used together/);
  const wrong = await run(["--port", "lots"]);
  assert.equal(wrong?.code, 1);
  assert.match(wrong!.stderr, /--port must be a number from 0 to 65535, not lots/);
});
