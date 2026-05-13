/**
 * Terminal UI — Ink Implementation
 *
 * Same public API as the raw stdout version. Internally renders
 * a React component tree using Ink. The TerminalUI class acts as
 * a bridge between the imperative engine (which calls methods like
 * startAegisResponse/streamToken/endAegisResponse) and the
 * declarative React tree (which renders based on state).
 *
 * The banner is rendered as the first item in the conversation history
 * via Ink's <Static> region, so it persists at the top of the session
 * while the discovery conversation streams below it. The metadata block
 * shows version, attribution, update hint, and the three available
 * commands with their descriptions.
 */

import React, { useState, useEffect, useMemo } from "react";
import { render, Box, Text, Static, useInput } from "ink";
import stringWidth from "string-width";
import chalk from "chalk";
import {
  AEGIS_LOGO,
  SHIELD_ASSEMBLY_FRAMES,
  SHIELD_PULSE_FRAMES,
  THINKING_ANIMATIONS,
} from "./art.js";
import {
  CLI_COMMANDS,
  DISCOVERY_COMMANDS,
  formatSlashCommandGhost,
  getSlashCommandGhost,
  type SlashCommand,
  SESSION_COMMANDS,
} from "./commands.js";

// ── Color Palette (same as before) ─────────────────────────────────
const AEGIS_COLOR = chalk.hex("#5B8DEF");
const DIM = chalk.dim;
const ACCENT = chalk.hex("#5B8DEF");
const CHECK = chalk.hex("#A8D8A8");
const PROGRESS = chalk.hex("#FFD700");

// ── Layout Constants ───────────────────────────────────────────────
const GUTTER_WIDTH = 11;
const MIN_WIDTH_FOR_ASSEMBLY = 54;
const HEADER_RULE_WIDTH = 73;

// ── Brand Constants ────────────────────────────────────────────────
const AEGIS_TAGLINE = "Policy at the root. Enforcement at runtime. Accountability on every action.";
const UPDATE_COMMAND = "npm install -g aegis-cli@latest";

// ── Types ──────────────────────────────────────────────────────────
type ConversationItem =
  | { type: "aegis"; message: string }
  | { type: "aegis_line"; line: ConversationWrapLine }
  | { type: "aegis_end" }
  | { type: "user"; message: string }
  | { type: "note"; message: string }
  | { type: "heading"; message: string }
  | { type: "highlight"; message: string }
  | { type: "command"; message: string }
  | { type: "intro"; version: string; poweredBy: string }
  | { type: "files"; files: string[] }
  | { type: "visual"; content: string }
  | { type: "error"; message: string };

type MenuResult = { index: number } | { canceled: true };

type MenuRequest = {
  title: string;
  options: Array<{ label: string; current?: boolean }>;
  allowCancel?: boolean;
  cancelLabel?: string;
  resolve: (result: MenuResult) => void;
};

interface AppBridge {
  addToHistory: (item: ConversationItem) => void;
  setStreamLines: (lines: ConversationWrapLine[]) => void;
  setIsStreaming: (v: boolean) => void;
  setIsThinking: (v: boolean) => void;
  setThinkingMode: (mode: "thinking" | "extraction") => void;
  setInputPromptActive: (v: boolean) => void;
  setInputCommands: (commands: readonly SlashCommand[]) => void;
  setMenuRequest: (request: MenuRequest | null) => void;
  resolveInput: ((value: string) => void) | null;
}

// ── Word Wrapping ──────────────────────────────────────────────────

export function getWrapWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - GUTTER_WIDTH);
}

export function wrapText(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  return text
    .split("\n")
    .map((paragraph) => {
      if (stringWidth(paragraph) <= safeWidth) return paragraph;
      const words = paragraph.split(" ");
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length === 0) {
          const chunks = splitWordToWidth(word, safeWidth);
          current = chunks.pop() ?? "";
          lines.push(...chunks);
        } else if (stringWidth(`${current} ${word}`) <= safeWidth) {
          current += " " + word;
        } else {
          lines.push(current);
          const chunks = splitWordToWidth(word, safeWidth);
          current = chunks.pop() ?? "";
          lines.push(...chunks);
        }
      }
      if (current.length > 0) lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
}

