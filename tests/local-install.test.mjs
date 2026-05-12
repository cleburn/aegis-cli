import assert from "node:assert/strict";
import test from "node:test";
import {
  promptForLocalModelConfig,
  setInstallPromptForTests,
} from "../dist/src/llm/install.js";
import { jsonResponse, withMockFetch } from "./helpers.mjs";

test("Custom install path uses discovered local model selection", async () => {
  const prompts = [];
  const restorePrompt = setInstallPromptForTests(async (question) => {
    prompts.push(question);
    return "1";
  });

  try {
    await withMockFetch([
      () => jsonResponse({ models: [{ name: "gemma3:26b" }] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
    ], async () => {
      const input = await promptForLocalModelConfig();
      assert.deepEqual(input, {
        provider: "custom",
        baseUrl: "http://localhost:11434/v1",
        model: "gemma3:26b",
      });
    });
    assert.deepEqual(prompts, ["  Select a local model by number: "]);
  } finally {
    restorePrompt();
  }
});

test("Custom install path can fall through to manual entry", async () => {
  const answers = [
    "2",
    "http://localhost:9999/v1",
    "manual-model",
    "manual-key",
  ];
  const prompts = [];
  const restorePrompt = setInstallPromptForTests(async (question) => {
    prompts.push(question);
    return answers.shift() ?? "";
  });

  try {
    await withMockFetch([
      () => jsonResponse({ models: [] }),
      () => jsonResponse({ data: [{ id: "qwen2.5-coder-32b" }] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
    ], async () => {
      const input = await promptForLocalModelConfig();
      assert.deepEqual(input, {
        provider: "custom",
        baseUrl: "http://localhost:9999/v1",
        apiKey: "manual-key",
        model: "manual-model",
      });
    });
    assert.deepEqual(prompts, [
      "  Select a local model by number: ",
      "  Local server base URL: ",
      "  Local model ID: ",
      "  API key, if your local server requires one (optional): ",
    ]);
  } finally {
    restorePrompt();
  }
});

test("Custom install path falls through to manual entry on empty discovery", async () => {
  const answers = ["http://localhost:11434/v1", "gemma3:26b", ""];
  const prompts = [];
  const restorePrompt = setInstallPromptForTests(async (question) => {
    prompts.push(question);
    return answers.shift() ?? "";
  });

  try {
    await withMockFetch([
      () => jsonResponse({ models: [] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
      () => jsonResponse({ data: [] }),
    ], async () => {
      const input = await promptForLocalModelConfig();
      assert.deepEqual(input, {
        provider: "custom",
        baseUrl: "http://localhost:11434/v1",
        model: "gemma3:26b",
      });
    });
    assert.deepEqual(prompts, [
      "  Local server base URL: ",
      "  Local model ID: ",
      "  API key, if your local server requires one (optional): ",
    ]);
  } finally {
    restorePrompt();
  }
});
