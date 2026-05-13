import assert from "node:assert/strict";
import test from "node:test";
import {
  getStreamingResponseFrame,
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
  const frame = getStreamingResponseFrame(message, 80);

  assert.deepEqual(frame.committed, []);
  assert.deepEqual(frame.live, [{ text: message, showLabel: true }]);
});

test("streaming commits completed lines while keeping current line live", () => {
  const message = Array.from({ length: 4 }, (_, index) => `line-${index + 1}`).join("\n");
  const frame = getStreamingResponseFrame(message, 80);

  assert.deepEqual(frame.committed.map((line) => line.text), ["line-1", "line-2", "line-3"]);
  assert.deepEqual(frame.live.map((line) => line.text), ["line-4"]);
  assert.equal(frame.committed[0].showLabel, true);
  assert.ok(frame.committed.slice(1).every((line) => line.showLabel === false));
  assert.equal(frame.live[0].showLabel, false);
});

test("long streaming response incrementally commits across the full message", () => {
  const message = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
  const frame = getStreamingResponseFrame(message, 80);

  assert.deepEqual(frame.committed.map((line) => line.text), [
    "line-1",
    "line-2",
    "line-3",
    "line-4",
    "line-5",
    "line-6",
    "line-7",
    "line-8",
    "line-9",
    "line-10",
    "line-11",
  ]);
  assert.deepEqual(frame.live.map((line) => line.text), ["line-12"]);
  assert.equal(frame.committed[0].showLabel, true);
  assert.ok(frame.committed.slice(1).every((line) => line.showLabel === false));
});

test("streaming response recalculates its window for terminal resize", () => {
  const message = "alpha beta gamma delta epsilon zeta";
  const compact = getStreamingResponseFrame(message, 12);
  const expanded = getStreamingResponseFrame(message, 80);

  assert.ok(compact.committed.length > expanded.committed.length);
  assert.deepEqual(expanded.committed, []);
  assert.equal(expanded.live[0].showLabel, true);
});

test("final streaming frame commits all lines exactly once", () => {
  const message = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
  const frame = getStreamingResponseFrame(message, 80, true);

  assert.deepEqual(frame.live, []);
  assert.deepEqual(frame.committed.map((line) => line.text), wrapConversationTurn(message, 80).map((line) => line.text));
  assert.equal(new Set(frame.committed.map((line) => line.text)).size, 12);
});
