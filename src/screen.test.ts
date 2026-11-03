import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { emptyTotals } from "./fake.ts";
import {
  box, costLines, costPanel, elf, elfPixels, elfSvg, fit, footer, notification, notifyMode, terminalTitle, textWidth, truncate, welcome, wrap,
} from "./screen.ts";

test("measures, cuts and wraps by columns", () => {
  assert.equal(textWidth("\x1b[1mab\x1b[0m"), 2);
  assert.equal(textWidth("日本"), 4);
  assert.equal(stripVTControlCharacters(truncate("\x1b[31mabcdef\x1b[0m", 3)), "abc");
  assert.equal(textWidth(fit("ab", 5)), 5);
  assert.deepEqual(wrap("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrap("a\n\nb", 4), ["a", "", "b"]);
});

test("boxes, the welcome and the footer fit the width", () => {
  for (const width of [30, 80, 200]) {
    for (const line of box(["x".repeat(500)], width)) { assert.equal(textWidth(line), width); }
    for (const line of welcome(width, { cwd: "/workspace" })) { assert.ok(textWidth(line) <= width); }
    assert.ok(textWidth(footer(width, { cwd: "/workspace", branch: "main", totals: emptyTotals })) <= width);
  }
});

test("the elf is 18 columns by 8 lines, and icon.svg is drawn from it", () => {
  assert.ok(elfPixels.every((row) => row.length === 18));
  assert.deepEqual(elf().map(textWidth), Array(8).fill(18));
  assert.equal(readFileSync(join(import.meta.dirname, "..", "icon.svg"), "utf8"), elfSvg());
});

test("the /cost panel shows the usage", () => {
  const totals = { input: 1200, output: 830, cacheRead: 40_000, cacheWrite: 2000, cost: 1.04213, turns: 3 };
  for (const screen of [costPanel(totals, "3a3defb5-1111", 120), costLines(totals, undefined)].map((lines) => stripVTControlCharacters(lines.join("\n")))) {
    assert.match(screen, /Total cost:\s*\$1\.0421/);
    assert.match(screen, /Total tokens:\s*1\.2k input, 830 output, 40k cache read, 2k cache write/);
    assert.match(screen, /North Pole quota:.*21% used · resets Dec 25/);
  }
});

test("terminal signals: the title, the bell and OSC 9", () => {
  assert.equal(terminalTitle("✻ Narre: fix\x07 it\x1b[31m"), "\x1b]0;✻ Narre: fix  it\x07");
  assert.equal(notifyMode(undefined), "bell");
  assert.equal(notifyMode("nonsense"), "bell");
  assert.equal(notification("Done", "bell", false), "\x07");
  assert.equal(notification("Done", "osc9", false), "\x1b]9;Done\x07");
  assert.equal(notification("Done", "both", false), "\x07\x1b]9;Done\x07");
  assert.equal(notification("Done", "off", false), "");
  // Inside tmux, OSC 9 is wrapped in its passthrough, with the escape characters doubled.
  assert.equal(notification("Done", "osc9", true), "\x1bPtmux;\x1b\x1b]9;Done\x07\x1b\\");
});