function splitWordToWidth(word: string, width: number): string[] {
  if (stringWidth(word) <= width) return [word];

  const chunks: string[] = [];
  let current = "";
  for (const char of word) {
    if (current && stringWidth(current + char) > width) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export type ConversationWrapLine = {
  text: string;
  showLabel: boolean;
};

export function wrapConversationTurn(
  text: string,
  width: number
): ConversationWrapLine[] {
  return wrapText(text, width)
    .split("\n")
    .map((line, index) => ({
      text: line,
      showLabel: index === 0,
    }));
}

// ── Colorize Thinking (ported from original) ───────────────────────

function colorizeThinking(text: string): string {
  return text
    .replace(/\u25C7/g, DIM("\u25C7"))
    .replace(/\u25C6/g, PROGRESS("\u25C6"))
    .replace(/\u2713/g, CHECK("\u2713"))
    .replace(/ready/g, CHECK("ready"))
    .replace(/thinking\.\.\./g, DIM("thinking..."))
    .replace(/scanning repo\.\.\./g, DIM("scanning repo..."))
    .replace(/\.agentpolicy\//g, ACCENT(".agentpolicy/"))
    .replace(/\u25B3/g, ACCENT("\u25B3"))
    .replace(/V/g, ACCENT("V"));
}

// ── React Components ───────────────────────────────────────────────

function WrappedLines({
  text,
  barColor,
  label,
  dimText,
}: {
  text: string;
  barColor: string;
  label: string;
  dimText?: boolean;
}) {
  const lines = wrapConversationTurn(text, getWrapWidth());
  // Pad label to 5 chars so "aegis" and "you" align the same
  const paddedLabel = label.padEnd(5);
  const gap = "  "; // 2 spaces after label

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={barColor}>▎ </Text>
          {line.showLabel ? (
            <>
              <Text color={barColor}>{paddedLabel}</Text>
              <Text>{gap}</Text>
            </>
          ) : (
            <Text>{"       "}</Text>
          )}
          <Text dimColor={dimText}>{line.text}</Text>
        </Box>
      ))}
      <Box>
        <Text color={barColor}>▎</Text>
      </Box>
      <Text>{" "}</Text>
    </Box>
  );
}

function AegisTurn({ message }: { message: string }) {
  return <WrappedLines text={message} barColor="#5B8DEF" label="aegis" />;
}

function AegisLine({ line }: { line: ConversationWrapLine }) {
  return (
    <Box paddingLeft={2}>
      <Text color="#5B8DEF">▎ </Text>
      {line.showLabel ? (
        <>
          <Text color="#5B8DEF">aegis</Text>
          <Text>{"  "}</Text>
        </>
      ) : (
        <Text>{"       "}</Text>
      )}
      <Text>{line.text}</Text>
    </Box>
  );
}

function AegisEnd() {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box>
        <Text color="#5B8DEF">▎</Text>
      </Box>
      <Text>{" "}</Text>
    </Box>
  );
}

function UserTurn({ message }: { message: string }) {
  return (
    <WrappedLines text={message} barColor="#A8D8A8" label="you" dimText />
  );
}

// ── Banner Header ──────────────────────────────────────────────────
//
// Renders the wordmark, tagline, metadata block (version, attribution,
// update hint), and command reference at the top of every init session.

