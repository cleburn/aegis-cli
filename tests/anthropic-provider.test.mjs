import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider } from "../dist/src/llm/anthropic.js";
import { MaxTokensError } from "../dist/src/llm/provider.js";
import {
  TRUNCATION_NOTE_FRAGMENT,
  anthropicMessage,
  anthropicStream,
  jsonResponse,
  withMockFetch,
} from "./helpers.mjs";

test("AnthropicProvider validates success and auth failure", async () => {
  await withMockFetch([
    () => jsonResponse(anthropicMessage("pong")),
    () => jsonResponse({ error: { message: "bad key" } }, 401),
  ], async () => {
    const provider = new AnthropicProvider("test-key", "claude-test");
    assert.deepEqual(await provider.validate(), { ok: true });
    assert.deepEqual(await provider.validate(), { ok: false, reason: "auth" });
  });
});

test("AnthropicProvider handles chat, JSON truncation, and stream truncation", async () => {
  await withMockFetch([
    () => jsonResponse(anthropicMessage("hello")),
    () => anthropicStream("{", "max_tokens"),
    () => anthropicStream("partial", "max_tokens"),
  ], async () => {
    const provider = new AnthropicProvider("test-key", "claude-test");
    assert.equal(await provider.chat([{ role: "user", content: "hi" }], "system"), "hello");
    await assert.rejects(
      () => provider.chatJSON([{ role: "user", content: "json" }], "system"),
      MaxTokensError
    );
    const tokens = [];
    const full = await provider.chatStream([{ role: "system", content: "note" }], "system", (token) => tokens.push(token));
    assert.match(full, /partial/);
    assert.match(full, new RegExp(TRUNCATION_NOTE_FRAGMENT));
    assert.ok(tokens.some((token) => token.includes(TRUNCATION_NOTE_FRAGMENT)));
  });
});
