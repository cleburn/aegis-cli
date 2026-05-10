import type { ProviderId } from "../config/api-key.js";

export const MODEL_IDS = {
  anthropic: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  openai: ["codex-5.5", "codex-5.4"],
  google: ["gemini-3.1"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  mistral: ["mistral-large-3"],
  custom: ["local-model"],
} as const satisfies Record<ProviderId, readonly string[]>;

export type ModelId = typeof MODEL_IDS[ProviderId][number];

export function defaultModelForProvider(provider: ProviderId): string {
  return MODEL_IDS[provider][0];
}

export function resolveModelForProvider(
  provider: ProviderId,
  configuredModel?: string
): string {
  if (configuredModel) return configuredModel;
  return defaultModelForProvider(provider);
}
