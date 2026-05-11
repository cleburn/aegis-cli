import assert from "node:assert/strict";
import test from "node:test";
import { applyHiddenInputChunk } from "../dist/src/config/api-key.js";

test("hidden input accepts pasted chunks without echo-state rendering", () => {
  const pasted = "sk-" + "a".repeat(80);
  const update = applyHiddenInputChunk("", pasted);
  assert.deepEqual(update, {
    input: pasted,
    submitted: false,
    canceled: false,
  });
});

test("hidden input handles backspace, submit, cancel, and bracketed paste markers", () => {
  let state = applyHiddenInputChunk("", "\u001b[200~secret-value\u001b[201~");
  assert.equal(state.input, "secret-value");
  state = applyHiddenInputChunk(state.input, "\u007F!");
  assert.equal(state.input, "secret-valu!");

  const submitted = applyHiddenInputChunk(state.input, "\rignored");
  assert.deepEqual(submitted, {
    input: "secret-valu!",
    submitted: true,
    canceled: false,
  });

  const canceled = applyHiddenInputChunk("partial", "\u0003");
  assert.deepEqual(canceled, {
    input: "partial",
    submitted: false,
    canceled: true,
  });
});
