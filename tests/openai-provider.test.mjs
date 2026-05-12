import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIProvider } from "../dist/src/llm/openai-compatible.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  jsonResponse,
  jsonRequestBody,
  openAIResponse,
  openAIResponseStream,
  withMockFetch,
} from "./helpers.mjs";

test("OpenAIProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(openAIResponse("pong")),
    () => jsonResponse({ error: { message: "bad key" } }, 401),
  ], async (calls) => {
    const provider = new OpenAIProvider("test-key", "gpt-test");
    assert.deepEqual(await provider.validate(), { ok: true });
    assertOpenAIRequest(jsonRequestBody(calls[0]), { maxOutputTokens: 16 });
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
    assertOpenAIRequest(jsonRequestBody(calls[1]), { maxOutputTokens: 16 });
  });
});

test("OpenAIProvider validate returns transport failure on timeout", async () => {
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
    const provider = new OpenAIProvider("test-key", "gpt-test", {
      validateTimeoutMs: 5,
    });
    const result = await provider.validate();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transport");
    assert.match(result.detail, /timed out after 0.005s/);
    assert.equal(requestSignal?.aborted, true);
    assertOpenAIRequest(jsonRequestBody(calls[0]), { maxOutputTokens: 16 });
  });
});

test("OpenAIProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(openAIResponse("hello")),
    () => jsonResponse(openAIResponse("{", "max_output_tokens")),
    () => openAIResponseStream("partial"),
  ], async (calls) => {
    const provider = new OpenAIProvider("test-key", "gpt-test");
    assert.equal(await provider.chat([{ role: "system", content: "note" }, { role: "user", content: "hi" }], "system"), "hello");
    assertOpenAIRequest(jsonRequestBody(calls[0]), { maxOutputTokens: 16384 });
    await assert.rejects(
      () => provider.chatJSON([{ role: "user", content: "json" }], "system"),
      MaxTokensError
    );
    assertOpenAIRequest(jsonRequestBody(calls[1]), { maxOutputTokens: 128000 });
    const tokens = [];
    const full = await provider.chatStream([{ role: "user", content: "stream" }], "system", (token) => tokens.push(token));
    assertOpenAIRequest(jsonRequestBody(calls[2]), { maxOutputTokens: 16384 });
    assert.match(full, /partial/);
    assert.match(full, new RegExp(TRUNCATION_NOTE_FRAGMENT));
    assert.ok(tokens.some((token) => token.includes(TRUNCATION_NOTE_FRAGMENT)));
  });
});

function assertOpenAIRequest(body, { maxOutputTokens }) {
  assert.equal(body.max_output_tokens, maxOutputTokens);
  assert.deepEqual(body.reasoning, { effort: "none" });
}
