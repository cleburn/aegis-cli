export type SlashCommand = {
  name: string;
  description: string;
};

export type SlashCommandMatch =
  | { command: SlashCommand; expanded: boolean }
  | null;

export type SlashCommandGhost =
  | { command: SlashCommand; continuation: string; description: string }
  | null;

export const CLI_COMMANDS: readonly SlashCommand[] = [
  { name: "aegis init", description: "generate or update .agentpolicy/ for this project" },
  { name: "aegis explain", description: "plain-language summary of the current policy" },
  { name: "aegis validate", description: "check .agentpolicy/ files against the schemas" },
] as const;

export const SLASH_COMMANDS = {
  model: { name: "/model", description: "switch models during this discovery session" },
  exit: { name: "/exit", description: "leave the session without writing changes" },
  quit: { name: "/quit", description: "leave the session without writing changes" },
  done: { name: "/done", description: "finish this completed session" },
} as const satisfies Record<string, SlashCommand>;

export const SESSION_COMMANDS = [
  SLASH_COMMANDS.model,
  SLASH_COMMANDS.exit,
] as const;

export const DISCOVERY_COMMANDS = [
  SLASH_COMMANDS.model,
  SLASH_COMMANDS.exit,
  SLASH_COMMANDS.quit,
] as const;

export const POST_COMPLETION_COMMANDS = [
  SLASH_COMMANDS.exit,
  SLASH_COMMANDS.quit,
  SLASH_COMMANDS.done,
] as const;

export function resolveSlashCommand(
  input: string,
  commands: readonly SlashCommand[]
): SlashCommandMatch {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;

  const exact = commands.find((command) => command.name === normalized);
  if (exact) {
    return { command: exact, expanded: false };
  }

  const matches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(normalized)
  );
  if (matches.length !== 1) return null;

  return { command: matches[0], expanded: true };
}

export function formatSlashCommandMatch(command: SlashCommand): string {
  return `Matched ${command.name} - ${command.description}.`;
}

export function getSlashCommandGhost(
  input: string,
  commands: readonly SlashCommand[]
): SlashCommandGhost {
  if (!input.startsWith("/")) return null;

  const normalized = input.toLowerCase();
  const matches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(normalized)
  );
  if (matches.length !== 1) return null;

  const command = matches[0];
  return {
    command,
    continuation: command.name.slice(input.length),
    description: command.description,
  };
}
