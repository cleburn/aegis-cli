/**
 * Discovery Engine
 *
 * The beating heart of `aegis init`. Just a conversation loop.
 *
 * When Aegis needs to think, the shield animation keeps the human
 * company — diamonds filling in, the .agentpolicy/ tree assembling.
 * When policy gets extracted, the same animations keep the human
 * company. The experience is: they talked to someone with real
 * presence, and then files appeared.
 */

import * as path from "node:path";
import type { LLMProvider, Message } from "../llm/provider.js";
import type { ScanResult } from "./scanner.js";
import {
  isSensitiveFile,
  readFileSafe,
  UNSUPPORTED_BINARY,
} from "./scanner.js";
import {
  buildDiscoverySystemPrompt,
  buildExtractionSystemPrompt,
  buildPostCompletionSystemPrompt,
} from "./system-prompt.js";
import { validatePolicyObject } from "../policy/validator.js";
import type { TerminalUI } from "../ui/terminal.js";

/** Maximum chained [READ_FILE: …] requests per single user turn. */
const MAX_READ_DEPTH = 5;

export interface DiscoveryResult {
  /** The full conversation transcript */
  transcript: Message[];
  /** The compiled policy JSON, ready to write to disk — null if no changes needed */
  policy: {
    constitution: Record<string, unknown>;
    governance: Record<string, unknown>;
    roles: Record<string, Record<string, unknown>>;
    ledger: Record<string, unknown>;
    /** What the user should do next — build from scratch (multi/single agent) or govern existing codebase */
    deployment_intent: "build_multi" | "build_single" | "govern";
    /** Custom handoff prompt crafted by the extraction LLM from the full conversation context */
    handoff_prompt: string;
  } | null;
}

export class DiscoveryEngine {
  private provider: LLMProvider;
  private scan: ScanResult;
  private ui: TerminalUI;
  private messages: Message[] = [];
  private systemPrompt: string;

  constructor(
    provider: LLMProvider,
    scan: ScanResult,
    ui: TerminalUI
  ) {
    this.provider = provider;
    this.scan = scan;
    this.ui = ui;
    this.systemPrompt = buildDiscoverySystemPrompt(scan);
  }

  /**
   * Run the full discovery conversation.
   * Returns the compiled policy when complete, or null policy if no changes needed.
   */
  async run(): Promise<DiscoveryResult> {
    // Seed the conversation — the user ran "aegis init", that's the trigger
    this.messages.push({ role: "user", content: "aegis init" });
    const opening = await this.getAegisResponse();

    // Conversation loop
    while (true) {
      const userInput = await this.ui.getUserInput();

      // Handle exits gracefully
      if (
        userInput.toLowerCase() === "/quit" ||
        userInput.toLowerCase() === "/exit"
      ) {
        this.ui.showNote(
          "No worries — nothing saved yet, but you can pick this up anytime with aegis init."
        );
        process.exit(0);
      }

      if (userInput.trim() === "") {
        continue;
      }

      // Add user message
      this.messages.push({ role: "user", content: userInput });

      // Get Aegis's response (streamed to terminal)
      const response = await this.getAegisResponse();

      // Check for completion signals
      if (response.includes("[NO_CHANGES]")) {
        // Conversation concluded with no policy modifications needed.
        // Skip extraction entirely — the existing files are correct.
        this.ui.showNote("Policy unchanged. Everything's current.");

        return {
          transcript: [...this.messages],
          policy: null,
        };
      }

      if (response.includes("[DISCOVERY_COMPLETE]")) {
        // Defensive check: if the marker arrives in a message that also
        // contains a question mark near the end, the model is asking for
        // confirmation, not signalling completion. Swallow the marker and
        // wait for the user to respond. The prompt should prevent this,
        // but the check guards against drift.
        if (containsTrailingQuestion(response)) {
          process.stderr.write(
            "[aegis] ignored premature [DISCOVERY_COMPLETE] — message contained a trailing question\n"
          );
          continue;
        }

        // Policy changes needed — extract and compile
        this.ui.showNote("Drafting your policy files...");

        const policy = await this.extractPolicy();

        return {
          transcript: [...this.messages],
          policy,
        };
      }

    }
  }

