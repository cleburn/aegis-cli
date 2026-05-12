import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  runGoogleOAuthFlow,
  saveGoogleOAuthTokens,
} from "../dist/src/llm/google-oauth.js";

test("Google OAuth flow captures callback, exchanges code, and stores tokens", async () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-google-oauth-"));
  let requestedAuthUrl = "";

  try {
    process.env.HOME = home;
    const tokens = await runGoogleOAuthFlow({
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "desktop-secret",
      endpoints: {
        oauth2AuthBaseUrl: "https://accounts.example.test/o/oauth2/v2/auth",
        oauth2TokenUrl: "https://tokens.example.test/token",
      },
      openBrowser: async (url) => {
        requestedAuthUrl = url;
      },
      callbackServer: {
        redirectUri: "http://127.0.0.1:49152/oauth/google/callback",
        waitForCode: async (expectedState) => {
          await new Promise((resolve) => setImmediate(resolve));
          const authUrl = new URL(requestedAuthUrl);
          assert.equal(authUrl.hostname, "accounts.example.test");
          assert.equal(authUrl.searchParams.get("state"), expectedState);
          assert.equal(
            authUrl.searchParams.get("redirect_uri"),
            "http://127.0.0.1:49152/oauth/google/callback"
          );
          return { code: "oauth-code" };
        },
        close: async () => {},
      },
      exchangeCode: async ({ code, codeVerifier, redirectUri }) => {
        assert.equal(code, "oauth-code");
        assert.ok(codeVerifier);
        assert.equal(
          redirectUri,
          "http://127.0.0.1:49152/oauth/google/callback"
        );
        return {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: Date.now() + 3600_000,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/generative-language",
        };
      },
    });

    assert.equal(tokens.access_token, "access-token");
    assert.equal(tokens.refresh_token, "refresh-token");
    const credentialsPath = path.join(
      home,
      ".aegis",
      "oauth",
      "google",
      "credentials.json"
    );
    const saved = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
    assert.equal(saved.access_token, "access-token");
    assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
  } finally {
    restoreHome(originalHome);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Google OAuth token storage uses owner-only permissions", () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-google-oauth-"));
  try {
    process.env.HOME = home;
    saveGoogleOAuthTokens({ access_token: "access", refresh_token: "refresh" });
    const dir = path.join(home, ".aegis", "oauth", "google");
    const file = path.join(dir, "credentials.json");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    restoreHome(originalHome);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Google OAuth browser-open failure still exposes manual URL path", async () => {
  const originalHome = process.env.HOME;
  const originalWrite = process.stdout.write;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-google-oauth-"));
  let output = "";
  try {
    process.env.HOME = home;
    process.stdout.write = (chunk) => {
      output += String(chunk);
      return true;
    };
    await runGoogleOAuthFlow({
      clientId: "client.apps.googleusercontent.com",
      clientSecret: "desktop-secret",
      openBrowser: async () => {
        throw new Error("no browser");
      },
      callbackServer: {
        redirectUri: "http://127.0.0.1:49152/oauth/google/callback",
        waitForCode: async () => ({ code: "oauth-code" }),
        close: async () => {},
      },
      exchangeCode: async () => ({
        access_token: "access-token",
        refresh_token: "refresh-token",
      }),
    });
    assert.match(output, /Open this URL to sign in with Google/);
    assert.match(output, /accounts\.google/);
  } finally {
    process.stdout.write = originalWrite;
    restoreHome(originalHome);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Google OAuth cancellation surfaces a clean abort", async () => {
  await assert.rejects(
    () =>
      runGoogleOAuthFlow({
        clientId: "client.apps.googleusercontent.com",
        clientSecret: "desktop-secret",
        openBrowser: async () => {},
        callbackServer: {
          redirectUri: "http://127.0.0.1:49152/oauth/google/callback",
          waitForCode: async () => {
            throw new Error("Google sign-in canceled.");
          },
          close: async () => {},
        },
      }),
    /Google sign-in canceled/
  );
});

function restoreHome(value) {
  if (value === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = value;
  }
}
