#!/usr/bin/env node

/**
 * aegis — The best colleague you've ever had.
 *
 * Usage:
 *   aegis init       Start a discovery conversation and generate .agentpolicy/
 *   aegis explain    Have Aegis explain the current policy in plain language
 *   aegis validate   Validate policy files against the schemas
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { initCommand } from "../src/commands/init.js";
import { explainCommand } from "../src/commands/explain.js";
import { validateCommand } from "../src/commands/validate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// In production (`aegis` from a global install), this file is at
// `<install>/dist/bin/aegis.js` and package.json is two levels up.
// In dev (`npm run dev` → `tsx bin/aegis.ts`), the file is at
// `<repo>/bin/aegis.ts` and package.json is one level up. Try the
// production path first (the common case), then fall back to the
// dev path. A failure here is fatal — package.json is needed for
// the version banner and the update check — so let it throw with
// a clear message rather than silently degrade.
function readPackageJson(): { name: string; version: string } {
  const candidates = ["../../package.json", "../package.json"];
  let lastError: unknown;
  for (const rel of candidates) {
    try {
      return JSON.parse(readFileSync(join(__dirname, rel), "utf-8"));
    } catch (err) {
      lastError = err;
    }
  }
  const detail =
    lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(
    `Could not locate package.json from ${__dirname} (tried ${candidates.join(", ")}): ${detail}`
  );
}

const pkg = readPackageJson();

// ─── Update Checker ────────────────────────────────────────────────
// Non-blocking check against the npm registry. If a newer version
// exists, prints a one-line notice. If the check fails (offline,
// timeout, etc.), skips silently — never blocks the session.

async function checkForUpdate(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(
      `https://registry.npmjs.org/${pkg.name}/latest`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = await res.json() as { version?: string };
    const latest = data.version;
    if (!latest || latest === pkg.version) return;

    // Simple semver comparison — split into parts and compare numerically
    const current = pkg.version.split(".").map(Number);
    const remote = latest.split(".").map(Number);
    const isNewer =
      remote[0] > current[0] ||
      (remote[0] === current[0] && remote[1] > current[1]) ||
      (remote[0] === current[0] && remote[1] === current[1] && remote[2] > current[2]);

    if (isNewer) {
      process.stderr.write(
        `\n  Update available: ${pkg.version} → ${latest}\n` +
        `  Run: npm install -g ${pkg.name}@latest\n\n`
      );
    }
  } catch {
    // Silently skip — network issues should never block the CLI
  }
}

// ─── CLI Setup ─────────────────────────────────────────────────────

const program = new Command();

program
  .name("aegis")
  .description("The best colleague you've ever had — for every AI agent on your team.")
  .version(pkg.version);

program
  .command("init")
  .description("Start a discovery conversation and generate .agentpolicy/")
  .action(async () => {
    await initCommand();
  });

program
  .command("explain")
  .description("Have Aegis explain the current policy in plain language")
  .action(async () => {
    await explainCommand();
  });

program
  .command("validate")
  .description("Validate policy files against the Aegis schemas")
  .action(async () => {
    await validateCommand();
  });

// Check for updates before parsing commands
await checkForUpdate();
program.parse();
