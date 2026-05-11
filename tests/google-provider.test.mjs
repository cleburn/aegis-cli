import assert from "node:assert/strict";
import test from "node:test";
import { GoogleProvider } from "../dist/src/llm/google.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  googleResponse,
  googleStream,
  jsonResponse,
  jsonRequestBody,
  withMockFetch,
} from "./helpers.mjs";

test("GoogleProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(googleResponse("pong")),
    () => jsonResponse({ error: { code: 401, message: "bad key" } }, 401),
  ], async (calls) => {
    const provider = new GoogleProvider("test-key", "gemini-test");
    assert.deepEqual(await provider.validate(), { ok: true });
    assert.equal(validateMaxOutputTokens(jsonRequestBody(calls[0])), 32);
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
    assert.equal(validateMaxOutputTokens(jsonRequestBody(calls[1])), 32);
  });
});

test("GoogleProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(googleResponse("hello")),
    () => jsonResponse(googleResponse("{", "MAX_TOKENS")),
    () => googleStream("partial", "MAX_TOKENS"),
  ], async () => {
    const provider = new GoogleProvider("test-key", "gemini-test");
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

function validateMaxOutputTokens(body) {
  return body.generationConfig?.maxOutputTokens
    ?? body.config?.maxOutputTokens
    ?? body.maxOutputTokens;
}
