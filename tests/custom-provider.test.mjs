import assert from "node:assert/strict";
import test from "node:test";
import { CustomProvider } from "../dist/src/llm/openai-compatible.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  chatCompletion,
  chatCompletionStream,
  jsonResponse,
  withMockFetch,
} from "./helpers.mjs";

test("CustomProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(chatCompletion("pong")),
    () => jsonResponse({ error: { message: "bad key" } }, 401),
  ], async (calls) => {
    const provider = new CustomProvider("http://localhost:11434/v1", undefined, "llama3");
    assert.deepEqual(await provider.validate(), { ok: true });
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), null);
    }
  });
});

test("CustomProvider validate returns transport failure on timeout without Authorization", async () => {
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
  ], async (calls) => {
    const provider = new CustomProvider(
      "http://localhost:11434/v1",
      undefined,
      "llama3",
      { validateTimeoutMs: 5 }
    );
    const result = await provider.validate();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transport");
    assert.match(result.detail, /timed out after 0.005s/);
    assert.equal(requestSignal?.aborted, true);
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("authorization"), null);
  });
});

test("CustomProvider handles chat, JSON truncation, and stream truncation without Authorization", async () => {
  await withMockFetch([
    () => jsonResponse(chatCompletion("hello")),
    () => jsonResponse(chatCompletion("{", "length")),
    () => chatCompletionStream("partial", "length"),
  ], async (calls) => {
    const provider = new CustomProvider("http://localhost:11434/v1", undefined, "llama3");
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
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), null);
    }
  });
});