  /**
   * Get a streamed response from Aegis.
   *
   * Thinking animation starts on a 2-second timer. If the first token
   * arrives before 2 seconds (the common case), no animation appears.
   * If it takes longer, the animation fills the pause naturally.
   *
   * The stream is buffered to intercept markers so they never appear
   * in the terminal. Three markers are recognized: [DISCOVERY_COMPLETE],
   * [NO_CHANGES], and [READ_FILE: <path>]. The first two are fixed
   * strings; the read marker is variable-length so the buffer holds
   * anything starting with '[' until the matching ']' arrives.
   *
   * If the response contains a [READ_FILE: …] marker, the engine reads
   * the requested file safely, appends a synthetic user message with
   * the contents, and recurses to let Aegis continue. Recursion is
   * bounded by MAX_READ_DEPTH.
   */
  private async getAegisResponse(depth: number = 0): Promise<string> {
    // Start thinking timer — animation appears only if >2s passes
    this.ui.startThinking();

    let firstToken = true;
    let buffer = "";

    // Extract any fully-formed [...] spans at the start of the buffer.
    // Known markers get swallowed silently; unknown bracket spans are
    // flushed as plain text.
    const drainBuffer = () => {
      while (buffer.length > 0) {
        const openIdx = buffer.indexOf("[");
        if (openIdx === -1) {
          // No bracket — flush everything
          this.ui.streamToken(buffer);
          buffer = "";
          return;
        }
        if (openIdx > 0) {
          // Flush plain text before the first '['
          this.ui.streamToken(buffer.slice(0, openIdx));
          buffer = buffer.slice(openIdx);
        }
        // buffer[0] === '['. Look for the closing ']'.
        const closeIdx = buffer.indexOf("]");
        if (closeIdx === -1) {
          // Marker might still be forming — wait for more tokens
          return;
        }
        const span = buffer.slice(0, closeIdx + 1);
        const rest = buffer.slice(closeIdx + 1);
        if (
          span === "[DISCOVERY_COMPLETE]" ||
          span === "[NO_CHANGES]" ||
          /^\[READ_FILE:\s*.+\]$/.test(span)
        ) {
          // Swallow silently — the full response string still has these,
          // so downstream marker checks (completion, read) work.
          buffer = rest;
          continue;
        }
        // Unknown bracket span — treat as plain text
        this.ui.streamToken(span);
        buffer = rest;
      }
    };

    const response = await this.provider.chatStream(
      this.messages,
      this.systemPrompt,
      (token) => {
        if (firstToken) {
          this.ui.stopThinking();
          this.ui.startAegisResponse();
          firstToken = false;
        }
        buffer += token;
        drainBuffer();
      }
    );

    // Flush anything left in the buffer (stripping markers if present)
    if (buffer.length > 0) {
      const cleaned = buffer
        .replace(/\[DISCOVERY_COMPLETE\]/g, "")
        .replace(/\[NO_CHANGES\]/g, "")
        .replace(/\[READ_FILE:\s*[^\]]+\]/g, "");
      if (cleaned.length > 0) {
        this.ui.streamToken(cleaned);
      }
      buffer = "";
    }

    // Empty response edge case
    if (firstToken) {
      this.ui.stopThinking();
      this.ui.startAegisResponse();
    }

    this.ui.endAegisResponse();

