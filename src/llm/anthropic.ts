import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, Message } from "./provider.js";

const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 8192;
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

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text;
        full += text;
        onToken(text);
      }
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

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        raw += event.delta.text;
      }
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
