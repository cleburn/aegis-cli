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

test("GoogleProvider validates with ADC and reports API-key env conflicts", async () => {
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const authClient = {
    getRequestHeaders: async () => new Headers([["authorization", "Bearer adc-token"]]),
    getProjectId: async () => "test-project",
  };

  try {
    await withMockFetch([
      (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer adc-token");
        return jsonResponse(googleResponse("pong"));
      },
    ], async () => {
      const provider = new GoogleProvider({
        authMethod: "adc",
        model: "gemini-test",
        validateTimeoutMs: 50,
        googleAuthOptions: { authClient },
      });
      assert.deepEqual(await provider.validate(), { ok: true });
    });

    process.env.GEMINI_API_KEY = "env-key";
    const blockedProvider = new GoogleProvider({
      authMethod: "adc",
      model: "gemini-test",
      validateTimeoutMs: 50,
    });
    const blocked = await blockedProvider.validate();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "transport");
    assert.match(blocked.detail, /GEMINI_API_KEY/);
    assert.match(blocked.detail, /API-key path/);
  } finally {
    restoreEnv("GOOGLE_API_KEY", originalGoogleKey);
    restoreEnv("GEMINI_API_KEY", originalGeminiKey);
  }
});

test("GoogleProvider ADC failure uses polished hint and suppresses metadata warnings", async () => {
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalEmitWarning = process.emitWarning;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const warnings = [];

  const authClient = {
    getRequestHeaders: async () => {
      process.emitWarning(
        "MetadataLookupWarning: received unexpected error = All promises were rejected code = UNKNOWN",
        "MetadataLookupWarning"
      );
      throw new Error(
        "Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information."
      );
    },
    getProjectId: async () => "test-project",
  };

  try {
    process.emitWarning = (warning, ...args) => {
      warnings.push({ warning, args });
    };
    const provider = new GoogleProvider({
      authMethod: "adc",
      model: "gemini-test",
      validateTimeoutMs: 50,
      googleAuthOptions: { authClient },
    });
    const result = await provider.validate();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transport");
    assert.equal(
      result.detail,
      "Sign-in failed because Google credentials aren't set up. Run `gcloud auth application-default login` in another terminal, then retry."
    );
    assert.equal(warnings.length, 0);
    assert.doesNotMatch(result.detail, /https:\/\/cloud\.google\.com/);
    assert.doesNotMatch(result.detail, /\.\./);
  } finally {
    process.emitWarning = originalEmitWarning;
    restoreEnv("GOOGLE_API_KEY", originalGoogleKey);
    restoreEnv("GEMINI_API_KEY", originalGeminiKey);
  }
});

test("GoogleProvider validate returns transport failure on timeout", async () => {
  await withMockFetch([
    () => new Promise(() => {}),
  ], async () => {
    const provider = new GoogleProvider({
      apiKey: "test-key",
      model: "gemini-test",
      validateTimeoutMs: 5,
    });
    const result = await provider.validate();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "transport");
    assert.match(result.detail, /timed out after 0.005s/);
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

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
