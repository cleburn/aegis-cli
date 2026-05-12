import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCOVERY_COMMANDS,
  POST_COMPLETION_COMMANDS,
  resolveSlashCommand,
  formatSlashCommandMatch,
  getSlashCommandGhost,
} from "../dist/src/ui/commands.js";
import { AegisExit } from "../dist/src/abort.js";
import { handlePostCompletionSlashCommand } from "../dist/src/commands/init.js";
import { handleDiscoverySlashCommand } from "../dist/src/discovery/engine.js";

test("discovery slash commands resolve unique prefixes", () => {
  assertCommand(resolveSlashCommand("/m", DISCOVERY_COMMANDS), "/model", true);
  assertCommand(resolveSlashCommand("/M", DISCOVERY_COMMANDS), "/model", true);
  assertCommand(resolveSlashCommand("/e", DISCOVERY_COMMANDS), "/exit", true);
  assertCommand(resolveSlashCommand("/q", DISCOVERY_COMMANDS), "/quit", true);
});

test("post-completion slash commands include done", () => {
  assertCommand(resolveSlashCommand("/d", POST_COMPLETION_COMMANDS), "/done", true);
});

test("exact slash command matches do not expand", () => {
  assertCommand(resolveSlashCommand("/model", DISCOVERY_COMMANDS), "/model", false);
});

test("ambiguous and non-slash input does not resolve", () => {
  const commands = [
    { name: "/done", description: "finish" },
    { name: "/debug", description: "debug" },
  ];
  assert.equal(resolveSlashCommand("/d", commands), null);
  assert.equal(resolveSlashCommand("hello world", DISCOVERY_COMMANDS), null);
});

test("slash command confirmation includes name and description", () => {
  const match = resolveSlashCommand("/m", DISCOVERY_COMMANDS);
  assert.ok(match);
  assert.equal(
    formatSlashCommandMatch(match.command),
    "Matched /model - switch models during this discovery session."
  );
});

test("slash command ghost text resolves unique prefixes", () => {
  assert.deepEqual(getSlashCommandGhost("/m", DISCOVERY_COMMANDS), {
    command: DISCOVERY_COMMANDS[0],
    continuation: "odel",
    description: "switch models during this discovery session",
  });
  assert.equal(getSlashCommandGhost("/x", DISCOVERY_COMMANDS), null);
  assert.equal(getSlashCommandGhost("hello", DISCOVERY_COMMANDS), null);

  const exact = getSlashCommandGhost("/model", DISCOVERY_COMMANDS);
  assert.ok(exact);
  assert.equal(exact.continuation, "");
  assert.equal(exact.description, "switch models during this discovery session");

  assert.equal(
    getSlashCommandGhost("/d", [
      { name: "/done", description: "finish" },
      { name: "/debug", description: "debug" },
    ]),
    null
  );
});

test("post-completion slash command ghost text uses post-completion commands", () => {
  assert.deepEqual(getSlashCommandGhost("/d", POST_COMPLETION_COMMANDS), {
    command: POST_COMPLETION_COMMANDS[2],
    continuation: "one",
    description: "finish this completed session",
  });
});

test("discovery command handler runs model switch for prefix match", async () => {
  const notes = [];
  let switched = false;
  const handled = await handleDiscoverySlashCommand(
    "/m",
    { showNote: (message) => notes.push(message) },
    async () => {
      switched = true;
    }
  );

  assert.equal(handled, true);
  assert.equal(switched, true);
  assert.deepEqual(notes, [
    "Matched /model - switch models during this discovery session.",
  ]);
});

test("discovery command handler keeps exact model match silent", async () => {
  const notes = [];
  let switched = false;
  const handled = await handleDiscoverySlashCommand(
    "/model",
    { showNote: (message) => notes.push(message) },
    async () => {
      switched = true;
    }
  );

  assert.equal(handled, true);
  assert.equal(switched, true);
  assert.deepEqual(notes, []);
});

test("discovery command handler exits for exit and quit prefixes", async () => {
  await assert.rejects(
    () => handleDiscoverySlashCommand("/e", { showNote: () => {} }, async () => {}),
    AegisExit
  );
  await assert.rejects(
    () => handleDiscoverySlashCommand("/q", { showNote: () => {} }, async () => {}),
    AegisExit
  );
});

test("post-completion command handler closes on done prefix", () => {
  const notes = [];
  const handled = handlePostCompletionSlashCommand("/d", {
    showNote: (message) => notes.push(message),
  });

  assert.equal(handled, true);
  assert.deepEqual(notes, [
    "Matched /done - finish this completed session.",
    "Session closed. See you next time.",
  ]);
});

function assertCommand(match, name, expanded) {
  assert.ok(match);
  assert.equal(match.command.name, name);
  assert.equal(match.expanded, expanded);
}