function BannerHeader({
  version,
  poweredBy,
}: {
  version: string;
  poweredBy: string;
}) {
  const logoLines = AEGIS_LOGO.split("\n");
  const rule = "─".repeat(HEADER_RULE_WIDTH);
  const labelWidth = 14; // pad labels so values align in a column

  return (
    <Box flexDirection="column">
      <Text>{" "}</Text>

      {/* Wordmark */}
      {logoLines.map((line, i) => {
        const isBlock =
          line.includes("\u2588") ||
          line.includes("\u2554") ||
          line.includes("\u2557") ||
          line.includes("\u255A") ||
          line.includes("\u255D") ||
          line.includes("\u2550");
        const isSubtitle = line.includes("governance for ai agents");

        if (isBlock) {
          return (
            <Text key={i} color="#5B8DEF">
              {line}
            </Text>
          );
        }
        if (isSubtitle) {
          return (
            <Text key={i} dimColor>
              {line}
            </Text>
          );
        }
        return <Text key={i}>{line}</Text>;
      })}

      <Text>{" "}</Text>

      {/* Tagline — white, full presence */}
      <Text>{"  " + AEGIS_TAGLINE}</Text>

      <Text>{" "}</Text>

      {/* Metadata block — bordered by aegis-blue rules */}
      <Text color="#5B8DEF">{"  " + rule}</Text>
      <Box>
        <Text>{"    "}</Text>
        <Text dimColor>{"version".padEnd(labelWidth)}</Text>
        <Text color="#5B8DEF">{`v${version}`}</Text>
      </Box>
      <Box>
        <Text>{"    "}</Text>
        <Text dimColor>{"powered by".padEnd(labelWidth)}</Text>
        <Text>{poweredBy}</Text>
      </Box>
      <Box>
        <Text>{"    "}</Text>
        <Text dimColor>{"update".padEnd(labelWidth)}</Text>
        <Text color="#FFD700">{UPDATE_COMMAND}</Text>
      </Box>
      <Text color="#5B8DEF">{"  " + rule}</Text>

      <Text>{" "}</Text>

      {/* Commands reference */}
      <Text color="#5B8DEF" bold>{"  cli commands:"}</Text>
      {CLI_COMMANDS.map((cmd, i) => (
        <Box key={i}>
          <Text>{"    "}</Text>
          <Text color="#FFD700">{cmd.name.padEnd(16)}</Text>
          <Text dimColor>{cmd.description}</Text>
        </Box>
      ))}
      <Text>{" "}</Text>
      <Text color="#5B8DEF" bold>{"  session commands:"}</Text>
      {SESSION_COMMANDS.map((cmd, i) => (
        <Box key={i}>
          <Text>{"    "}</Text>
          <Text color="#FFD700">{cmd.name.padEnd(16)}</Text>
          <Text dimColor>{cmd.description}</Text>
        </Box>
      ))}

      <Text>{" "}</Text>
    </Box>
  );
}

// ── Thinking Animation Component ───────────────────────────────────

