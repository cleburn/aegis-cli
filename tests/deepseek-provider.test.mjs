import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekProvider } from "../dist/src/llm/openai-compatible.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  chatCompletion,
  chatCompletionStream,
  jsonResponse,
  withMockFetch,
} from "./helpers.mjs";

test("DeepSeekProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(chatCompletion("pong")),
    () => jsonResponse({ error: { message: "bad key" } }, 401),
  ], async () => {
    const provider = new DeepSeekProvider("deepseek-key", "deepseek-test");
    assert.deepEqual(await provider.validate(), { ok: true });
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
  });
});

test("DeepSeekProvider validate returns transport failure on timeout", async () => {
  let requestSignal;
  await withMockFetch([
    (_input, init) => {
      requestSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  ], async () => {
    const provider = new DeepSeekProvider("deepseek-key", "deepseek-test", {
      validateTimeoutMs: 5,
    });
    const result = await provider.validate();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transport");
    assert.match(result.detail, /timed out after 0.005s/);
    assert.equal(requestSignal?.aborted, true);
  });
});

test("DeepSeekProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(chatCompletion("hello")),
    () => jsonResponse(chatCompletion("{", "length")),
    () => chatCompletionStream("partial", "length"),
  ], async () => {
    const provider = new DeepSeekProvider("deepseek-key", "deepseek-test");
    assert.equal(await provider.chat([{ role: "system", content: "note" }, { role: "user", content: "hi" }], "system"), "hello");
    await assert.rejects(
      () => provider.chatJSON([{ role: "user", content: "json" }], "system"),
      MaxTokensError
    );
    const tokens = [];
    const full = await provider.chatStream([{ role: "user", content: "stream" }], "system", (token) => tokens.push(token));
    assert.match(full, /partial/);
    assert.match(full, new RegExp(TRUNCATION_NOTE_FRAGMENT));
    assert.ok(tokens.some((token) => token.includes(TRUNCATION_NOTE_FRAGMENT)));
  });
});
