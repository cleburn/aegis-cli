import { Mistral } from "@mistralai/mistralai";
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

export class MistralProvider implements LLMProvider {
  readonly name = "Mistral";
  private client: Mistral;
  private model: string;

  constructor(apiKey: string, model: string = defaultModelForProvider("mistral")) {
    this.client = new Mistral({ apiKey });
    this.model = model;
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.chat.complete({
      model: this.model,
      maxTokens,
      messages: toMistralMessages(messages, systemPrompt),
    });

    return contentToText(response.choices?.[0]?.message?.content);
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const stream = await this.client.chat.stream({
      model: this.model,
      maxTokens: MAX_TOKENS,
      messages: toMistralMessages(messages, systemPrompt),
    });

    let full = "";
    let finishReason: string | null | undefined;

    for await (const event of stream) {
      const choice = event.data.choices?.[0];
      const text = contentToText(choice?.delta?.content);
      if (text) {
        full += text;
        onToken(text);
      }
      if (choice?.finishReason) {
        finishReason = choice.finishReason;
      }
    }

    if (isTruncated(finishReason)) {
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
    const response = await this.client.chat.complete({
      model: this.model,
      maxTokens: MAX_TOKENS_JSON,
      messages: toMistralMessages(messages, jsonSystemPrompt),
      responseFormat: schema
        ? {
            type: "json_schema",
            jsonSchema: {
              name: "aegis_response",
              schemaDefinition: schema,
              strict: true,
            },
          }
        : { type: "json_object" },
    });

    const choice = response.choices?.[0];
    if (isTruncated(choice?.finishReason)) {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(contentToText(choice?.message?.content));
  }

  async validate(): Promise<ProviderValidateResult> {
    try {
      await this.client.chat.complete({
        model: this.model,
        maxTokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true };
    } catch (err) {
      return classifyProviderError(err);
    }
  }
}

function toMistralMessages(messages: Message[], systemPrompt: string) {
  return [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .join("");
}

function isTruncated(reason: string | null | undefined): boolean {
  return reason === "length" || reason === "model_length";
}