function ThinkingDisplay({ mode = "thinking" }: { mode?: "thinking" | "extraction" }) {
  const [frameIndex, setFrameIndex] = useState(0);
  const animation = useMemo(() => {
    if (mode === "extraction") return SHIELD_ASSEMBLY_FRAMES;
    const cols = process.stdout.columns || 80;
    const animations =
      cols < MIN_WIDTH_FOR_ASSEMBLY
        ? [SHIELD_PULSE_FRAMES]
        : THINKING_ANIMATIONS;
    return animations[Math.floor(Math.random() * animations.length)];
  }, [mode]);

  useEffect(() => {
    setFrameIndex(0);
  }, [animation]);

  // Both modes keep moving until stopThinking unmounts this component.
  // Extraction can run for minutes, and a static final shield reads as
  // "stuck" even when the provider is still working.
  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((i) => {
        return nextThinkingFrameIndex(mode, i, animation.length);
      });
    }, 600);
    return () => {
      clearInterval(timer);
    };
  }, [animation, mode]);

  const frame = animation[Math.min(frameIndex, animation.length - 1)] ?? "";
  const colored = colorizeThinking(frame);

  return (
    <Box flexDirection="column">
      {colored.split("\n").map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

export function nextThinkingFrameIndex(
  mode: "thinking" | "extraction",
  current: number,
  frameCount: number
): number {
  if (frameCount <= 1) return 0;
  return (current + 1) % frameCount;
}

// ── Streaming Response Component ───────────────────────────────────

function StreamingResponse({ lines }: { lines: ConversationWrapLine[] }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="#5B8DEF">▎ </Text>
          {line.showLabel ? (
            <>
              <Text color="#5B8DEF">aegis</Text>
              <Text>{"  "}</Text>
            </>
          ) : (
            <Text>{"       "}</Text>
          )}
          <Text>{line.text}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function getStreamingResponseFrame(
  text: string,
  width: number,
  final = false
): { committed: ConversationWrapLine[]; live: ConversationWrapLine[] } {
  const lines = wrapConversationTurn(text, width);
  if (final) return { committed: lines, live: [] };
  if (lines.length <= 1) return { committed: [], live: lines };

  // Completed wrapped lines move into Static history as they form.
  // Only the current in-progress line stays dynamic, so long streams
  // visibly advance through scrollback once and never get re-rendered
  // as a duplicate full static block at completion.
  return {
    committed: lines.slice(0, -1),
    live: lines.slice(-1),
  };
}

// ── Input Prompt Component ─────────────────────────────────────────

const INPUT_PREFIX_WIDTH = stringWidth("  ▎ you    ");
const CURSOR_CHAR = "█";

function InputPrompt({
  bridge,
  commands,
}: {
  bridge: AppBridge;
  commands: readonly SlashCommand[];
}) {
  const [inputText, setInputText] = useState("");

  useInput((input, key) => {
    if (key.return) {
      const value = inputText;
      setInputText("");
      bridge.setInputPromptActive(false);
      if (bridge.resolveInput) {
        bridge.resolveInput(value);
        bridge.resolveInput = null;
      }
    } else if (key.backspace || key.delete) {
      setInputText((t) => t.slice(0, -1));
    } else if (!key.ctrl && !key.meta && input) {
      setInputText((t) => t + input);
    }
  });

  // Available width for input text + cursor, keeping everything on one line
  const cols = process.stdout.columns || 80;
  const availableWidth = Math.max(10, cols - INPUT_PREFIX_WIDTH);
  const inputWidth = Math.max(1, availableWidth - stringWidth(CURSOR_CHAR));
  const textWidth = stringWidth(inputText);
  // If text exceeds available space, show only the tail end
  const visibleText =
    textWidth <= inputWidth
      ? inputText
      : inputText.slice(inputText.length - inputWidth);
  const ghost = getSlashCommandGhost(inputText, commands);
  const ghostText = ghost
    ? formatSlashCommandGhost(ghost)
    : "";

  return (
    <Box paddingLeft={2}>
      <Text color="#A8D8A8">▎ </Text>
      <Text color="#A8D8A8">you  </Text>
      <Text>{"  "}</Text>
      <Box overflow="hidden" width={availableWidth}>
        <Text>{visibleText}</Text>
        <Text color="#5B8DEF">{CURSOR_CHAR}</Text>
        {ghostText && <Text dimColor>{ghostText}</Text>}
      </Box>
    </Box>
  );
}

function MenuPrompt({ request }: { request: MenuRequest }) {
  const [inputText, setInputText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finish = (result: MenuResult) => {
    setInputText("");
    setError(null);
    request.resolve(result);
  };

  useInput((input, key) => {
    if (key.escape && request.allowCancel) {
      finish({ canceled: true });
      return;
    }
    if (key.return) {
      const raw = inputText.trim();
      if (!raw && request.allowCancel) {
        finish({ canceled: true });
        return;
      }
      const selected = Number(raw);
      if (
        Number.isInteger(selected) &&
        selected >= 1 &&
        selected <= request.options.length
      ) {
        finish({ index: selected - 1 });
        return;
      }
      setError(`Enter a number from 1 to ${request.options.length}.`);
      return;
    }
    if (key.backspace || key.delete) {
      setInputText((text) => text.slice(0, -1));
      setError(null);
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setInputText((text) => text + input);
      setError(null);
    }
  });

  const cancelHint = request.allowCancel
    ? `, or ${request.cancelLabel ?? "press Enter to cancel"}`
    : "";

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>{" "}</Text>
      <Text color="#5B8DEF" bold>{`  ${request.title}`}</Text>
      <Text>{" "}</Text>
      {request.options.map((option, index) => (
        <Box key={index}>
          <Text>{"  "}</Text>
          <Text color="#FFD700">{`${index + 1}. `.padStart(4)}</Text>
          <Text>{option.label}</Text>
          {option.current && <Text dimColor>{" (current)"}</Text>}
        </Box>
      ))}
      <Text>{" "}</Text>
      <Box>
        <Text color="#A8D8A8">{"  Select a model by number"}</Text>
        <Text dimColor>{cancelHint}</Text>
        <Text>{": "}</Text>
        <Text>{inputText}</Text>
        <Text color="#5B8DEF">{CURSOR_CHAR}</Text>
      </Box>
      {error && <Text dimColor>{`  ${error}`}</Text>}
      <Text>{" "}</Text>
    </Box>
  );
}

// ── Main App Component ─────────────────────────────────────────────

function AegisApp({ bridge }: { bridge: AppBridge }) {
  const [history, setHistory] = useState<ConversationItem[]>([]);
  const [streamLines, setStreamLines] = useState<ConversationWrapLine[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<"thinking" | "extraction">("thinking");
  const [inputActive, setInputActive] = useState(false);
  const [inputCommands, setInputCommands] =
    useState<readonly SlashCommand[]>(DISCOVERY_COMMANDS);
  const [menuRequest, setMenuRequest] = useState<MenuRequest | null>(null);

  // Expose state setters to the bridge
  useEffect(() => {
    bridge.addToHistory = (item) => setHistory((h) => [...h, item]);
    bridge.setStreamLines = setStreamLines;
    bridge.setIsStreaming = setIsStreaming;
    bridge.setIsThinking = setIsThinking;
    bridge.setThinkingMode = setThinkingMode;
    bridge.setInputPromptActive = setInputActive;
    bridge.setInputCommands = setInputCommands;
    bridge.setMenuRequest = setMenuRequest;
  }, []);

  return (
    <Box flexDirection="column">
      {/* Permanent conversation history */}
      <Static items={history}>
        {(item, index) => {
          switch (item.type) {
            case "aegis":
              return <AegisTurn key={index} message={item.message} />;
            case "aegis_line":
              return <AegisLine key={index} line={item.line} />;
            case "aegis_end":
              return <AegisEnd key={index} />;
            case "user":
              return <UserTurn key={index} message={item.message} />;
            case "intro":
              return (
                <BannerHeader
                  key={index}
                  version={item.version}
                  poweredBy={item.poweredBy}
                />
              );
            case "note":
              return (
                <Box key={index} flexDirection="column">
                  <Text dimColor>{"  " + item.message}</Text>
                  <Text>{" "}</Text>
                </Box>
              );
            case "heading":
              return (
                <Box key={index} flexDirection="column">
                  <Text>{" "}</Text>
                  <Text color="#5B8DEF" bold>{"  " + item.message}</Text>
                  <Text>{" "}</Text>
                </Box>
              );
            case "highlight":
              return (
                <Box key={index} flexDirection="column">
                  <Text>{"  " + item.message}</Text>
                  <Text>{" "}</Text>
                </Box>
              );
            case "command":
              return (
                <Box key={index} flexDirection="column">
                  <Text color="#FFD700">{"  " + item.message}</Text>
                  <Text>{" "}</Text>
                </Box>
              );
            case "files":
              return (
                <Box key={index} flexDirection="column">
                  <Text>{" "}</Text>
                  {item.files.map((f, i) => (
                    <Text key={i} dimColor>
                      {"  → " + f}
                    </Text>
                  ))}
                  <Text>{" "}</Text>
                </Box>
              );
            case "visual":
              return (
                <Box key={index} flexDirection="column">
                  <Text>{" "}</Text>
                  {item.content.split("\n").map((line, i) => (
                    <Text key={i} dimColor>
                      {"  " + line}
                    </Text>
                  ))}
                  <Text>{" "}</Text>
                </Box>
              );
            case "error":
              return (
                <Box key={index} flexDirection="column">
                  <Text>{" "}</Text>
                  <Text>{"  " + item.message}</Text>
                  <Text>{" "}</Text>
                </Box>
              );
            default:
              return null;
          }
        }}
      </Static>

      {/* Dynamic region — streaming response */}
      {isStreaming && streamLines.length > 0 && (
        <StreamingResponse lines={streamLines} />
      )}

      {/* Dynamic region — thinking animation */}
      {isThinking && <ThinkingDisplay mode={thinkingMode} />}

      {/* Dynamic region — input prompt */}
      {inputActive && <InputPrompt bridge={bridge} commands={inputCommands} />}

      {/* Dynamic region — model menu */}
      {menuRequest && <MenuPrompt request={menuRequest} />}
    </Box>
  );
}

// ── TerminalUI Class — Bridge to Ink ───────────────────────────────

export class TerminalUI {
  private bridge: AppBridge;
  private inkInstance: ReturnType<typeof render> | null = null;
  private streamBuffer = "";
  private streamCommittedLineCount = 0;
  // Streaming commits wrapped lines into Static history as they
  // complete; freeze width for the turn so a terminal resize cannot
  // rewrap already-committed text into duplicate or skipped lines.
  private streamWrapWidth = getWrapWidth();
  private _thinkingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.bridge = {
      addToHistory: () => {},
      setStreamLines: () => {},
      setIsStreaming: () => {},
      setIsThinking: () => {},
      setThinkingMode: () => {},
      setInputPromptActive: () => {},
      setInputCommands: () => {},
      setMenuRequest: () => {},
      resolveInput: null,
    };
  }

  private ensureRendered(): void {
    if (!this.inkInstance) {
      // Ctrl+C under Ink needs explicit handling. Ink runs stdin in
      // raw mode, so Ctrl+C arrives as a 0x03 byte rather than a
      // process SIGINT, and useInput's (!key.ctrl && ...) filter
      // silently drops it. With exitOnCtrlC: true, Ink unmounts the
      // component tree when it sees 0x03 — but Ink's internal flow is
      // handleExit → onExit → unmount with no process.exit call, so
      // the lock cleanup registered in lock.ts (which fires on the
      // 'exit' event) would not actually run.
      //
      // The fix is the waitUntilExit hook below: once Ink has
      // unmounted, we force process.exit(0), which synchronously
      // emits 'exit' and triggers lock release. This also acts as
      // a safety net for normal shutdowns where the engine returned
      // and destroy() unmounted — process.exit is idempotent, so the
      // extra call is harmless if Node was already about to exit.
      const instance = render(
        React.createElement(AegisApp, { bridge: this.bridge }),
        { exitOnCtrlC: true }
      );
      this.inkInstance = instance;
      // Respect any exit code the outer command already decided on.
      // initCommand's error path sets process.exitCode before finally
      // runs ui.destroy — if we hardcoded 0/1 here, we would override
      // that signal and show the shell a success (or a generic 1)
      // regardless of what actually happened.
      instance
        .waitUntilExit()
        .then(() => process.exit(process.exitCode ?? 0))
        .catch(() => process.exit(process.exitCode ?? 1));
    }
  }

  // ── Intro Sequence ───────────────────────────────────────────────

  async playIntro(version: string, poweredBy: string): Promise<void> {
    this.ensureRendered();
    this.bridge.addToHistory({ type: "intro", version, poweredBy });
  }

  // ── Conversation ─────────────────────────────────────────────────

  showAegisMessage(message: string): void {
    this.bridge.addToHistory({ type: "aegis", message });
  }

  startAegisResponse(): void {
    this.streamBuffer = "";
    this.streamCommittedLineCount = 0;
    this.streamWrapWidth = getWrapWidth();
    this.bridge.setStreamLines([]);
    this.bridge.setIsStreaming(true);
  }

  streamToken(token: string): void {
    this.streamBuffer += token;
    const frame = getStreamingResponseFrame(this.streamBuffer, this.streamWrapWidth);
    const newCommitted = frame.committed.slice(this.streamCommittedLineCount);
    for (const line of newCommitted) {
      this.bridge.addToHistory({ type: "aegis_line", line });
    }
    this.streamCommittedLineCount = frame.committed.length;
    this.bridge.setStreamLines(frame.live);
  }

  endAegisResponse(): void {
    if (this.streamBuffer.length > 0) {
      const frame = getStreamingResponseFrame(this.streamBuffer, this.streamWrapWidth, true);
      const remaining = frame.committed.slice(this.streamCommittedLineCount);
      for (const line of remaining) {
        this.bridge.addToHistory({ type: "aegis_line", line });
      }
      this.bridge.addToHistory({ type: "aegis_end" });
    }
    this.bridge.setIsStreaming(false);
    this.bridge.setStreamLines([]);
    this.streamBuffer = "";
    this.streamCommittedLineCount = 0;
  }

  async getUserInput(
    commands: readonly SlashCommand[] = DISCOVERY_COMMANDS
  ): Promise<string> {
    this.ensureRendered();
    return new Promise((resolve) => {
      this.bridge.setInputCommands(commands);
      this.bridge.resolveInput = (value: string) => {
        if (value.trim().length > 0) {
          this.bridge.addToHistory({ type: "user", message: value });
        }
        resolve(value);
      };
      this.bridge.setInputPromptActive(true);
    });
  }

  async selectFromMenu(input: {
    title: string;
    options: Array<{ label: string; current?: boolean }>;
    allowCancel?: boolean;
    cancelLabel?: string;
  }): Promise<MenuResult> {
    this.ensureRendered();
    return new Promise((resolve) => {
      this.bridge.setMenuRequest({
        ...input,
        resolve: (result) => {
          this.bridge.setMenuRequest(null);
          resolve(result);
        },
      });
    });
  }

  // ── Thinking ─────────────────────────────────────────────────────

  startThinking(mode: "thinking" | "extraction" = "thinking"): void {
    this.bridge.setThinkingMode(mode);
    this._thinkingTimer = setTimeout(() => {
      this._thinkingTimer = null;
      this.bridge.setIsThinking(true);
    }, 2000);
  }

  stopThinking(): void {
    if (this._thinkingTimer) {
      clearTimeout(this._thinkingTimer);
      this._thinkingTimer = null;
      return;
    }
    this.bridge.setIsThinking(false);
  }

  // ── System Messages ──────────────────────────────────────────────

  /** Dim gray text — for supporting details and minor notes */
  showNote(message: string): void {
    this.bridge.addToHistory({ type: "note", message });
  }

  /** Bold Aegis blue — for section headers in the closing output */
  showHeading(message: string): void {
    this.bridge.addToHistory({ type: "heading", message });
  }

  /** Normal white text — for important content the user should read and act on */
  showHighlight(message: string): void {
    this.bridge.addToHistory({ type: "highlight", message });
  }

  /** Gold text — for commands the user should run */
  showCommand(message: string): void {
    this.bridge.addToHistory({ type: "command", message });
  }

  showFilesCreated(files: string[]): void {
    this.bridge.addToHistory({ type: "files", files });
  }

  showVisual(content: string): void {
    this.bridge.addToHistory({ type: "visual", content });
  }

  showError(message: string): void {
    this.bridge.addToHistory({ type: "error", message });
  }

  async destroy(): Promise<void> {
    this.stopThinking();
    if (this.inkInstance) {
      // Let Ink flush the final React render cycle (e.g. showFilesCreated/showNote
      // items added to <Static>) before tearing down the component tree.
      await sleep(500);
      this.inkInstance.unmount();
      // Idempotent — the init command's catch path may call destroy
      // explicitly before falling through to the finally block, which
      // calls it again. Clearing the instance here makes the second
      // call a no-op rather than an unmount-on-unmounted error.
      this.inkInstance = null;
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
