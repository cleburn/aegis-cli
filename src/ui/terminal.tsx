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

import React, { useState, useEffect } from "react";
import { render, Box, Text, Static, useInput } from "ink";
import stringWidth from "string-width";
import chalk from "chalk";
import {
  AEGIS_LOGO,
  SHIELD_ASSEMBLY_FRAMES,
  SHIELD_PULSE_FRAMES,
  THINKING_ANIMATIONS,
} from "./art.js";

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
const POWERED_BY = "Claude Opus 4.7";
const UPDATE_COMMAND = "npm install -g aegis-cli@latest";

const COMMANDS: Array<{ name: string; description: string }> = [
  { name: "aegis init", description: "generate or update .agentpolicy/ for this project" },
  { name: "aegis explain", description: "plain-language summary of the current policy" },
  { name: "aegis validate", description: "check .agentpolicy/ files against the schemas" },
];

// ── Types ──────────────────────────────────────────────────────────
type ConversationItem =
  | { type: "aegis"; message: string }
  | { type: "user"; message: string }
  | { type: "note"; message: string }
  | { type: "heading"; message: string }
  | { type: "highlight"; message: string }
  | { type: "command"; message: string }
  | { type: "intro"; mode: "full" | "quiet"; version: string }
  | { type: "files"; files: string[] }
  | { type: "visual"; content: string }
  | { type: "error"; message: string };

interface AppBridge {
  addToHistory: (item: ConversationItem) => void;
  setStreamBuffer: (text: string) => void;
  setIsStreaming: (v: boolean) => void;
  setIsThinking: (v: boolean) => void;
  setThinkingMode: (mode: "thinking" | "extraction") => void;
  setInputPromptActive: (v: boolean) => void;
  resolveInput: ((value: string) => void) | null;
}

// ── Word Wrapping ──────────────────────────────────────────────────

function getWrapWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - GUTTER_WIDTH);
}

function wrapText(text: string, width: number): string {
  return text
    .split("\n")
    .map((paragraph) => {
      if (paragraph.length <= width) return paragraph;
      const words = paragraph.split(" ");
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current.length === 0) {
          current = word;
        } else if (current.length + 1 + word.length <= width) {
          current += " " + word;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current.length > 0) lines.push(current);
      return lines.join("\n");
    })
    .join("\n");
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
  const wrapped = wrapText(text, getWrapWidth());
  const lines = wrapped.split("\n");
  // Pad label to 5 chars so "aegis" and "you" align the same
  const paddedLabel = label.padEnd(5);
  const gap = "  "; // 2 spaces after label

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color={barColor}>▎ </Text>
          {i === 0 ? (
            <>
              <Text color={barColor}>{paddedLabel}</Text>
              <Text>{gap}</Text>
            </>
          ) : (
            <Text>{"       "}</Text>
          )}
          <Text dimColor={dimText}>{line}</Text>
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

function UserTurn({ message }: { message: string }) {
  return (
    <WrappedLines text={message} barColor="#A8D8A8" label="you" dimText />
  );
}

// ── Banner Header ──────────────────────────────────────────────────
//
// Renders the wordmark, tagline, metadata block (version, attribution,
// update hint), and command reference at the top of the conversation.
// Both first-time and return visit modes use this — the `mode` flag is
// preserved for any future divergence but currently renders the same
// content in both cases.

