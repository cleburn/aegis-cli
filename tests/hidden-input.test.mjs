import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  applyHiddenInputChunk,
  promptHiddenInput,
} from "../dist/src/config/api-key.js";

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

test("hidden prompt never writes pasted content to stdout", async () => {
  const stdin = new FakeInput();
  const stdout = new FakeOutput();
  const plainPaste = "sk-" + "plain".repeat(16);
  const bracketedPaste = "\u001b[200~sk-" + "wrapped".repeat(12) + "\u001b[201~";
  const prompt = promptHiddenInput("  API key: ", stdin, stdout);

  assert.deepEqual(stdin.rawModeCalls, [true]);
  stdin.emit("data", Buffer.from(plainPaste));
  stdin.emit("data", Buffer.from(bracketedPaste));
  stdin.emit("data", Buffer.from("\r"));

  const captured = await prompt;
  assert.equal(
    captured,
    plainPaste + bracketedPaste.replace("\u001b[200~", "").replace("\u001b[201~", "")
  );
  assert.equal(
    stdout.output,
    "  API key: (input hidden - paste your key and press Enter)\n\n"
  );
  assert.equal(stdout.output.includes(plainPaste), false);
  assert.equal(stdout.output.includes("wrapped"), false);
  assert.deepEqual(stdin.rawModeCalls, [true, false]);
});

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModeCalls = [];

  setRawMode(value) {
    this.rawModeCalls.push(value);
    this.isRaw = value;
  }
}

class FakeOutput {
  output = "";

  write(chunk) {
    this.output += chunk;
    return true;
  }
}
