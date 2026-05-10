import type { ProviderValidateResult } from "./provider.js";

export const MAX_TOKENS = 16384;
export const MAX_TOKENS_JSON = 128000;

export function truncationNote(): string {
  return "\n\n[Aegis note: this response was cut off at the model's max_tokens limit. Tell me how to continue or what to skip.]";
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
