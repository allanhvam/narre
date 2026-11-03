import assert from "node:assert/strict";
import { test } from "node:test";
import { addUsage, cost, emptyTotals, finalText, formatCost, formatTokens, formatTotals, hasTrigger, quotaUsed, reply, speed, turnUsage } from "./fake.ts";

test("replies are deterministic per prompt and turn", () => {
  assert.deepEqual(reply("fix the build", 0), reply("fix the build", 0));
  assert.notDeepEqual(reply("fix the build", 0), reply("fix the build", 1));
  const answer = reply("fix the build", 0, 1);
  assert.equal(answer.steps.at(-1)?.kind, "text");
  assert.ok(answer.steps.some((step) => step.kind === "tool"));
  assert.match((answer.steps.at(-1) as { text: string }).text, /You asked about "fix the build"/);
});

test("prompt words change the reply", () => {
  assert.ok(hasTrigger("Please ASK me", "ask"));
  assert.ok(!hasTrigger("basket", "ask"));
  assert.ok(reply("ask me", 0).question);
  assert.equal(reply("hello", 0).question, undefined);
  assert.ok(reply("make it fail", 0).steps.some((step) => step.kind === "tool" && step.failed));
  assert.ok((reply("a long one", 0).steps.at(-1) as { text: string }).text.split("\n").length > 40);
  assert.ok(reply("quick", 0, 5).steps.every((step) => step.delayMs === 0));
  const normal = reply("x", 0, 1).steps.reduce((sum, step) => sum + step.delayMs, 0);
  const slow = reply("x slow", 0, 1).steps.reduce((sum, step) => sum + step.delayMs, 0);
  assert.ok(slow > normal);
  assert.ok(reply("x", 0, 0).steps.every((step) => step.delayMs === 0));
});

test("NARRE_SPEED sets the pace, defaulting to 1", () => {
  assert.equal(speed({}), 1);
  assert.equal(speed({ NARRE_SPEED: "0" }), 0);
  assert.equal(speed({ NARRE_SPEED: "nope" }), 1);
});

test("the answer to a question leads the final text", () => {
  assert.equal(finalText("Done.", "The tin soldier"), "You picked The tin soldier.\nDone.");
  assert.equal(finalText("Done."), "Done.");
});

test("usage grows with the conversation and costs by the fake prices", () => {
  const first = turnUsage("hello", "world", 1, 0);
  const second = turnUsage("hello", "world", 1, first.input + first.output);
  assert.ok(second.cacheRead > first.cacheRead);
  assert.equal(cost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 3);
  assert.equal(cost({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 15);
  const totals = addUsage(addUsage(emptyTotals, first), second);
  assert.equal(totals.turns, 2);
  assert.equal(totals.input, first.input + second.input);
  assert.ok(Math.abs(totals.cost - cost(first) - cost(second)) < 1e-12);
});

test("formats tokens and cost like the real agents", () => {
  assert.equal(formatTokens(830), "830");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(40_400), "40k");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatCost(0.04213), "$0.0421");
  assert.equal(formatTotals({ ...emptyTotals, input: 1200, output: 830, cacheRead: 40_000, cacheWrite: 2000 }),
    "1.2k input, 830 output, 40k cache read, 2k cache write");
  assert.equal(quotaUsed({ ...emptyTotals, cost: 1 }), 20);
  assert.equal(quotaUsed({ ...emptyTotals, cost: 50 }), 100);
});
