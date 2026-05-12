import { GoogleGenAI } from "@google/genai";
import type { OAuth2Client } from "google-auth-library";
import type {
  LLMProvider,
  Message,
  ProviderValidateResult,
} from "./provider.js";
import { MaxTokensError } from "./provider.js";
import {
  classifyProviderError,
  extractStatus,
  MAX_TOKENS,
  MAX_TOKENS_JSON,
  parseJSONResponse,
  splitSystemMessages,
  truncationNote,
} from "./common.js";
import { defaultModelForProvider } from "./models.js";
import {
  createGoogleOAuthClient,
  GoogleOAuthReauthRequiredError,
  type GoogleOAuthTokens,
  loadGoogleOAuthTokens,
  refreshGoogleOAuthCredentials,
  saveGoogleOAuthTokens,
} from "./google-oauth.js";

type GoogleAuthMethod = "apiKey" | "oauth";

type GoogleProviderOptions = {
  apiKey?: string;
  authMethod?: GoogleAuthMethod;
  model?: string;
  validateTimeoutMs?: number;
  oauthClient?: OAuth2Client;
  onOAuthTokens?: (tokens: GoogleOAuthTokens) => void;
};

type GoogleContent = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

const GOOGLE_VALIDATE_TIMEOUT_MS = 15_000;

export class GoogleProvider implements LLMProvider {
  readonly name = "Google";
  private client: GoogleGenAI;
  private model: string;
  private authMethod: GoogleAuthMethod;
  private validateTimeoutMs: number;
  private oauthClient?: OAuth2Client;
  private onOAuthTokens: (tokens: GoogleOAuthTokens) => void;

  constructor(
    apiKeyOrOptions: string | GoogleProviderOptions,
    model: string = defaultModelForProvider("google")
  ) {
    const options = typeof apiKeyOrOptions === "string"
      ? { apiKey: apiKeyOrOptions, authMethod: "apiKey" as const, model }
      : {
          authMethod: apiKeyOrOptions.authMethod ?? (apiKeyOrOptions.apiKey ? "apiKey" : "oauth"),
          ...apiKeyOrOptions,
          model: apiKeyOrOptions.model ?? model,
        };
    this.authMethod = options.authMethod;
    this.validateTimeoutMs = options.validateTimeoutMs ?? GOOGLE_VALIDATE_TIMEOUT_MS;
    this.onOAuthTokens = options.onOAuthTokens ?? saveGoogleOAuthTokens;
    this.oauthClient = options.authMethod === "oauth"
      ? options.oauthClient ?? createGoogleOAuthClient(requireOAuthTokens())
      : undefined;
    this.client = options.authMethod === "oauth"
      ? createOAuthGenAIClient(this.oauthClient!)
      : new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? defaultModelForProvider("google");
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const prepared = splitSystemMessages(messages, systemPrompt);
    const response = await this.withOAuthRetry(() =>
      this.client.models.generateContent({
        model: this.model,
        contents: toGoogleContents(prepared.messages),
        config: {
          systemInstruction: prepared.systemPrompt,
          maxOutputTokens: maxTokens,
        },
      })
    );

    return response.text ?? "";
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const prepared = splitSystemMessages(messages, systemPrompt);
    const stream = await this.withOAuthRetry(() =>
      this.client.models.generateContentStream({
        model: this.model,
        contents: toGoogleContents(prepared.messages),
        config: {
          systemInstruction: prepared.systemPrompt,
          maxOutputTokens: MAX_TOKENS,
        },
      })
    );

    let full = "";
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        full += text;
        onToken(text);
      }
      const reason = chunk.candidates?.[0]?.finishReason;
      if (typeof reason === "string") {
        finishReason = reason;
      }
    }

    if (finishReason === "MAX_TOKENS") {
      const note = truncationNote();
      full += note;
      onToken(note);
    }

    return full;
  }

  async chatJSON<T = unknown>(
    messages: Message[],
    systemPrompt: string,
    schema?: object
  ): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no preamble, no explanation — just the JSON object.`;
    const prepared = splitSystemMessages(messages, jsonSystemPrompt);
    const response = await this.withOAuthRetry(() =>
      this.client.models.generateContent({
        model: this.model,
        contents: toGoogleContents(prepared.messages),
        config: {
          systemInstruction: prepared.systemPrompt,
          maxOutputTokens: MAX_TOKENS_JSON,
          responseMimeType: "application/json",
          ...(schema ? { responseJsonSchema: schema } : {}),
        },
      })
    );

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(response.text ?? "");
  }

  async validate(): Promise<ProviderValidateResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.validateTimeoutMs);
    });
    try {
      const validationRequest = this.withOAuthRetry(() =>
        this.client.models.generateContent({
          model: this.model,
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          config: {
            maxOutputTokens: 32,
            httpOptions: { timeout: this.validateTimeoutMs },
            abortSignal: controller.signal,
          },
        })
      );
      const result = await Promise.race([validationRequest, timeoutResult]);
      if (result === "timeout") {
        validationRequest.catch(() => {});
        return {
          ok: false,
          reason: "transport",
          detail: `validation request timed out after ${this.validateTimeoutMs / 1000}s`,
        };
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof GoogleOAuthReauthRequiredError) {
        return { ok: false, reason: "auth", detail: err.message };
      }
      return classifyProviderError(err);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async withOAuthRetry<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    if (this.authMethod !== "oauth") return fn();
    try {
      return await fn();
    } catch (err) {
      if (extractStatus(err) !== 401 || !this.oauthClient) {
        throw err;
      }
      await refreshGoogleOAuthCredentials(this.oauthClient, this.onOAuthTokens);
      this.client = createOAuthGenAIClient(this.oauthClient);
      return fn();
    }
  }
}

function createOAuthGenAIClient(oauthClient: OAuth2Client): GoogleGenAI {
  const googleKey = process.env.GOOGLE_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const warn = console.warn;
  console.warn = (message?: unknown, ...args: unknown[]) => {
    if (
      typeof message === "string" &&
      message.includes("API key should be set when using the Gemini API")
    ) {
      return;
    }
    warn(message, ...args);
  };
  try {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    return new GoogleGenAI({ googleAuthOptions: { authClient: oauthClient } });
  } finally {
    restoreEnv("GOOGLE_API_KEY", googleKey);
    restoreEnv("GEMINI_API_KEY", geminiKey);
    console.warn = warn;
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function requireOAuthTokens() {
  const tokens = loadGoogleOAuthTokens();
  if (!tokens) {
    throw new GoogleOAuthReauthRequiredError(
      "Sign-in expired. Run aegis init to re-authenticate with Google."
    );
  }
  return tokens;
}

function toGoogleContents(messages: Message[]): GoogleContent[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}
