import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";
import type {
  LLMProvider,
  Message,
  ProviderValidateResult,
} from "./provider.js";
import { MaxTokensError } from "./provider.js";
import {
  classifyProviderError,
  MAX_TOKENS,
  MAX_TOKENS_JSON,
  parseJSONResponse,
  splitSystemMessages,
  truncationNote,
} from "./common.js";
import { defaultModelForProvider } from "./models.js";

type GoogleAuthMethod = "apiKey" | "adc";

type GoogleProviderOptions = {
  apiKey?: string;
  authMethod?: GoogleAuthMethod;
  model?: string;
  validateTimeoutMs?: number;
  googleAuthOptions?: GoogleGenAIOptions["googleAuthOptions"];
};

type GoogleContent = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

const GOOGLE_VALIDATE_TIMEOUT_MS = 15_000;
const GOOGLE_ADC_SETUP_HINT =
  "Run `gcloud auth application-default login` in another terminal, then try again.";
const GOOGLE_API_KEY_ENV_VARS = ["GOOGLE_API_KEY", "GEMINI_API_KEY"] as const;

export class GoogleProvider implements LLMProvider {
  readonly name = "Google";
  private client: GoogleGenAI;
  private model: string;
  private authMethod: GoogleAuthMethod;
  private validateTimeoutMs: number;

  constructor(
    apiKeyOrOptions: string | GoogleProviderOptions,
    model: string = defaultModelForProvider("google")
  ) {
    const options = typeof apiKeyOrOptions === "string"
      ? { apiKey: apiKeyOrOptions, authMethod: "apiKey" as const, model }
      : {
          authMethod: apiKeyOrOptions.authMethod ?? (apiKeyOrOptions.apiKey ? "apiKey" : "adc"),
          ...apiKeyOrOptions,
          model: apiKeyOrOptions.model ?? model,
        };
    this.authMethod = options.authMethod;
    this.validateTimeoutMs = options.validateTimeoutMs ?? GOOGLE_VALIDATE_TIMEOUT_MS;
    this.client = options.authMethod === "adc"
      ? createAdcClient(options.googleAuthOptions)
      : new GoogleGenAI({ apiKey: options.apiKey });
    this.model = options.model ?? defaultModelForProvider("google");
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const prepared = splitSystemMessages(messages, systemPrompt);
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGoogleContents(prepared.messages),
      config: {
        systemInstruction: prepared.systemPrompt,
        maxOutputTokens: maxTokens,
      },
    });

    return response.text ?? "";
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const prepared = splitSystemMessages(messages, systemPrompt);
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: toGoogleContents(prepared.messages),
      config: {
        systemInstruction: prepared.systemPrompt,
        maxOutputTokens: MAX_TOKENS,
      },
    });

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
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGoogleContents(prepared.messages),
      config: {
        systemInstruction: prepared.systemPrompt,
        maxOutputTokens: MAX_TOKENS_JSON,
        responseMimeType: "application/json",
        ...(schema ? { responseJsonSchema: schema } : {}),
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason === "MAX_TOKENS") {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(response.text ?? "");
  }

  async validate(): Promise<ProviderValidateResult> {
    const envConflict = this.adcEnvConflict();
    if (envConflict) {
      return { ok: false, reason: "transport", detail: envConflict };
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, this.validateTimeoutMs);
    });
    const validationRequest = this.client.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      config: {
        maxOutputTokens: 32,
        httpOptions: { timeout: this.validateTimeoutMs },
        abortSignal: controller.signal,
      },
    });

    try {
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
      return this.classifyValidationError(err);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private adcEnvConflict(): string | null {
    if (this.authMethod !== "adc") return null;
    const conflicts = GOOGLE_API_KEY_ENV_VARS.filter((envVar) =>
      Boolean(process.env[envVar])
    );
    if (conflicts.length === 0) return null;
    return `gcloud authentication cannot be used while ${conflicts.join(
      " or "
    )} is set. Unset those variables or choose the Google API-key path.`;
  }

  private classifyValidationError(err: unknown): ProviderValidateResult {
    const result = classifyProviderError(err);
    if (this.authMethod !== "adc" || result.ok || result.reason !== "transport") {
      return result;
    }
    return {
      ...result,
      detail: result.detail
        ? `${result.detail}. ${GOOGLE_ADC_SETUP_HINT}`
        : GOOGLE_ADC_SETUP_HINT,
    };
  }
}

function createAdcClient(
  googleAuthOptions: GoogleGenAIOptions["googleAuthOptions"]
): GoogleGenAI {
  const warn = console.warn;
  console.warn = (message?: unknown, ...args: unknown[]) => {
    // The SDK emits this even when ADC will supply OAuth headers; showing it
    // during setup would tell gcloud users to solve the wrong problem.
    if (
      typeof message === "string" &&
      message.includes("API key should be set when using the Gemini API")
    ) {
      return;
    }
    warn(message, ...args);
  };
  try {
    return new GoogleGenAI({ googleAuthOptions });
  } finally {
    console.warn = warn;
  }
}

function toGoogleContents(messages: Message[]): GoogleContent[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}
