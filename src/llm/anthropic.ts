import Anthropic from "@anthropic-ai/sdk";
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

export class AnthropicProvider implements LLMProvider {
  readonly name = "Anthropic";
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = defaultModelForProvider("anthropic")) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    return response.content
      .filter((block) => block.type === "text")
      .map((block) => {
        if (block.type === "text") return block.text;
        return "";
      })
      .join("");
  }

  async chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    let full = "";
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text;
        full += text;
        onToken(text);
      } else if (event.type === "message_delta") {
        // Anthropic emits stop_reason on the message_delta event near
        // the end of the stream. Capture it so the loop can react if
        // the response was truncated rather than completed.
        const reason = (event.delta as { stop_reason?: string | null })
          .stop_reason;
        if (typeof reason === "string") {
          stopReason = reason;
        }
      }
    }

    // Surface max_tokens truncation. The conversation loop in
    // engine.ts pushes whatever string this returns into the
    // assistant-side history and the affirmation matchers run
    // against it — a silent cut-off mid-sentence would leave a
    // half-finished message that downstream marker logic could
    // misread. Stream a visible note via onToken (so the user sees
    // it in real time at the end of the partial response) AND
    // include it in the returned full string (so the saved
    // transcript and any future return-visit context carry the
    // signal of what happened). The note is plain text, not a
    // control marker, so engine.ts's drainBuffer leaves it alone.
    if (stopReason === "max_tokens") {
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

    // Use streaming internally to avoid API timeout on large responses.
    // The stream collects the full response silently — no token callback needed.
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS_JSON,
      system: jsonSystemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      ...(schema ? { format: { type: "json_schema" as const, schema } } : {}),
    });

    let raw = "";
    let stopReason: string | null = null;

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        raw += event.delta.text;
      } else if (event.type === "message_delta") {
        const reason = (event.delta as { stop_reason?: string | null })
          .stop_reason;
        if (typeof reason === "string") {
          stopReason = reason;
        }
      }
    }

    // Throw a typed MaxTokensError BEFORE parsing rather than letting
    // the truncated payload fail JSON.parse with a generic SyntaxError.
    // The truncation is structurally distinct from "the model emitted
    // bad JSON" — the model didn't emit anything wrong, it just ran
    // out of room. engine.ts catches MaxTokensError specifically and
    // emits a precise retry hint + categorizes the saved-transcript
    // failure shape as "max_tokens" instead of "parse" (the previous
    // behavior, which misled future forensic passes about what failed).
    if (stopReason === "max_tokens") {
      throw new MaxTokensError("json");
    }

    return parseJSONResponse<T>(raw);
  }

  async validate(): Promise<ProviderValidateResult> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return { ok: true };
    } catch (err) {
      return classifyProviderError(err);
    }
  }
}