function BannerHeader({ version }: { version: string; mode: "full" | "quiet" }) {
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
        <Text>{POWERED_BY}</Text>
      </Box>
      <Box>
        <Text>{"    "}</Text>
        <Text dimColor>{"update".padEnd(labelWidth)}</Text>
        <Text color="#FFD700">{UPDATE_COMMAND}</Text>
      </Box>
      <Text color="#5B8DEF">{"  " + rule}</Text>

      <Text>{" "}</Text>

      {/* Commands reference */}
      <Text color="#5B8DEF" bold>{"  commands:"}</Text>
      {COMMANDS.map((cmd, i) => (
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
  const [animation] = useState(() => {
    if (mode === "extraction") return SHIELD_ASSEMBLY_FRAMES;
    const cols = process.stdout.columns || 80;
    const animations =
      cols < MIN_WIDTH_FOR_ASSEMBLY
        ? [SHIELD_PULSE_FRAMES]
        : THINKING_ANIMATIONS;
    return animations[Math.floor(Math.random() * animations.length)];
  });

  useEffect(() => {
    const timer = setInterval(() => {
      setFrameIndex((i) => (i + 1) % animation.length);
    }, 600);
    return () => clearInterval(timer);
  }, [animation]);

  const frame = animation[frameIndex];
  const colored = colorizeThinking(frame);

  return (
    <Box flexDirection="column">
      {colored.split("\n").map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

// ── Streaming Response Component ───────────────────────────────────

function StreamingResponse({ text }: { text: string }) {
  const wrapped = wrapText(text, getWrapWidth());
  const lines = wrapped.split("\n");

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text color="#5B8DEF">▎ </Text>
          {i === 0 ? (
            <>
              <Text color="#5B8DEF">aegis</Text>
              <Text>{"  "}</Text>
            </>
          ) : (
            <Text>{"       "}</Text>
          )}
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Input Prompt Component ─────────────────────────────────────────

const INPUT_PREFIX_WIDTH = stringWidth("  ▎ you    ");
const CURSOR_CHAR = "█";

function InputPrompt({
  bridge,
}: {
  bridge: AppBridge;
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
  const availableWidth = cols - INPUT_PREFIX_WIDTH - stringWidth(CURSOR_CHAR);
  const textWidth = stringWidth(inputText);
  // If text exceeds available space, show only the tail end
  const visibleText =
    textWidth <= availableWidth
      ? inputText
      : inputText.slice(inputText.length - availableWidth);

  return (
    <Box paddingLeft={2}>
      <Text color="#A8D8A8">▎ </Text>
      <Text color="#A8D8A8">you  </Text>
      <Text>{"  "}</Text>
      <Box overflow="hidden" width={availableWidth + stringWidth(CURSOR_CHAR)}>
        <Text>{visibleText}</Text>
        <Text color="#5B8DEF">{CURSOR_CHAR}</Text>
      </Box>
    </Box>
  );
}

// ── Main App Component ─────────────────────────────────────────────

function AegisApp({ bridge }: { bridge: AppBridge }) {
  const [history, setHistory] = useState<ConversationItem[]>([]);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingMode, setThinkingMode] = useState<"thinking" | "extraction">("thinking");
  const [inputActive, setInputActive] = useState(false);

  // Expose state setters to the bridge
  useEffect(() => {
    bridge.addToHistory = (item) => setHistory((h) => [...h, item]);
    bridge.setStreamBuffer = setStreamBuffer;
    bridge.setIsStreaming = setIsStreaming;
    bridge.setIsThinking = setIsThinking;
    bridge.setThinkingMode = setThinkingMode;
    bridge.setInputPromptActive = setInputActive;
  }, []);

  return (
    <Box flexDirection="column">
      {/* Permanent conversation history */}
      <Static items={history}>
        {(item, index) => {
          switch (item.type) {
            case "aegis":
              return <AegisTurn key={index} message={item.message} />;
            case "user":
              return <UserTurn key={index} message={item.message} />;
            case "intro":
              return <BannerHeader key={index} version={item.version} mode={item.mode} />;
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
      {isStreaming && streamBuffer.length > 0 && (
        <StreamingResponse text={streamBuffer} />
      )}

      {/* Dynamic region — thinking animation */}
      {isThinking && <ThinkingDisplay mode={thinkingMode} />}

      {/* Dynamic region — input prompt */}
      {inputActive && <InputPrompt bridge={bridge} />}
    </Box>
  );
}

// ── TerminalUI Class — Bridge to Ink ───────────────────────────────

export class TerminalUI {
  private bridge: AppBridge;
  private inkInstance: ReturnType<typeof render> | null = null;
  private streamBuffer = "";
  private _thinkingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.bridge = {
      addToHistory: () => {},
      setStreamBuffer: () => {},
      setIsStreaming: () => {},
      setIsThinking: () => {},
      setThinkingMode: () => {},
      setInputPromptActive: () => {},
      resolveInput: null,
    };
  }

  private ensureRendered(): void {
    if (!this.inkInstance) {
      // exitOnCtrlC: true is critical for lock hygiene. Ink runs stdin
      // in raw mode, so a user's Ctrl+C arrives as a 0x03 byte rather
      // than raising process SIGINT. With exitOnCtrlC: false, our
      // useInput filter (!key.ctrl && ...) silently drops it and the
      // process stays alive with the lock held. Flipping it true
      // routes Ctrl+C through Ink's own shutdown, which unmounts
      // cleanly and calls process.exit(0). That fires the 'exit'
      // hook registered in lock.ts, so .agentpolicy/.aegis.lock is
      // released before the process goes away.
      this.inkInstance = render(
        React.createElement(AegisApp, { bridge: this.bridge }),
        { exitOnCtrlC: true }
      );
    }
  }

  // ── Intro Sequence ───────────────────────────────────────────────

  async playIntro(version: string): Promise<void> {
    this.ensureRendered();
    this.bridge.addToHistory({ type: "intro", mode: "full", version });
  }

  showWelcome(version: string): void {
    this.ensureRendered();
    this.bridge.addToHistory({ type: "intro", mode: "quiet", version });
  }

  // ── Conversation ─────────────────────────────────────────────────

  showAegisMessage(message: string): void {
    this.bridge.addToHistory({ type: "aegis", message });
  }

  startAegisResponse(): void {
    this.streamBuffer = "";
    this.bridge.setStreamBuffer("");
    this.bridge.setIsStreaming(true);
  }

  streamToken(token: string): void {
    this.streamBuffer += token;
    this.bridge.setStreamBuffer(this.streamBuffer);
  }

  endAegisResponse(): void {
    if (this.streamBuffer.length > 0) {
      this.bridge.addToHistory({ type: "aegis", message: this.streamBuffer });
    }
    this.bridge.setIsStreaming(false);
    this.bridge.setStreamBuffer("");
    this.streamBuffer = "";
  }

  async getUserInput(): Promise<string> {
    this.ensureRendered();
    return new Promise((resolve) => {
      this.bridge.resolveInput = (value: string) => {
        if (value.trim().length > 0) {
          this.bridge.addToHistory({ type: "user", message: value });
        }
        resolve(value);
      };
      this.bridge.setInputPromptActive(true);
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
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
