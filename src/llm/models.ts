import type { ProviderId } from "../config/api-key.js";

export const MODEL_IDS = {
  anthropic: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ],
  openai: ["gpt-5.5-codex", "gpt-5.4-codex"],
  google: ["gemini-3.1-pro-preview"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  mistral: ["mistral-large-2512"],
  custom: ["local-model"],
} as const satisfies Record<ProviderId, readonly string[]>;

export type ModelId = typeof MODEL_IDS[ProviderId][number];

export const MODEL_OPTIONS = [
  { provider: "anthropic", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { provider: "openai", model: "gpt-5.5-codex", label: "OpenAI Codex 5.5" },
  { provider: "openai", model: "gpt-5.4-codex", label: "OpenAI Codex 5.4" },
  { provider: "google", model: "gemini-3.1-pro-preview", label: "Google Gemini 3.1" },
  { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { provider: "mistral", model: "mistral-large-2512", label: "Mistral Large 3" },
  { provider: "custom", model: "local-model", label: "Custom (OpenAI-compatible)" },
] as const satisfies ReadonlyArray<{
  provider: ProviderId;
  model: string;
  label: string;
}>;

export type ModelOption = typeof MODEL_OPTIONS[number];

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
