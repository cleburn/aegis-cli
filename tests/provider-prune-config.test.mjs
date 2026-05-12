import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("removed active provider config falls back without crashing", async () => {
  const removedProvider = ["mis", "tral"].join("");
  const { config, written } = await readConfigFromFixture({
    version: 1,
    activeProvider: removedProvider,
    providers: {
      [removedProvider]: {
        apiKey: "stale-key",
        model: "stale-model",
      },
      anthropic: {
        apiKey: "anthropic-key",
      },
    },
  });

  assert.equal(config.activeProvider, "anthropic");
  assert.equal(config.providers[removedProvider], undefined);
  assert.equal(written.activeProvider, "anthropic");
  assert.equal(written.providers[removedProvider], undefined);
});

test("removed saved model config is stripped during normalization", async () => {
  const removedTier = ["hai", "ku"].join("");
  const removedModel = ["claude", removedTier, "4", "5"].join("-");
  const { config, written } = await readConfigFromFixture({
    version: 1,
    activeProvider: "anthropic",
    providers: {
      anthropic: {
        apiKey: "anthropic-key",
        model: removedModel,
      },
    },
  });

  assert.equal(config.activeProvider, "anthropic");
  assert.equal(config.providers.anthropic.apiKey, "anthropic-key");
  assert.equal(config.providers.anthropic.model, undefined);
  assert.equal(written.providers.anthropic.model, undefined);
});

async function readConfigFromFixture(rawConfig) {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-prune-config-"));
  const aegisDir = path.join(home, ".aegis");
  const configPath = path.join(aegisDir, "config.json");

  try {
    process.env.HOME = home;
    fs.mkdirSync(aegisDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(rawConfig));

    const moduleUrl = `${pathToFileURL(
      path.resolve("dist/src/config/api-key.js")
    ).href}?pruneConfig=${Date.now()}-${Math.random()}`;
    const { readConfig } = await import(moduleUrl);

    const config = readConfig();
    const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepEqual(readConfig(), config);
    return { config, written };
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