    // Check for a read request in the full response text
    const readMatch = response.match(/\[READ_FILE:\s*([^\]]+)\]/);
    if (readMatch) {
      const requestedPath = readMatch[1].trim();

      // Strip the marker from the assistant message stored in history —
      // the marker is control signal, not conversational content.
      const cleanedResponse = response
        .replace(/\[READ_FILE:\s*[^\]]+\]/g, "")
        .trimEnd();
      this.messages.push({ role: "assistant", content: cleanedResponse });

      // Guard against runaway chains
      if (depth >= MAX_READ_DEPTH) {
        this.messages.push({
          role: "user",
          content: `[system] Read limit reached for this turn (${MAX_READ_DEPTH} reads). Please respond to the human without another file read.`,
        });
        return this.getAegisResponse(depth + 1);
      }

      // Show the user what's happening, then read the file
      this.ui.showNote(`Reading ${requestedPath}...`);
      const readResult = await this.readFileForAegis(requestedPath);

      this.messages.push({ role: "user", content: readResult });
      return this.getAegisResponse(depth + 1);
    }

    this.messages.push({ role: "assistant", content: response });
    return response;
  }

  /**
   * Fetch a file on Aegis's behalf during discovery.
   *
   * Returns a framed string the model can consume — either the file
   * contents wrapped in a system-note block, or an error note
   * explaining why the read was rejected. The string is injected as
   * a user message so the conversation continues coherently.
   *
   * Safety rules (mirrors scanner.ts):
   * - Reject paths containing ".." segments.
   * - Reject paths that resolve outside the project root.
   * - Reject paths matching SENSITIVE_FILE_PATTERNS.
   * - Delegate actual reading to readFileSafe (size caps, DOCX/PDF parsing).
   */
  private async readFileForAegis(requestedPath: string): Promise<string> {
    const framed = (note: string, body?: string) =>
      body
        ? `[system: file read] ${note}\n\n${body}`
        : `[system: file read] ${note}`;

    const trimmed = requestedPath.trim().replace(/^["']|["']$/g, "");
    if (!trimmed) {
      return framed("Read failed: empty path.");
    }

    // Reject any traversal attempt before resolution
    if (trimmed.includes("..")) {
      return framed(
        `Read rejected: path "${trimmed}" contains ".." — reads are confined to the project root.`
      );
    }

    // Reject absolute paths that point outside the project
    const root = this.scan.root;
    const normalizedRel = trimmed.startsWith("/")
      ? path.relative(root, trimmed)
      : trimmed;

    if (normalizedRel.startsWith("..") || path.isAbsolute(normalizedRel)) {
      return framed(
        `Read rejected: path "${trimmed}" resolves outside the project root.`
      );
    }

    const absolutePath = path.resolve(root, normalizedRel);
    const resolvedRelative = path.relative(root, absolutePath);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
      return framed(
        `Read rejected: path "${trimmed}" resolves outside the project root.`
      );
    }

    if (isSensitiveFile(resolvedRelative)) {
      return framed(
        `Read refused: "${resolvedRelative}" matches a sensitive file pattern (env file, credentials, secrets, etc.). Ask the human to share the specific content they want reviewed.`
      );
    }

    const result = await readFileSafe(absolutePath);
    if (result === null) {
      return framed(
        `Read failed: "${resolvedRelative}" could not be read — it may not exist, may be too large (>1MB), or may be unreadable.`
      );
    }
    if (result === UNSUPPORTED_BINARY) {
      return framed(
        `Read refused: "${resolvedRelative}" is a binary file in a format without a parser (supported: .docx, .pdf).`
      );
    }

    const truncatedNote = result.truncated
      ? " [Content was truncated at 10KB.]"
      : "";
    return framed(
      `Contents of ${resolvedRelative}:${truncatedNote}`,
      result.content
    );
  }

  /**
   * Send a message in post-completion mode and stream Aegis's response.
   *
   * Post-completion mode runs after extraction — the files are written,
   * the handoff has been shown, and the session stays open so the user
   * can ask follow-up questions. No markers, no extraction targets, no
   * policy edits: just continued conversation that gets captured in the
   * same transcript.
   */
  async continueConversation(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });

    this.ui.startThinking();

    let firstToken = true;
    const response = await this.provider.chatStream(
      this.messages,
      buildPostCompletionSystemPrompt(),
      (token) => {
        if (firstToken) {
          this.ui.stopThinking();
          this.ui.startAegisResponse();
          firstToken = false;
        }
        this.ui.streamToken(token);
      }
    );

    if (firstToken) {
      this.ui.stopThinking();
      this.ui.startAegisResponse();
    }

    this.ui.endAegisResponse();

    this.messages.push({ role: "assistant", content: response });
    return response;
  }

  /**
   * Return a copy of the current message transcript. Used by the init
   * command to write the session transcript after the post-completion
   * loop ends, so the transcript captures the entire session.
   */
  getTranscript(): Message[] {
    return [...this.messages];
  }

  /**
   * After discovery, compile the conversation into structured policy.
   * Thinking animation runs during extraction since this is always
   * a long operation — no 2-second threshold needed.
   *
   * On return visits, the existing policy contents are passed to the
   * extraction prompt as a baseline — the LLM applies the conversation's
   * changes on top of what already exists.
   *
   * Retries once on failure — large JSON outputs occasionally hit
   * token limits or produce syntax errors on the first attempt.
   */
  private async extractPolicy(): Promise<DiscoveryResult["policy"]> {
    const MAX_ATTEMPTS = 2;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Start or restart the extraction animation
      this.ui.startThinking("extraction");

      // Build the existing policy baseline for return visits
      const existingBaseline = this.buildExistingPolicyBaseline();
      const extractionPrompt = buildExtractionSystemPrompt(existingBaseline);

      const transcriptSummary = this.messages
        .map((m) => `${m.role === "user" ? "Human" : "Aegis"}: ${m.content}`)
        .join("\n\n");

      const extractionMessages: Message[] = [
        {
          role: "user",
          content: `Here is the complete discovery conversation transcript. Compile it into the .agentpolicy/ JSON files.\n\n${transcriptSummary}`,
        },
      ];

      try {
        const policy = await this.provider.chatJSON<NonNullable<DiscoveryResult["policy"]>>(
          extractionMessages,
          extractionPrompt
        );

        this.ui.stopThinking();

        // Validate the extraction produced the expected shape
        if (!policy || !policy.constitution || !policy.governance || !policy.roles || !policy.ledger) {
          if (attempt < MAX_ATTEMPTS) {
            this.ui.stopThinking();
            this.ui.showNote("Extraction came back incomplete — retrying...");
            continue;
          }
          this.ui.showError(
            "Extraction produced an incomplete result. Run aegis init again — sometimes the model needs a second pass."
          );
          return null;
        }

        // Schema-validate the extracted policy before returning. A
        // pass here means writePolicy will accept it; a fail means
        // we retry the extraction call rather than letting malformed
        // policy reach disk.
        const validationResults = validatePolicyObject({
          constitution: policy.constitution,
          governance: policy.governance,
          roles: policy.roles,
          ledger: policy.ledger,
        });
        const validationFailures = validationResults.filter((r) => !r.valid);
        if (validationFailures.length > 0) {
          if (attempt < MAX_ATTEMPTS) {
            this.ui.showNote("Extraction produced invalid policy — retrying...");
            continue;
          }
          const summary = validationFailures
            .slice(0, 3)
            .map((f) => `${f.file}: ${f.errors[0] ?? "invalid"}`)
            .join("; ");
          this.ui.showError(
            `Extracted policy failed schema validation (${summary}). Run aegis init again.`
          );
          return null;
        }

        // Default deployment_intent if extraction didn't produce one.
        // Return visits default to "govern" — the project already has
        // a policy directory, so a missing intent on a return visit
        // should never produce a build-from-scratch handoff. Only
        // first-time runs infer build_single or build_multi from the
        // shape of the roles set.
        if (!policy.deployment_intent) {
          if (this.scan.hasExistingPolicy) {
            policy.deployment_intent = "govern";
          } else {
            const roleNames = Object.keys(policy.roles).filter(r => r !== "default");
            policy.deployment_intent = roleNames.length > 0 ? "build_multi" : "build_single";
          }
        }

        // Default handoff_prompt if extraction didn't produce one
        if (!policy.handoff_prompt) {
          policy.handoff_prompt = "Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not take any action until you have called this tool and received confirmation from the user to proceed.";
        }

        return policy;
      } catch (error) {
        this.ui.stopThinking();

        if (attempt < MAX_ATTEMPTS) {
          this.ui.showNote("Extraction hit a snag — retrying...");
          continue;
        }

        this.ui.showError(
          `Policy extraction failed: ${error instanceof Error ? error.message : "Unknown error"}. Run aegis init again.`
        );
        return null;
      }
    }

    return null;
  }

  /**
   * Format existing policy file contents as a baseline string
   * for the extraction prompt. Returns undefined if no existing
   * policy exists (first-time init).
   */
  private buildExistingPolicyBaseline(): string | undefined {
    if (!this.scan.hasExistingPolicy || this.scan.existingPolicyContents.length === 0) {
      return undefined;
    }

    const sections: string[] = [];
    for (const file of this.scan.existingPolicyContents) {
      sections.push(`--- ${file.path} ---`);
      sections.push(file.content);
      sections.push("");
    }

    return sections.join("\n");
  }
}

/**
 * Detect whether a response ends in a question — used to guard against
 * the model emitting a completion marker in the same message where it's
 * still asking for the user's confirmation.
 *
 * Strips completion markers first (they can arrive after the question),
 * then checks the final 200 characters for a "?".
 */
function containsTrailingQuestion(response: string): boolean {
  const stripped = response
    .replace(/\[DISCOVERY_COMPLETE\]/g, "")
    .replace(/\[NO_CHANGES\]/g, "")
    .trimEnd();
  const tail = stripped.slice(-200);
  return tail.includes("?");
}
