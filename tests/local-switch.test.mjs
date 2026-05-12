import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chatCompletion, jsonResponse, withMockFetch } from "./helpers.mjs";

test("/model Custom switch uses local discovery and persists active config", async () => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-local-switch-"));
  const aegisDir = path.join(home, ".aegis");
  const configPath = path.join(aegisDir, "config.json");

  try {
    process.env.HOME = home;
    fs.mkdirSync(aegisDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        activeProvider: "anthropic",
        providers: {
          anthropic: {
            apiKey: "anthropic-key",
            model: "claude-opus-4-7",
          },
        },
      })
    );

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

    const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(saved.activeProvider, "custom");
    assert.deepEqual(saved.providers.custom, {
      baseUrl: "http://localhost:11434/v1",
      model: "gemma3:26b",
    });
    assert.deepEqual(notes, []);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
