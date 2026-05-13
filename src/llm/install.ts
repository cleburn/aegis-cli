import { AegisExit } from "../abort.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import {
  CustomProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./openai-compatible.js";
import type { LLMProvider, ProviderValidateResult } from "./provider.js";
import { MODEL_OPTIONS, type ModelOption } from "./models.js";
import {
  discoverLocalModels,
  type LocalModelDiscovery,
} from "./local-discovery.js";
import {
  hasGoogleOAuthTokens,
  runGoogleOAuthFlow,
} from "./google-oauth.js";
import type { TerminalUI } from "../ui/terminal.js";
import {
  getActiveProviderConfig,
  getGoogleApiKeyEnvConflicts,
  getProviderEnvVar,
  getProviderEnvValue,
  prompt as readPrompt,
  readConfig,
  saveProviderConfig,
  type ActiveProviderConfig,
  type ProviderConfigInput,
} from "../config/api-key.js";

type InstallResult = "saved" | "pick-again";
type ValidationResult = InstallResult | "auth" | "canceled";
type ModelSelection = { option: ModelOption; keepCurrent: boolean };
type SelectModelOptions = {
  current?: ActiveProviderConfig;
  emptyCancels?: boolean;
};
export type ModelSwitchResult =
  | { switched: true; active: ActiveProviderConfig }
  | { switched: false };
type ModelSwitchUI = Pick<TerminalUI, "showNote" | "selectFromMenu">;
type RecoverySurface =
  | { mode: "console"; cancelReturns?: boolean }
  | { mode: "session"; ui: ModelSwitchUI };

const CHOOSE_MODEL_HEADER = "  Choose the model Aegis should use.";

export type PromptFn = (
  question: string,
  hidden?: boolean
) => Promise<string>;

let prompt: PromptFn = readPrompt;
let providerFactory: (input: ProviderConfigInput) => LLMProvider =
  defaultProviderFromInput;

export function setInstallPromptForTests(nextPrompt: PromptFn): () => void {
  const previous = prompt;
  prompt = nextPrompt;
  return () => {
    prompt = previous;
  };
}

export function setProviderFactoryForTests(
  nextFactory: (input: ProviderConfigInput) => LLMProvider
): () => void {
  const previous = providerFactory;
  providerFactory = nextFactory;
  return () => {
    providerFactory = previous;
  };
}

export function hasUsableActiveProvider(active: ActiveProviderConfig): boolean {
  if (active.provider === "custom") {
    return Boolean(active.baseUrl);
  }
  if (active.provider === "google" && active.authMethod === "oauth") {
    return !active.reauthRequired && hasGoogleOAuthTokens();
  }
  return Boolean(active.apiKey);
}

