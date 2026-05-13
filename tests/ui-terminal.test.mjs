import assert from "node:assert/strict";
import test from "node:test";
import {
  getStreamingLineLimit,
  getStreamingResponseLines,
  nextThinkingFrameIndex,
  wrapConversationTurn,
  wrapText,
} from "../dist/src/ui/terminal.js";

test("user turn wrapping preserves full long submitted text", () => {
  const message =
    "yes, walk through the migration cleanly - nothing else to change this session.";
  const lines = wrapConversationTurn(message, 28);

  assert.equal(lines[0].showLabel, true);
  assert.ok(lines.slice(1).every((line) => line.showLabel === false));
  assert.equal(lines.map((line) => line.text).join(" "), message);
  assert.ok(lines.length > 1);
});

test("short user turn wrapping stays single-line", () => {
  const lines = wrapConversationTurn("yes", 28);
  assert.deepEqual(lines, [{ text: "yes", showLabel: true }]);
});

test("wrapping breaks long unspaced input instead of clipping it", () => {
  const message = "abcdefghijklmnopqrstuvwxyz";
  const wrapped = wrapText(message, 8).split("\n");

  assert.deepEqual(wrapped, ["abcdefgh", "ijklmnop", "qrstuvwx", "yz"]);
  assert.equal(wrapped.join(""), message);
});

test("extraction thinking frames keep looping until unmounted", () => {
  let index = 0;
  for (let i = 0; i < 20; i += 1) {
    index = nextThinkingFrameIndex("extraction", index, 5);
  }

  assert.equal(index, 0);
  assert.equal(nextThinkingFrameIndex("extraction", 4, 5), 0);
});

test("thinking frames loop", () => {
  let index = 0;
  for (let i = 0; i < 5; i += 1) {
    index = nextThinkingFrameIndex("thinking", index, 3);
  }

  assert.equal(index, 2);
  assert.equal(nextThinkingFrameIndex("thinking", index, 3), 0);
});

test("short streaming response keeps full dynamic render", () => {
  const message = "Short streamed response.";
  const lines = getStreamingResponseLines(message, 80, 24);

  assert.deepEqual(lines, [{ text: message, showLabel: true }]);
});

test("long streaming response is bounded to the live tail", () => {
  const message = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
  const lines = getStreamingResponseLines(message, 80, 10);

  assert.equal(getStreamingLineLimit(10), 3);
  assert.deepEqual(lines.map((line) => line.text), ["line-10", "line-11", "line-12"]);
  assert.ok(lines.every((line) => line.showLabel === false));
});

test("streaming response recalculates its window for terminal resize", () => {
  const message = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
  const compact = getStreamingResponseLines(message, 80, 10);
  const expanded = getStreamingResponseLines(message, 80, 20);

  assert.equal(compact.length, 3);
  assert.equal(expanded.length, 12);
  assert.equal(expanded[0].showLabel, true);
});
