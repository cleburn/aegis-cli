import { GoogleGenAI } from "@google/genai";
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
  truncationNote,
} from "./common.js";
import { defaultModelForProvider } from "./models.js";

type GoogleContent = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

export class GoogleProvider implements LLMProvider {
  readonly name = "Google";
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string = defaultModelForProvider("google")) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGoogleContents(messages),
      config: {
        systemInstruction: systemPrompt,
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
    const stream = await this.client.models.generateContentStream({
      model: this.model,
      contents: toGoogleContents(messages),
      config: {
        systemInstruction: systemPrompt,
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
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: toGoogleContents(messages),
      config: {
        systemInstruction: jsonSystemPrompt,
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
    try {
      await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: "ping" }] }],
        config: { maxOutputTokens: 10 },
      });
      return { ok: true };
    } catch (err) {
      return classifyProviderError(err);
    }
  }
}

function toGoogleContents(messages: Message[]): GoogleContent[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}
