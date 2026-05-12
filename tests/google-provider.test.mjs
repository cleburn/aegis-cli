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

test("GoogleProvider validates with OAuth credentials", async () => {
  const originalGoogleKey = process.env.GOOGLE_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const oauthClient = {
    credentials: { access_token: "oauth-token", refresh_token: "refresh-token" },
    getRequestHeaders: async () => new Headers([["authorization", "Bearer oauth-token"]]),
    getProjectId: async () => "test-project",
    on: () => {},
  };

  try {
    await withMockFetch([
      (_input, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer oauth-token");
        return jsonResponse(googleResponse("pong"));
      },
    ], async () => {
      const provider = new GoogleProvider({
        authMethod: "oauth",
        model: "gemini-test",
        validateTimeoutMs: 50,
        oauthClient,
      });
      assert.deepEqual(await provider.validate(), { ok: true });
    });
  } finally {
    restoreEnv("GOOGLE_API_KEY", originalGoogleKey);
    restoreEnv("GEMINI_API_KEY", originalGeminiKey);
  }
});

test("GoogleProvider refreshes OAuth tokens on auth failure", async () => {
  const oauthClient = {
    credentials: { access_token: "old-token", refresh_token: "refresh-token" },
    getRequestHeaders: async () =>
      new Headers([["authorization", `Bearer ${oauthClient.credentials.access_token}`]]),
    getProjectId: async () => "test-project",
    refreshAccessToken: async () => ({
      credentials: {
        access_token: "new-token",
        refresh_token: "refresh-token",
        expiry_date: Date.now() + 3600_000,
      },
      res: null,
    }),
    setCredentials: (credentials) => {
      oauthClient.credentials = credentials;
    },
    on: () => {},
  };

  await withMockFetch([
    (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer old-token");
      return jsonResponse({ error: { code: 401, message: "expired" } }, 401);
    },
    (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new-token");
      return jsonResponse(googleResponse("pong"));
    },
  ], async () => {
    const provider = new GoogleProvider({
      authMethod: "oauth",
      model: "gemini-test",
      validateTimeoutMs: 50,
      oauthClient,
      onOAuthTokens: () => {},
    });
    assert.deepEqual(await provider.validate(), { ok: true });
  });
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

test("GoogleProvider validate timeout also applies to OAuth", async () => {
  const oauthClient = {
    credentials: { access_token: "oauth-token", refresh_token: "refresh-token" },
    getRequestHeaders: async () => new Headers([["authorization", "Bearer oauth-token"]]),
    getProjectId: async () => "test-project",
    on: () => {},
  };

  await withMockFetch([
    () => new Promise(() => {}),
  ], async () => {
    const provider = new GoogleProvider({
      authMethod: "oauth",
      model: "gemini-test",
      validateTimeoutMs: 5,
      oauthClient,
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
