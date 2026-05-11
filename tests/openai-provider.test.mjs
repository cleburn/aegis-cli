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
    assert.equal(jsonRequestBody(calls[0]).max_output_tokens, 16);
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
    assert.equal(jsonRequestBody(calls[1]).max_output_tokens, 16);
  });
});

test("OpenAIProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(openAIResponse("hello")),
    () => jsonResponse(openAIResponse("{", "max_output_tokens")),
    () => openAIResponseStream("partial"),
  ], async () => {
    const provider = new OpenAIProvider("test-key", "gpt-test");
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