export async function runProviderInstallFlow(): Promise<ActiveProviderConfig> {
  console.log("");
  console.log(CHOOSE_MODEL_HEADER);

  while (true) {
    const { option } = await selectModel();
    const result = await configureAndValidate(option, { preferStored: false });
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

export async function confirmProviderForInit(): Promise<ActiveProviderConfig> {
  const active = getActiveProviderConfig();
  if (requiresGoogleReauth(active)) {
    console.log("");
    console.log("  Aegis no longer requires gcloud for Google. Sign in with Google to continue, or choose the API-key path.");
    return configureExistingGoogleProvider(active);
  }
  if (!hasUsableActiveProvider(active)) {
    return runProviderInstallFlow();
  }

  console.log("");
  if (!hasCurrentModel(active)) {
    console.log(CHOOSE_MODEL_HEADER);
    while (true) {
      const { option } = await selectModel();
      const result = await configureAndValidate(option, {
        preferStored: true,
      });
      if (result === "saved") {
        return getActiveProviderConfig();
      }
    }
  }

  console.log("  Confirm the model Aegis should use for this session.");

  while (true) {
    const selection = await selectModel({ current: active });
    if (selection.keepCurrent) {
      return active;
    }
    const result = await configureAndValidate(selection.option, {
      preferStored: true,
    });
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

async function configureExistingGoogleProvider(
  active: ActiveProviderConfig
): Promise<ActiveProviderConfig> {
  const option = googleOptionForActive(active);
  while (true) {
    const result = await configureAndValidate(option, { preferStored: false });
    if (result === "saved") {
      return getActiveProviderConfig();
    }
  }
}

function requiresGoogleReauth(active: ActiveProviderConfig): boolean {
  return active.provider === "google" && Boolean(active.reauthRequired);
}

function googleOptionForActive(active: ActiveProviderConfig): ModelOption {
  return MODEL_OPTIONS.find(
    (option) => option.provider === "google" && option.model === active.model
  ) ?? MODEL_OPTIONS.find((option) => option.provider === "google")!;
}

export async function runModelSwitchFlow(
  ui: ModelSwitchUI
): Promise<ModelSwitchResult> {
  const active = getActiveProviderConfig();
  while (true) {
    const selection = await selectModelInSession(ui, active);
    if (selection.keepCurrent) {
      ui.showNote("Keeping the current model.");
      return { switched: false };
    }

    const input = inputFromStoredConfig(selection.option);
    if (!input) {
      if (selection.option.provider === "custom") {
        const result = await configureAndValidate(selection.option, {
          preferStored: false,
          cancelReturns: true,
        });
        return result === "saved"
          ? { switched: true, active: getActiveProviderConfig() }
          : { switched: false };
      }
      ui.showNote(
        `${selection.option.label} isn't configured yet. /exit and run aegis init to set up credentials for a new provider.`
      );
      return { switched: false };
    }

    const result = await validateProviderConfig(input, selection.option, {
      mode: "session",
      ui,
    });
    if (result === "saved") {
      return { switched: true, active: getActiveProviderConfig() };
    }
    if (result === "pick-again") {
      continue;
    }
    if (result === "auth") {
      ui.showNote("Staying on the current model.");
    }
    return { switched: false };
  }
}

async function selectModelInSession(
  ui: ModelSwitchUI,
  active: ActiveProviderConfig
): Promise<ModelSelection> {
  const currentIndex = currentModelIndex(active);
  const result = await ui.selectFromMenu({
    title: "Choose a model for the rest of this session.",
    options: MODEL_OPTIONS.map((option, index) => ({
      label: option.label,
      current: index === currentIndex,
    })),
    allowCancel: true,
    cancelLabel: "press Enter or Esc to cancel",
  });

  if ("canceled" in result) {
    const option =
      currentIndex >= 0 ? MODEL_OPTIONS[currentIndex] : MODEL_OPTIONS[0];
    return { option, keepCurrent: true };
  }

  const option = MODEL_OPTIONS[result.index];
  return {
    option,
    keepCurrent: optionIsCurrent(active, option),
  };
}

async function selectModel(
  options: SelectModelOptions = {}
): Promise<ModelSelection> {
  const current = options.current;
  const currentIndex = current ? currentModelIndex(current) : -1;
  console.log("");
  MODEL_OPTIONS.forEach((option, index) => {
    const marker = index === currentIndex ? " (current)" : "";
    console.log(`  ${index + 1}. ${option.label}${marker}`);
  });
  console.log("");

  while (true) {
    const emptyAction = options.emptyCancels
      ? "cancel"
      : currentIndex >= 0
        ? "keep current"
        : null;
    const raw = await prompt(
      emptyAction
        ? `  Select a model by number, or press Enter to ${emptyAction}: `
        : "  Select a model by number: "
    );
    if (!raw && current && options.emptyCancels) {
      const option = currentIndex >= 0
        ? MODEL_OPTIONS[currentIndex]
        : MODEL_OPTIONS[0];
      return { option, keepCurrent: true };
    }
    if (!raw && current && currentIndex >= 0) {
      return {
        option: MODEL_OPTIONS[currentIndex],
        keepCurrent: true,
      };
    }
    if (!raw) {
      throw new AegisExit(130, "Model selection canceled.");
    }

    const selected = Number(raw);
    if (Number.isInteger(selected) && selected >= 1 && selected <= MODEL_OPTIONS.length) {
      const option = MODEL_OPTIONS[selected - 1];
      return {
        option,
        keepCurrent: current ? optionIsCurrent(current, option) : false,
      };
    }

    console.log(`  Enter a number from 1 to ${MODEL_OPTIONS.length}.`);
  }
}

function optionIsCurrent(
  active: ActiveProviderConfig,
  option: ModelOption
): boolean {
  if (active.provider === "custom") return option.provider === "custom";
  return option.provider === active.provider && option.model === active.model;
}

async function configureAndValidate(
  option: ModelOption,
  options: { preferStored: boolean; cancelReturns?: boolean }
): Promise<InstallResult | "canceled"> {
  let input = options.preferStored ? inputFromStoredConfig(option) : null;
  while (true) {
    try {
      input ??= await promptForConfig(option);
    } catch (err) {
      if (options.cancelReturns && err instanceof AegisExit) {
        return "canceled";
      }
      throw err;
    }
    const result = await validateProviderConfig(input, option, {
      mode: "console",
      cancelReturns: options.cancelReturns,
    });
    if (result === "saved" || result === "pick-again" || result === "canceled") {
      return result;
    }
    if (result === "auth") {
      input = null;
    }
  }
}

async function validateProviderConfig(
  input: ProviderConfigInput,
  option: ModelOption,
  surface: RecoverySurface
): Promise<ValidationResult> {
  const provider = providerFactory(input);

  while (true) {
    showValidationMessage(surface, `Verifying ${option.label}...`);
    const validation = await provider.validate();
    if (validation.ok) {
      saveProviderConfig(input);
      showValidationMessage(surface, "Saved to ~/.aegis/config.json.");
      return "saved";
    }

    if (validation.reason === "auth") {
      showValidationMessage(
        surface,
        surface.mode === "console"
          ? `${provider.name} rejected those credentials. Re-enter them to try again.`
          : `${provider.name} rejected the configured credentials.`
      );
      return "auth";
    }

    const recovery = await promptTransportRecovery(
      provider,
      {
        ok: false,
        reason: "transport",
        ...(validation.detail ? { detail: validation.detail } : {}),
      },
      surface
    );
    if (recovery === "retry") {
      continue;
    }
    if (recovery === "save") {
      saveProviderConfig(input);
      showValidationMessage(
        surface,
        "Saved to ~/.aegis/config.json without validation."
      );
      return "saved";
    }
    if (recovery === "pick-again") {
      return "pick-again";
    }
    if (surface.mode === "session" || surface.cancelReturns) {
      return "canceled";
    }
    throw new AegisExit(130, "Provider setup canceled.");
  }
}

function showValidationMessage(surface: RecoverySurface, message: string): void {
  if (surface.mode === "session") {
    surface.ui.showNote(message);
    return;
  }
  console.log(`  ${message}`);
}

function currentModelIndex(active: ActiveProviderConfig): number {
  const index = MODEL_OPTIONS.findIndex((option) => {
    if (active.provider === "custom") return option.provider === "custom";
    return option.provider === active.provider && option.model === active.model;
  });
  if (index >= 0) return index;
  if (!active.model) {
    return MODEL_OPTIONS.findIndex((option) => option.provider === active.provider);
  }
  return -1;
}

function hasCurrentModel(active: ActiveProviderConfig): boolean {
  return Boolean(active.model);
}

async function promptForConfig(option: ModelOption): Promise<ProviderConfigInput> {
  if (option.provider === "custom") {
    return promptForLocalModelConfig();
  }
  if (option.provider === "google") {
    return promptForGoogleConfig(option);
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

export async function promptForLocalModelConfig(): Promise<ProviderConfigInput> {
  const discovered = await discoverLocalModels();
  if (discovered.length === 0) {
    console.log(
      "  No local models found on Ollama, LM Studio, llama.cpp, or vLLM. Start a local server to enable auto-discovery, or enter details manually."
    );
    return promptForManualLocalModelConfig();
  }

  console.log("");
  console.log("  Found local models:");
  discovered.forEach((model, index) => {
    console.log(`  ${index + 1}. ${model.source}: ${model.model}`);
  });
  const manualIndex = discovered.length + 1;
  console.log(`  ${manualIndex}. Enter URL manually`);
  console.log("");

  while (true) {
    const raw = await prompt("  Select a local model by number: ");
    if (!raw) {
      throw new AegisExit(130, "Local model selection canceled.");
    }
    const selected = Number(raw);
    if (
      Number.isInteger(selected) &&
      selected >= 1 &&
      selected <= discovered.length
    ) {
      return providerInputFromDiscoveredModel(discovered[selected - 1]);
    }
    if (selected === manualIndex) {
      return promptForManualLocalModelConfig();
    }
    console.log(`  Enter a number from 1 to ${manualIndex}.`);
  }
}

function providerInputFromDiscoveredModel(
  model: LocalModelDiscovery
): ProviderConfigInput {
  return {
    provider: "custom",
    baseUrl: model.baseUrl,
    model: model.model,
  };
}

async function promptForManualLocalModelConfig(): Promise<ProviderConfigInput> {
  const baseUrl = (await prompt("  Local server base URL: ")).trim();
  if (!baseUrl) {
    throw new AegisExit(130, "Local model server base URL is required.");
  }

  const model = (await prompt("  Local model ID: ")).trim();
  if (!model) {
    throw new AegisExit(130, "Local model ID is required.");
  }

  const apiKey = (await prompt("  API key, if your local server requires one (optional): ", true)).trim();
  return {
    provider: "custom",
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model,
  };
}

async function promptForGoogleConfig(
  option: ModelOption
): Promise<ProviderConfigInput> {
  console.log("  Google Gemini supports signing in with your Google account or using an API key.");
  console.log("  1. Sign in with Google");
  console.log("  2. Use a Google API key");
  console.log("");

  while (true) {
    const raw = await prompt("  Google auth method (Enter = Google sign-in, 2 = API key): ");
    if (!raw || raw === "1") {
      const conflicts = getGoogleApiKeyEnvConflicts();
      if (conflicts.length > 0) {
        console.log(
          `  Google sign-in cannot be used while ${conflicts.join(
            " or "
          )} is set. Unset those variables or choose option 2 for the API-key path.`
        );
        continue;
      }
      console.log("  Opening your browser to sign in with Google...");
      await runGoogleOAuthFlow();
      return {
        provider: "google",
        authMethod: "oauth",
        model: option.model,
      };
    }
    if (raw === "2") {
      const envVar = getProviderEnvVar("google");
      console.log(`  API key required. You can also use ${envVar} after setup.`);
      const apiKey = (await prompt("  API key: ", true)).trim();
      if (!apiKey) {
        throw new AegisExit(130, `${option.label} API key is required.`);
      }
      return {
        provider: "google",
        authMethod: "apiKey",
        apiKey,
        model: option.model,
      };
    }

    console.log("  Enter 1 to sign in with Google or 2 for an API key.");
  }
}

async function promptTransportRecovery(
  provider: LLMProvider,
  validation: { ok: false; reason: "transport"; detail?: string },
  surface: RecoverySurface
): Promise<"retry" | "pick-again" | "save" | "abort"> {
  const message = `Couldn't verify with ${provider.name}${
    validation.detail ? ` - ${validation.detail}` : ""
  }. The credentials were not rejected; the request did not complete.`;
  if (surface.mode === "session") {
    surface.ui.showNote(message);
    const result = await surface.ui.selectFromMenu({
      title: "Choose how to handle the validation failure.",
      options: [
        { label: "Retry validation" },
        { label: "Pick a different model" },
        { label: "Save anyway" },
        { label: "Abort" },
      ],
      allowCancel: true,
      cancelLabel: "press Enter or Esc to abort",
    });
    if ("canceled" in result) return "abort";
    return recoveryActionForIndex(result.index);
  }

  console.log(`  ${message}`);
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

function recoveryActionForIndex(
  index: number
): "retry" | "pick-again" | "save" | "abort" {
  switch (index) {
    case 0:
      return "retry";
    case 1:
      return "pick-again";
    case 2:
      return "save";
    default:
      return "abort";
  }
}

function defaultProviderFromInput(input: ProviderConfigInput): LLMProvider {
  switch (input.provider) {
    case "anthropic":
      return new AnthropicProvider(input.apiKey, input.model);
    case "openai":
      return new OpenAIProvider(input.apiKey, input.model);
    case "google":
      return input.authMethod === "oauth"
        ? new GoogleProvider({ authMethod: "oauth", model: input.model })
        : new GoogleProvider(input.apiKey, input.model);
    case "deepseek":
      return new DeepSeekProvider(input.apiKey, input.model);
    case "custom":
      return new CustomProvider(input.baseUrl, input.apiKey, input.model);
  }
}

function inputFromStoredConfig(option: ModelOption): ProviderConfigInput | null {
  const stored = readConfig().providers[option.provider];
  const envKey = getProviderEnvValue(option.provider);

  if (option.provider === "google") {
    if (stored?.authMethod === "oauth" && !stored.reauthRequired && hasGoogleOAuthTokens()) {
      return {
        provider: "google",
        authMethod: "oauth",
        model: option.model,
      };
    }
    const apiKey = envKey ?? stored?.apiKey;
    if (!apiKey) return null;
    return {
      provider: "google",
      authMethod: "apiKey",
      apiKey,
      model: option.model,
    };
  }

  if (option.provider === "custom") {
    if (!stored?.baseUrl || !stored.model) return null;
    return {
      provider: "custom",
      baseUrl: stored.baseUrl,
      ...(envKey || stored.apiKey ? { apiKey: envKey ?? stored.apiKey } : {}),
      model: stored.model,
    };
  }

  const apiKey = envKey ?? stored?.apiKey;
  if (!apiKey) return null;
  return {
    provider: option.provider,
    apiKey,
    model: option.model,
  };
}
