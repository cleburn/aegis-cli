import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import {
  CodeChallengeMethod,
  ClientAuthentication,
  OAuth2Client,
  type Credentials,
  type OAuth2ClientOptions,
} from "google-auth-library";
import { AegisExit } from "../abort.js";

export type GoogleOAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
};

type OAuthEndpoints = NonNullable<OAuth2ClientOptions["endpoints"]>;

export type GoogleOAuthFlowOptions = {
  clientId?: string;
  clientSecret?: string;
  endpoints?: OAuthEndpoints;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
  callbackServer?: CallbackServer;
  exchangeCode?: (params: {
    client: OAuth2Client;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<Credentials>;
};

// Desktop-app OAuth client values are distributed with installed apps; per
// Google's own docs they are identifiers, not a server-side secret boundary.
export const GOOGLE_OAUTH_CLIENT_ID =
  "677504568055-6vlq85ca3lulc17vmc9mlk1q4818e2d4.apps.googleusercontent.com";
export const GOOGLE_OAUTH_CLIENT_SECRET =
  "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";

const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/generative-language";
const GOOGLE_OAUTH_TIMEOUT_MS = 120_000;

export async function runGoogleOAuthFlow(
  options: GoogleOAuthFlowOptions = {}
): Promise<GoogleOAuthTokens> {
  const clientId = options.clientId ?? GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = options.clientSecret ?? GOOGLE_OAUTH_CLIENT_SECRET;
  if (clientId.startsWith("TODO_") || clientSecret.startsWith("TODO_")) {
    throw new AegisExit(
      1,
      "Google sign-in is not configured in this Aegis build. Add the Google Desktop OAuth client ID before publishing."
    );
  }

  const callback = options.callbackServer ??
    await startOAuthCallbackServer(options.timeoutMs);
  try {
    const redirectUri = callback.redirectUri;
    const client = createOAuth2Client({ clientId, clientSecret, redirectUri, endpoints: options.endpoints });
    const verifier = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(24).toString("base64url");
    const authUrl = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_OAUTH_SCOPE,
      code_challenge: verifier.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      state,
      redirect_uri: redirectUri,
    });
    const codePromise = callback.waitForCode(state);

    try {
      await (options.openBrowser ?? openBrowser)(authUrl);
    } catch {
      process.stdout.write(`\n  Open this URL to sign in with Google:\n  ${authUrl}\n\n`);
    }

    const result = await codePromise;
    const credentials = options.exchangeCode
      ? await options.exchangeCode({
          client,
          code: result.code,
          codeVerifier: verifier.codeVerifier,
          redirectUri,
        })
      : (await client.getToken({
          code: result.code,
          codeVerifier: verifier.codeVerifier,
          redirect_uri: redirectUri,
        })).tokens;
    const tokens = tokensFromCredentials(credentials);
    saveGoogleOAuthTokens(tokens);
    return tokens;
  } finally {
    await callback.close();
  }
}

export function loadGoogleOAuthTokens(): GoogleOAuthTokens | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialsPath(), "utf-8"));
    if (!isTokenRecord(raw) || typeof raw.access_token !== "string") {
      return null;
    }
    return {
      access_token: raw.access_token,
      ...(typeof raw.refresh_token === "string" ? { refresh_token: raw.refresh_token } : {}),
      ...(typeof raw.expires_at === "number" ? { expires_at: raw.expires_at } : {}),
      ...(typeof raw.token_type === "string" ? { token_type: raw.token_type } : {}),
      ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
    };
  } catch {
    return null;
  }
}

export function hasGoogleOAuthTokens(): boolean {
  return loadGoogleOAuthTokens() !== null;
}

