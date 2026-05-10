/**
 * LLM Provider Interface
 *
 * Thin abstraction so Aegis can talk to any LLM backend.
 * Anthropic is the first-class implementation, but the interface
 * is clean enough that OpenAI, Gemini, or local models slot in trivially.
 */

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ProviderMessage = Message & { role: "user" | "assistant" };

export interface StreamEvent {
  type: "text_delta" | "message_start" | "message_stop";
  text?: string;
}

export interface LLMProvider {
  /**
   * Send a conversation and get a complete response.
   */
  chat(messages: Message[], systemPrompt: string): Promise<string>;

  /**
   * Send a conversation and stream the response token-by-token.
   * Calls onToken for each chunk, returns the full assembled response.
   */
  chatStream(
    messages: Message[],
    systemPrompt: string,
    onToken: (token: string) => void
  ): Promise<string>;

  /**
   * Send a conversation and get a structured JSON response.
   * Uses the provider's native JSON mode or structured output if available.
   */
  chatJSON<T = unknown>(
    messages: Message[],
    systemPrompt: string,
    schema?: object
  ): Promise<T>;

  /**
   * Provider name for display/logging.
   */
  readonly name: string;

  /**
   * Verify the API key works. Returns a typed result so the caller
   * can surface the actual failure mode — a rejected key
   * ("auth") and a network or 5xx failure ("transport") both
   * cause validate() to fail, but they call for different
   * user-facing messages: re-enter the key vs check connectivity
   * and retry. A boolean return would conflate the two and
   * default to blaming the key, which is wrong about half the
   * time and lands the user retyping a perfectly good API key
   * they had.
   */
  validate(): Promise<ProviderValidateResult>;
}

/**
 * Outcome of provider.validate(). Success is the simple shape; a
 * failure carries a discriminated reason so callers branch their
 * user-facing error messages on the actual cause.
 */
export type ProviderValidateResult =
  | { ok: true }
  | { ok: false; reason: "auth" | "transport"; detail?: string };

/**
 * Thrown by providers when the model's response stops because the
 * max_tokens budget was exhausted before generation completed. Used
 * by the JSON-output path (chatJSON) where a truncated payload is a
 * structurally distinct failure from "the model emitted bad JSON" —
 * the model didn't emit anything wrong, it just ran out of room. The
 * conversation path (chatStream) handles truncation differently: it
 * streams a visible note to the user instead of throwing, because
 * cutting off the live conversation with an exception is worse UX
 * than acknowledging the cut-off and continuing.
 *
 * Defined in the interface module rather than per-provider so future
 * provider implementations (OpenAI, Gemini, DeepSeek, etc.) throw
 * the same exception type and engine.ts catches it once.
 */
export class MaxTokensError extends Error {
  readonly operation: "chat" | "json";
  constructor(operation: "chat" | "json") {
    super(
      `Model response truncated at max_tokens before completing the ${
        operation === "json" ? "JSON output" : "response"
      }.`
    );
    this.name = "MaxTokensError";
    this.operation = operation;
  }
}
