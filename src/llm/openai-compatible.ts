import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
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

type OpenAICompatibleOptions = {
  apiKey?: string;
  model: string;
  name: string;
  baseURL?: string;
  tokenLimitField?: "max_tokens" | "max_completion_tokens";
};

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  protected client: OpenAI;
  protected model: string;
  private tokenLimitField: "max_tokens" | "max_completion_tokens";

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name;
    this.model = options.model;
    this.tokenLimitField = options.tokenLimitField ?? "max_completion_tokens";
    this.client = new OpenAI({
      // The SDK requires a non-empty key even when local endpoints ignore auth.
      apiKey: options.apiKey ?? "not-needed",
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      ...this.tokenLimit(maxTokens),
      messages: toOpenAIMessages(messages, systemPrompt),
    });

    return response.choices[0]?.message.content ?? "";
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const params: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      ...this.tokenLimit(MAX_TOKENS),
      messages: toOpenAIMessages(messages, systemPrompt),
      stream: true,
    };
    const stream = await this.client.chat.completions.create(params);

    let full = "";
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const text = choice?.delta.content;
      if (typeof text === "string") {
        full += text;
        onToken(text);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    if (finishReason === "length") {
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
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      ...this.tokenLimit(MAX_TOKENS_JSON),
      messages: toOpenAIMessages(messages, jsonSystemPrompt),
      response_format: schema
        ? {
            type: "json_schema",
            json_schema: {
              name: "aegis_response",
              schema: schema as { [key: string]: unknown },
              strict: true,
            },
          }
        : { type: "json_object" },
    };
    const response = await this.client.chat.completions.create(params);
    const choice = response.choices[0];

    if (choice?.finish_reason === "length") {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(choice?.message.content ?? "");
  }

  async validate(): Promise<ProviderValidateResult> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        ...this.tokenLimit(10),
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true };
    } catch (err) {
      return classifyProviderError(err);
    }
  }

  private tokenLimit(maxTokens: number) {
    return this.tokenLimitField === "max_tokens"
      ? { max_tokens: maxTokens }
      : { max_completion_tokens: maxTokens };
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "OpenAI";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = defaultModelForProvider("openai")) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: systemPrompt,
      input: toResponseMessages(messages),
      max_output_tokens: maxTokens,
    });

    return response.output_text ?? "";
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const params: ResponseCreateParamsStreaming = {
      model: this.model,
      instructions: systemPrompt,
      input: toResponseMessages(messages),
      max_output_tokens: MAX_TOKENS,
      stream: true,
    };
    const stream = await this.client.responses.create(params);

    let full = "";
    let incompleteReason: string | undefined;
    for await (const event of stream) {
      if (event.type === "response.output_text.delta") {
        full += event.delta;
        onToken(event.delta);
      } else if (event.type === "response.incomplete") {
        incompleteReason = event.response.incomplete_details?.reason;
      } else if (event.type === "response.completed") {
        incompleteReason = event.response.incomplete_details?.reason;
      }
    }

    if (incompleteReason === "max_output_tokens") {
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
    const params: ResponseCreateParamsNonStreaming = {
      model: this.model,
      instructions: jsonSystemPrompt,
      input: toResponseMessages(messages),
      max_output_tokens: MAX_TOKENS_JSON,
      text: {
        format: schema
          ? {
              type: "json_schema",
              name: "aegis_response",
              schema: schema as { [key: string]: unknown },
              strict: true,
            }
          : { type: "json_object" },
      },
    };
    const response = await this.client.responses.create(params);

    if (response.incomplete_details?.reason === "max_output_tokens") {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(response.output_text ?? "");
  }

  async validate(): Promise<ProviderValidateResult> {
    try {
      await this.client.responses.create({
        model: this.model,
        input: "ping",
        max_output_tokens: 10,
      });
      return { ok: true };
    } catch (err) {
      return classifyProviderError(err);
    }
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string, model = defaultModelForProvider("deepseek")) {
    super({
      name: "DeepSeek",
      apiKey,
      model,
      baseURL: "https://api.deepseek.com",
      tokenLimitField: "max_tokens",
    });
  }
}

export class CustomProvider extends OpenAICompatibleProvider {
  constructor(baseURL: string, apiKey?: string, model = defaultModelForProvider("custom")) {
    super({
      name: "Custom",
      apiKey,
      model,
      baseURL,
      tokenLimitField: "max_tokens",
    });
  }
}

function toOpenAIMessages(messages: Message[], systemPrompt: string) {
  return [
    { role: "system" as const, content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];
}

function toResponseMessages(messages: Message[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}
