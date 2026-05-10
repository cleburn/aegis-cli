import { AegisExit } from "../abort.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { MistralProvider } from "./mistral.js";
import {
  CustomProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./openai-compatible.js";
import type { LLMProvider, ProviderValidateResult } from "./provider.js";
import { MODEL_OPTIONS, type ModelOption } from "./models.js";
import {
  getActiveProviderConfig,
  getProviderEnvVar,
  prompt,
  saveProviderConfig,
  type ActiveProviderConfig,
  type ProviderConfigInput,
} from "../config/api-key.js";

type InstallResult = "saved" | "pick-again";

export function hasUsableActiveProvider(active: ActiveProviderConfig): boolean {
  if (active.provider === "custom") {
    return Boolean(active.baseUrl);
  }
  return Boolean(active.apiKey);
}

export async function runProviderInstallFlow(): Promise<ActiveProviderConfig> {
  console.log("");
  console.log("  Choose the model Aegis should use.");

  while (true) {
    const option = await selectModel();
    const result = await configureAndValidate(option);
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

async function selectModel(): Promise<ModelOption> {
  console.log("");
  MODEL_OPTIONS.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option.label}`);
  });
  console.log("");

  while (true) {
    const raw = await prompt("  Select a model by number: ");
    if (!raw) {
      throw new AegisExit(130, "Model selection canceled.");
    }

    const selected = Number(raw);
    if (Number.isInteger(selected) && selected >= 1 && selected <= MODEL_OPTIONS.length) {
      return MODEL_OPTIONS[selected - 1];
    }

    console.log(`  Enter a number from 1 to ${MODEL_OPTIONS.length}.`);
  }
}

async function configureAndValidate(option: ModelOption): Promise<InstallResult> {
  while (true) {
    const input = await promptForConfig(option);
    const provider = providerFromInput(input);

    while (true) {
      console.log(`\n  Verifying ${option.label}...`);
      const validation = await provider.validate();
      if (validation.ok) {
        saveProviderConfig(input);
        console.log("  Saved to ~/.aegis/config.json.\n");
        return "saved";
      }

      if (validation.reason === "auth") {
        console.log(
          `  ${provider.name} rejected those credentials. Re-enter them to try again.`
        );
        break;
      }

      const recovery = await promptTransportRecovery(provider, {
        ok: false,
        reason: "transport",
        ...(validation.detail ? { detail: validation.detail } : {}),
      });
      if (recovery === "retry") {
        continue;
      }
      if (recovery === "save") {
        saveProviderConfig(input);
        console.log("  Saved to ~/.aegis/config.json without validation.\n");
        return "saved";
      }
      if (recovery === "pick-again") {
        return "pick-again";
      }
      throw new AegisExit(130, "Provider setup canceled.");
    }
  }
}

async function promptForConfig(option: ModelOption): Promise<ProviderConfigInput> {
  if (option.provider === "custom") {
    const baseUrl = (await prompt("  Base URL: ")).trim();
    if (!baseUrl) {
      throw new AegisExit(130, "Custom provider base URL is required.");
    }

    const model = (await prompt("  Model ID: ")).trim();
    if (!model) {
      throw new AegisExit(130, "Custom provider model ID is required.");
    }

    const apiKey = (await prompt("  API key (optional): ", true)).trim();
    return {
      provider: "custom",
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
    };
  }

  const envVar = getProviderEnvVar(option.provider);
  console.log(`  API key required. You can also use ${envVar} after setup.`);
  const apiKey = (await prompt("  API key: ", true)).trim();
  if (!apiKey) {
    throw new AegisExit(130, `${option.label} API key is required.`);
  }

  return {
    provider: option.provider,
    apiKey,
    model: option.model,
  };
}

async function promptTransportRecovery(
  provider: LLMProvider,
  validation: { ok: false; reason: "transport"; detail?: string }
): Promise<"retry" | "pick-again" | "save" | "abort"> {
  console.log(
    `  Couldn't verify with ${provider.name}${
      validation.detail ? ` - ${validation.detail}` : ""
    }. The credentials were not rejected; the request did not complete.`
  );
  console.log("");
  console.log("  1. Retry validation");
  console.log("  2. Pick a different model");
  console.log("  3. Save anyway");
  console.log("  4. Abort");
  console.log("");

  while (true) {
    const raw = await prompt("  Choose an option: ");
    if (!raw) {
      throw new AegisExit(130, "Provider setup canceled.");
    }
    switch (raw) {
      case "1":
        return "retry";
      case "2":
        return "pick-again";
      case "3":
        return "save";
      case "4":
        return "abort";
      default:
        console.log("  Enter 1, 2, 3, or 4.");
    }
  }
}

function providerFromInput(input: ProviderConfigInput): LLMProvider {
  switch (input.provider) {
    case "anthropic":
      return new AnthropicProvider(input.apiKey, input.model);
    case "openai":
      return new OpenAIProvider(input.apiKey, input.model);
    case "google":
      return new GoogleProvider(input.apiKey, input.model);
    case "deepseek":
      return new DeepSeekProvider(input.apiKey, input.model);
    case "mistral":
      return new MistralProvider(input.apiKey, input.model);
    case "custom":
      return new CustomProvider(input.baseUrl, input.apiKey, input.model);
  }
}
