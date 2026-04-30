import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, Message } from "./provider.js";
import { MaxTokensError } from "./provider.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 16384;
const MAX_TOKENS_JSON = 128000;

export class AnthropicProvider implements LLMProvider {
  readonly name = "Anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(
    messages: Message[],
    systemPrompt: string,
    maxTokens: number = MAX_TOKENS
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: MODEL,
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
      model: MODEL,
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
      const truncationNote =
        "\n\n[Aegis note: this response was cut off at the model's max_tokens limit. Tell me how to continue or what to skip.]";
      full += truncationNote;
      onToken(truncationNote);
    }

    return full;
  }

  async chatJSON<T = unknown>(
    messages: Message[],
    systemPrompt: string
  ): Promise<T> {
    const jsonSystemPrompt = `${systemPrompt}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no preamble, no explanation — just the JSON object.`;

    // Use streaming internally to avoid API timeout on large responses.
    // The stream collects the full response silently — no token callback needed.
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS_JSON,
      system: jsonSystemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
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

  async validate(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: MODEL,
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Parse a JSON response from the LLM, stripping any markdown fencing
 * or preamble the model might have wrapped around it.
 *
 * Handles:
 * - Leading/trailing whitespace and newlines
 * - ```json ... ``` fences (with or without "json" label)
 * - Leading prose before the JSON object (finds first `{`)
 * - Trailing prose after the JSON object (finds last `}`)
 */
function parseJSONResponse<T>(raw: string): T {
  let cleaned = raw.trim();

  // Strip markdown code fences — handle various formats:
  // ```json\n...\n```, ```\n...\n```, ``` json\n...\n```
  cleaned = cleaned
    .replace(/^```\s*(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();

  // If it still doesn't start with { or [, try to find the JSON object
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) {
    const firstBrace = cleaned.indexOf("{");
    const firstBracket = cleaned.indexOf("[");
    const start = firstBrace >= 0 && firstBracket >= 0
      ? Math.min(firstBrace, firstBracket)
      : Math.max(firstBrace, firstBracket);

    if (start >= 0) {
      cleaned = cleaned.slice(start);
    }
  }

  // If it has trailing content after the JSON, find the matching close
  if (cleaned.startsWith("{")) {
    const lastBrace = cleaned.lastIndexOf("}");
    if (lastBrace >= 0) {
      cleaned = cleaned.slice(0, lastBrace + 1);
    }
  } else if (cleaned.startsWith("[")) {
    const lastBracket = cleaned.lastIndexOf("]");
    if (lastBracket >= 0) {
      cleaned = cleaned.slice(0, lastBracket + 1);
    }
  }

  return JSON.parse(cleaned) as T;
}
