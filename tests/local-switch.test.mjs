import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chatCompletion, jsonResponse, withMockFetch } from "./helpers.mjs";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-local-switch-"));
const testAegisDir = path.join(testHome, ".aegis");
const testConfigPath = path.join(testAegisDir, "config.json");

process.env.HOME = testHome;
process.once("exit", () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  fs.rmSync(testHome, { recursive: true, force: true });
});

test("/model Custom switch uses local discovery and persists active config", async () => {
  writeTestConfig({
    version: 1,
    activeProvider: "anthropic",
    providers: {
      anthropic: {
        apiKey: "anthropic-key",
        model: "claude-opus-4-7",
      },
    },
  });

  const suffix = `localSwitch=${Date.now()}-${Math.random()}`;
  const install = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/install.js")).href}?${suffix}`
  );
  const models = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
  );
  const restorePrompt = install.setInstallPromptForTests(async () => "1");
  const notes = [];
  const customIndex = models.MODEL_OPTIONS.findIndex(
    (option) => option.provider === "custom"
  );

  try {
    await withMockFetch([
      () => jsonResponse({ models: [{ name: "gemma3:26b" }] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse(chatCompletion("pong")),
    ], async () => {
      const result = await install.runModelSwitchFlow({
        showNote: (message) => notes.push(message),
        selectFromMenu: async () => ({ index: customIndex }),
      });

      assert.equal(result.switched, true);
      assert.equal(result.active.provider, "custom");
      assert.equal(result.active.baseUrl, "http://localhost:11434/v1");
      assert.equal(result.active.model, "gemma3:26b");
    });
  } finally {
    restorePrompt();
  }

  const saved = JSON.parse(fs.readFileSync(testConfigPath, "utf-8"));
  assert.equal(saved.activeProvider, "custom");
  assert.deepEqual(saved.providers.custom, {
    baseUrl: "http://localhost:11434/v1",
    model: "gemma3:26b",
  });
  assert.deepEqual(notes, []);
});

test("/model transport recovery can retry validation and switch", async () => {
  setupModelSwitchConfig();
  const suffix = `localSwitchRetry=${Date.now()}-${Math.random()}`;
  const install = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/install.js")).href}?${suffix}`
  );
  const models = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
  );
  const openAIIndex = models.MODEL_OPTIONS.findIndex(
    (option) => option.provider === "openai"
  );
  const notes = [];
  const menuSelections = [{ index: openAIIndex }, { index: 0 }];

  const restoreProviderFactory = install.setProviderFactoryForTests(
    () => new SequenceValidateProvider([
      { ok: false, reason: "transport", detail: "temporary validation failure" },
      { ok: true },
    ])
  );
  try {
    const result = await install.runModelSwitchFlow({
      showNote: (message) => notes.push(message),
      selectFromMenu: async () => menuSelections.shift(),
    });

    assert.equal(result.switched, true);
    assert.equal(result.active.provider, "openai");
    assert.ok(
      notes.some((note) =>
        note.includes("The credentials were not rejected; the request did not complete.")
      )
    );
  } finally {
    restoreProviderFactory();
  }
});

test("/model transport recovery abort keeps the current provider", async () => {
  setupModelSwitchConfig();
  const suffix = `localSwitchAbort=${Date.now()}-${Math.random()}`;
  const install = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/install.js")).href}?${suffix}`
  );
  const models = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
  );
  const openAIIndex = models.MODEL_OPTIONS.findIndex(
    (option) => option.provider === "openai"
  );
  const notes = [];
  const menuSelections = [{ index: openAIIndex }, { index: 3 }];

  const restoreProviderFactory = install.setProviderFactoryForTests(
    () => new SequenceValidateProvider([
      { ok: false, reason: "transport", detail: "temporary validation failure" },
    ])
  );
  try {
    const result = await install.runModelSwitchFlow({
      showNote: (message) => notes.push(message),
      selectFromMenu: async () => menuSelections.shift(),
    });

    assert.equal(result.switched, false);
    const saved = JSON.parse(fs.readFileSync(testConfigPath, "utf-8"));
    assert.equal(saved.activeProvider, "anthropic");
    assert.ok(
      notes.some((note) =>
        note.includes("The credentials were not rejected; the request did not complete.")
      )
    );
  } finally {
    restoreProviderFactory();
  }
});

test("/model transport recovery can save anyway", async () => {
  setupModelSwitchConfig();
  const suffix = `localSwitchSave=${Date.now()}-${Math.random()}`;
  const install = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/install.js")).href}?${suffix}`
  );
  const models = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
  );
  const openAIIndex = models.MODEL_OPTIONS.findIndex(
    (option) => option.provider === "openai"
  );
  const menuSelections = [{ index: openAIIndex }, { index: 2 }];

  const restoreProviderFactory = install.setProviderFactoryForTests(
    () => new SequenceValidateProvider([
      { ok: false, reason: "transport", detail: "temporary validation failure" },
    ])
  );
  try {
    const result = await install.runModelSwitchFlow({
      showNote: () => {},
      selectFromMenu: async () => menuSelections.shift(),
    });

    assert.equal(result.switched, true);
    assert.equal(result.active.provider, "openai");
    const saved = JSON.parse(fs.readFileSync(testConfigPath, "utf-8"));
    assert.equal(saved.activeProvider, "openai");
  } finally {
    restoreProviderFactory();
  }
});

test("/model transport recovery can pick a different model", async () => {
  setupModelSwitchConfig();
  const suffix = `localSwitchPickAgain=${Date.now()}-${Math.random()}`;
  const install = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/install.js")).href}?${suffix}`
  );
  const models = await import(
    `${pathToFileURL(path.resolve("dist/src/llm/models.js")).href}?${suffix}`
  );
  const openAIIndex = models.MODEL_OPTIONS.findIndex(
    (option) => option.provider === "openai"
  );
  const currentIndex = models.MODEL_OPTIONS.findIndex(
    (option) =>
      option.provider === "anthropic" && option.model === "claude-opus-4-7"
  );
  const menuSelections = [
    { index: openAIIndex },
    { index: 1 },
    { index: currentIndex },
  ];

  const restoreProviderFactory = install.setProviderFactoryForTests(
    () => new SequenceValidateProvider([
      { ok: false, reason: "transport", detail: "temporary validation failure" },
    ])
  );
  try {
    const result = await install.runModelSwitchFlow({
      showNote: () => {},
      selectFromMenu: async () => menuSelections.shift(),
    });

    assert.equal(result.switched, false);
    const saved = JSON.parse(fs.readFileSync(testConfigPath, "utf-8"));
    assert.equal(saved.activeProvider, "anthropic");
  } finally {
    restoreProviderFactory();
  }
});

class SequenceValidateProvider {
  name = "OpenAI";
  #results;

  constructor(results) {
    this.#results = [...results];
  }

  async validate() {
    const result = this.#results.shift();
    assert.ok(result, "validate should not be called more times than expected");
    return result;
  }

  async chat() {
    return "";
  }

  async chatJSON() {
    return {};
  }

  async chatStream() {
    return "";
  }
}

function setupModelSwitchConfig() {
  writeTestConfig({
    version: 1,
    activeProvider: "anthropic",
    providers: {
      anthropic: {
        apiKey: "anthropic-key",
        model: "claude-opus-4-7",
      },
      openai: {
        apiKey: "openai-key",
        model: "gpt-5.5",
      },
    },
  });
}

function writeTestConfig(config) {
  fs.mkdirSync(testAegisDir, { recursive: true });
  fs.writeFileSync(testConfigPath, JSON.stringify(config));
}
