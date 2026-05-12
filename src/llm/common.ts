import type { Message, ProviderMessage, ProviderValidateResult } from "./provider.js";

export const MAX_TOKENS = 16384;
export const MAX_TOKENS_JSON = 128000;
export const PROVIDER_VALIDATE_TIMEOUT_MS = 15_000;
export const VALIDATION_TIMEOUT: unique symbol = Symbol("validation-timeout");

export function truncationNote(): string {
  return "\n\n[Aegis note: this response was cut off at the model's max_tokens limit. Tell me how to continue or what to skip.]";
}

export function validationTimeoutResult(
  timeoutMs: number
): ProviderValidateResult {
  return {
    ok: false,
    reason: "transport",
    detail: `validation request timed out after ${timeoutMs / 1000}s`,
  };
}

export async function runWithValidationTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = PROVIDER_VALIDATE_TIMEOUT_MS
): Promise<T | typeof VALIDATION_TIMEOUT> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult: Promise<typeof VALIDATION_TIMEOUT> = new Promise((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve(VALIDATION_TIMEOUT);
    }, timeoutMs);
  });
  const requestResult: Promise<T | typeof VALIDATION_TIMEOUT> = request(
    controller.signal
  ).catch((err) => {
    if (controller.signal.aborted) {
      return VALIDATION_TIMEOUT;
    }
    throw err;
  });

  try {
    return await Promise.race<T | typeof VALIDATION_TIMEOUT>([
      requestResult,
      timeoutResult,
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function parseJSONResponse<T>(raw: string): T {
  let cleaned = raw.trim();

  cleaned = cleaned
    .replace(/^```\s*(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();

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

export function classifyProviderError(err: unknown): ProviderValidateResult {
  const status = extractStatus(err);
  if (status === 401 || status === 403) {
    return { ok: false, reason: "auth" };
  }

  const detail =
    err instanceof Error ? err.message.slice(0, 200) : "unknown error";
  return { ok: false, reason: "transport", detail };
}

export function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;

  if ("status" in err && typeof err.status === "number") {
    return err.status;
  }
  if ("statusCode" in err && typeof err.statusCode === "number") {
    return err.statusCode;
  }

  return undefined;
}

export function splitSystemMessages(
  messages: Message[],
  systemPrompt: string
): { systemPrompt: string; messages: ProviderMessage[] } {
  const systemMessages = messages.filter((message) => message.role === "system");
  return {
    systemPrompt: [systemPrompt, ...systemMessages.map((message) => message.content)]
      .filter(Boolean)
      .join("\n\n"),
    messages: messages.filter(
      (message): message is ProviderMessage => message.role !== "system"
    ),
  };
}
