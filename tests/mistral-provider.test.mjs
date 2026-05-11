import assert from "node:assert/strict";
import test from "node:test";
import { MistralProvider } from "../dist/src/llm/mistral.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  jsonResponse,
  jsonRequestBody,
  mistralResponse,
  mistralStream,
  withMockFetch,
} from "./helpers.mjs";

test("MistralProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(mistralResponse("pong")),
    () => jsonResponse({ message: "bad key" }, 401),
  ], async (calls) => {
    const provider = new MistralProvider("test-key", "mistral-test");
    assert.deepEqual(await provider.validate(), { ok: true });
    assert.equal(validateMaxTokens(jsonRequestBody(calls[0])), 32);
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
    assert.equal(validateMaxTokens(jsonRequestBody(calls[1])), 32);
  });
});

test("MistralProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(mistralResponse("hello")),
    () => jsonResponse(mistralResponse("{", "length")),
    () => mistralStream("partial", "length"),
  ], async () => {
    const provider = new MistralProvider("test-key", "mistral-test");
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

function validateMaxTokens(body) {
  return body.max_tokens ?? body.maxTokens;
}
