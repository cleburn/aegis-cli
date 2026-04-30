/**
 * LLM Provider Interface
 *
 * Thin abstraction so Aegis can talk to any LLM backend.
 * Anthropic is the first-class implementation, but the interface
 * is clean enough that OpenAI, Gemini, or local models slot in trivially.
 */

export interface Message {
  role: "user" | "assistant";
  content: string;
}

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
   * Verify the API key works.
   */
  validate(): Promise<boolean>;
}

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