export function saveGoogleOAuthTokens(tokens: GoogleOAuthTokens): void {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(credentialsPath(), JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(credentialsPath(), 0o600);
}

export function createGoogleOAuthClient(
  tokens: GoogleOAuthTokens,
  onTokens: (tokens: GoogleOAuthTokens) => void = saveGoogleOAuthTokens
): OAuth2Client {
  const client = createOAuth2Client({
    clientId: GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
  });
  client.setCredentials(credentialsFromTokens(tokens));
  client.on("tokens", (updated: Credentials) => {
    const merged = tokensFromCredentials({
      ...credentialsFromTokens(tokens),
      ...updated,
      refresh_token: updated.refresh_token ?? tokens.refresh_token,
    });
    onTokens(merged);
  });
  return client;
}

export async function refreshGoogleOAuthCredentials(
  client: OAuth2Client,
  onTokens: (tokens: GoogleOAuthTokens) => void = saveGoogleOAuthTokens
): Promise<GoogleOAuthTokens> {
  try {
    const response = await client.refreshAccessToken();
    const tokens = tokensFromCredentials({
      ...client.credentials,
      ...response.credentials,
      refresh_token: response.credentials.refresh_token ?? client.credentials.refresh_token,
    });
    client.setCredentials(credentialsFromTokens(tokens));
    onTokens(tokens);
    return tokens;
  } catch {
    throw new GoogleOAuthReauthRequiredError(
      "Sign-in expired. Run aegis init to re-authenticate with Google."
    );
  }
}

export class GoogleOAuthReauthRequiredError extends Error {
  readonly status = 401;
  constructor(message: string) {
    super(message);
    this.name = "GoogleOAuthReauthRequiredError";
  }
}

function createOAuth2Client(options: OAuth2ClientOptions): OAuth2Client {
  return new OAuth2Client({
    clientAuthentication: ClientAuthentication.ClientSecretPost,
    ...options,
  });
}

function tokensFromCredentials(credentials: Credentials): GoogleOAuthTokens {
  if (!credentials.access_token) {
    throw new AegisExit(1, "Google sign-in did not return an access token.");
  }
  return {
    access_token: credentials.access_token,
    ...(credentials.refresh_token ? { refresh_token: credentials.refresh_token } : {}),
    ...(credentials.expiry_date ? { expires_at: credentials.expiry_date } : {}),
    ...(credentials.token_type ? { token_type: credentials.token_type } : {}),
    ...(credentials.scope ? { scope: credentials.scope } : {}),
  };
}

function credentialsFromTokens(tokens: GoogleOAuthTokens): Credentials {
  return {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.expires_at ? { expiry_date: tokens.expires_at } : {}),
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

function credentialsDir(): string {
  return path.join(os.homedir(), ".aegis", "oauth", "google");
}

function credentialsPath(): string {
  return path.join(credentialsDir(), "credentials.json");
}

function isTokenRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type CallbackServer = {
  redirectUri: string;
  waitForCode: (expectedState: string) => Promise<{ code: string }>;
  close: () => Promise<void>;
};

async function startOAuthCallbackServer(timeoutMs = GOOGLE_OAUTH_TIMEOUT_MS): Promise<CallbackServer> {
  let resolveCode: ((value: { code: string }) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  const codePromise = new Promise<{ code: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let expectedState = "";

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (state !== expectedState) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Google sign-in failed</h1><p>State did not match. Return to Aegis and try again.</p>");
      rejectCode?.(new AegisExit(130, "Google sign-in failed. Return to Aegis and try again."));
      return;
    }
    if (error || !code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Google sign-in canceled</h1><p>You can close this window and return to Aegis.</p>");
      rejectCode?.(new AegisExit(130, "Google sign-in canceled."));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>Sign-in complete</h1><p>You can close this window and return to Aegis.</p>");
    resolveCode?.({ code });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new AegisExit(1, "Could not start the Google sign-in callback server.");
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}/oauth/google/callback`,
    waitForCode: (state: string) => {
      expectedState = state;
      const timeout = setTimeout(() => {
        rejectCode?.(
          new AegisExit(
            130,
            "Google sign-in timed out. Re-run aegis init and try again."
          )
        );
      }, timeoutMs);
      return codePromise.finally(() => clearTimeout(timeout));
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32"
    ? ["/c", "start", "", url]
    : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
