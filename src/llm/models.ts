import type { ProviderId } from "../config/api-key.js";

export const MODEL_IDS = {
  anthropic: [
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ],
  openai: ["gpt-5.5", "gpt-5.4"],
  google: [
    "gemini-3.1-pro-preview",
    "gemini-2.5-pro",
  ],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  custom: ["local-model"],
} as const satisfies Record<ProviderId, readonly string[]>;

export type ModelId = typeof MODEL_IDS[ProviderId][number];

export const MODEL_OPTIONS = [
  { provider: "anthropic", model: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { provider: "anthropic", model: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { provider: "anthropic", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { provider: "openai", model: "gpt-5.5", label: "OpenAI GPT-5.5" },
  { provider: "openai", model: "gpt-5.4", label: "OpenAI GPT-5.4" },
  { provider: "google", model: "gemini-3.1-pro-preview", label: "Google Gemini 3.1 Pro Preview" },
  { provider: "google", model: "gemini-2.5-pro", label: "Google Gemini 2.5 Pro" },
  { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
  { provider: "custom", model: "local-model", label: "Local / open-source model (Gemma, Qwen, Kimi, etc...)" },
] as const satisfies ReadonlyArray<{
  provider: ProviderId;
  model: string;
  label: string;
}>;

export type ModelOption = typeof MODEL_OPTIONS[number];

export function modelLabelForProvider(
  provider: ProviderId,
  configuredModel?: string
): string {
  if (provider === "custom" && configuredModel) {
    return configuredModel;
  }

  const model = configuredModel ?? defaultModelForProvider(provider);
  const option = MODEL_OPTIONS.find((candidate) => {
    if (provider === "custom") return candidate.provider === "custom";
    return candidate.provider === provider && candidate.model === model;
  });
  return option?.label ?? model;
}

export function defaultModelForProvider(provider: ProviderId): string {
  return MODEL_IDS[provider][0];
}

export function resolveModelForProvider(
  provider: ProviderId,
  configuredModel?: string
): string {
  if (configuredModel && isKnownModelForProvider(provider, configuredModel)) {
    return configuredModel;
  }
  return defaultModelForProvider(provider);
}

export function isKnownModelForProvider(
  provider: ProviderId,
  model: string
): boolean {
  if (provider === "custom") return model.length > 0;
  return (MODEL_IDS[provider] as readonly string[]).includes(model);
}
