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
import { MaxTokensError } from "../llm/provider.js";
import type { ScanResult } from "./scanner.js";
import {
  isSensitiveFile,
  readFileSafe,
  UNSUPPORTED_BINARY,
  MAX_FILE_SIZE_ABSOLUTE,
} from "./scanner.js";
import {
  buildDiscoverySystemPrompt,
  buildExtractionSystemPrompt,
  buildPostCompletionSystemPrompt,
  type PostCompletionMode,
} from "./system-prompt.js";
import { validatePolicyObject } from "../policy/validator.js";
import { policyReadRegexAlternatives } from "../policy/manifest.js";
import { repoHasRealSource } from "./scanner.js";
import { AegisExit } from "../abort.js";
import type { TerminalUI } from "../ui/terminal.js";
import { runModelSwitchFlow } from "../llm/install.js";
import { createProviderFromActive } from "../llm/factory.js";
import { modelLabelForProvider } from "../llm/models.js";
import {
  DISCOVERY_COMMANDS,
  formatSlashCommandMatch,
  resolveSlashCommand,
} from "../ui/commands.js";

/** Maximum chained [READ_FILE: …] requests per single user turn. */
const MAX_READ_DEPTH = 5;

/**
 * Forensic record of how extraction failed, captured into the saved
 * session transcript so a subsequent debugging pass (Aegis on a
 * future return visit, or a human reading the audit trail) can see
 * the specific failure mode without re-running the failed call.
 *
 * Categories mirror the failure branches in extractPolicy():
 * - "parse": JSON.parse threw a SyntaxError on the model's output.
 * - "transport": chatJSON threw a non-SyntaxError, non-MaxTokensError
 *   (network, auth, rate limit, timeout, anything provider-side).
 *   The model's output never reached the parser.
 * - "max_tokens": the provider stopped emitting tokens because the
 *   max_tokens budget was exhausted before the JSON output completed.
 *   Distinct from "parse" — the model didn't emit bad output, it ran
 *   out of room. Captured separately so forensic passes can tell
 *   "model truncated" from "model output malformed."
 * - "structural": the parsed object was missing one or more of the
 *   required top-level keys (constitution, governance, roles,
 *   ledger).
 * - "schema": the parsed object passed structural completeness but
 *   failed ajv validation against one or more of the policy schemas.
 *
 * `detail` carries category-specific forensic information — the
 * parse error message, the missing-keys list, or the schema
 * validation summary. Bounded to a manageable size at population
 * time so the transcript record stays compact even when the model
 * emits a runaway error.
 */
export interface ExtractionFailure {
  category:
    | "parse"
    | "transport"
    | "max_tokens"
    | "structural"
    | "schema";
  detail: string;
}

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
    /**
     * Explicit list of role names the user asked to delete during a
     * return-visit conversation. Retires the prior delete-by-
     * omission semantics: the writer no longer infers deletion from
     * a role missing from `roles`. To delete a role, the extraction
     * LLM lists its name here. Roles that appear in neither `roles`
     * nor `deleted_role_names` are preserved on disk as a safety
     * measure (silent extraction drift can no longer cause data
     * loss). Optional and typically absent — only populated on
     * return visits where deletions were discussed.
     */
    deleted_role_names?: string[];
  } | null;
  /**
   * How the discovery conversation concluded.
   * - "completed": user affirmed changes, extraction ran successfully, policy is set.
   * - "no_changes": user explicitly confirmed nothing needs to change.
   * - "extraction_failed": user affirmed changes, but extraction returned null
   *   after retries. The init command must NOT enter post-completion mode in
   *   this state — doing so would tell the user "your policy was written"
   *   when it wasn't.
   */
  status: "completed" | "no_changes" | "extraction_failed";
  /**
   * Populated only when status is "extraction_failed". Carries the
   * specific failure mode and detail that ended the session, so the
   * init command can preserve them in the saved transcript for
   * forensic review.
   */
  extractionFailure?: ExtractionFailure;
}

export class DiscoveryEngine {
  private provider: LLMProvider;
  private scan: ScanResult;
  private ui: TerminalUI;
  private messages: Message[] = [];
  private systemPrompt: string;
  /**
   * Engine-tracked consent for the one side effect Aegis can apply
   * automatically: appending the sensitive Aegis paths to .gitignore
   * during the policy-write phase. See gitignoreTopicOpen for the
   * substate machine that scopes consent/revoke markers to a
   * specific exchange rather than any matching user-turn signal.
   */
  private gitignoreConsent = false;

  /**
   * True while an Aegis ask about the session-log privacy choice is
   * open and waiting for the human's answer. Set by the
   * [GITIGNORE_ASK] marker, cleared after a [GITIGNORE_CONSENT] or
   * [GITIGNORE_REVOKE] has been processed. Consent/revoke markers
   * are honored ONLY in this substate — that stops a drifted
   * [GITIGNORE_CONSENT] following an unrelated "yes" (about some
   * other question) from silently latching consent, and stops a
   * drifted [GITIGNORE_REVOKE] after an unrelated "don't do that"
   * from silently clearing it. To retract later in the session,
   * Aegis must re-emit [GITIGNORE_ASK] alongside the revoke.
   */
  private gitignoreTopicOpen = false;

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

      // Handle exits gracefully via the typed-exit path so the outer
      // init command's cleanup runs (lock release, UI destroy, and
      // transcript persistence — see initCommand's writeFinalTranscript).
      // A bare process.exit here would bypass all of that.
      if (
        await handleDiscoverySlashCommand(
          userInput,
          this.ui,
          () => this.switchModel()
        )
      ) {
        continue;
      }

      if (userInput.trim() === "") {
        continue;
      }

      // Add user message
      this.messages.push({ role: "user", content: userInput });

      // Get Aegis's response (streamed to terminal)
      const response = await this.getAegisResponse();

      // Completion markers can only fire after the user has explicitly
      // confirmed — but the form of confirmation differs per marker.
      // [DISCOVERY_COMPLETE] requires an affirmation of proposed
      // changes ("yes", "proceed", "looks good"). [NO_CHANGES]
      // requires an explicit statement that nothing needs to change
      // ("no changes", "nothing needs to change", "everything looks
      // good") — which overlaps partially with affirmatives but also
      // includes forms ("just checking in, no changes") that the
      // generic affirmative matcher correctly rejects for the
      // DISCOVERY_COMPLETE path. Each marker gets its own gate.
      //
      // containsTrailingQuestion(response) applies to both markers:
      // Aegis's own message cannot end in a question if the marker
      // is valid, regardless of which marker.
      //
      // When a gate fails, the marker is dropped from the control
      // flow (still swallowed from the user-visible stream above)
      // and the conversation continues so the user can confirm.

      // Gitignore-consent substate machine.
      //
      // The topic must have been opened in a PRIOR assistant response
      // — not the current one — before CONSENT can latch. This closes
      // the loophole where an "[GITIGNORE_ASK][GITIGNORE_CONSENT]"
      // pair in the same response would otherwise self-authorize on
      // an unrelated user affirmation. The snapshot at the top of the
      // turn captures state that was set by the PREVIOUS iteration's
      // ASK, so an ASK and CONSENT emitted in the same response see
      // topicWasOpenAtTurnStart === false.
      //
      // The topic closes unconditionally at the end of the first
      // response after an ASK, regardless of which marker was (or
      // wasn't) emitted. Options 2 and 3 of the system prompt — "put
      // it in the handoff" and "user handles it themselves" — emit no
      // marker, and the topic must still close or it would stay
      // stuck open and a stray consent much later in the session
      // could wrongly re-latch.
      //
      // REVOKE is asymmetric: it's valid when either the topic was
      // open (same rule as CONSENT) OR when consent is already true
      // and the user turn signals retraction. The second branch lets
      // a user unilaterally retract mid-session without requiring a
      // two-round-trip re-confirm, because the harm of a drifted
      // revoke is recoverable (user re-consents) while the harm of a
      // drifted consent is a silent write to their repo.
      const topicWasOpenAtTurnStart = this.gitignoreTopicOpen;

      if (response.includes("[GITIGNORE_CONSENT]")) {
        if (
          topicWasOpenAtTurnStart &&
          isSimpleAffirmative(userInput) &&
          !containsTrailingQuestion(response)
        ) {
          this.gitignoreConsent = true;
        } else {
          const reason = !topicWasOpenAtTurnStart
            ? "no open gitignore exchange — [GITIGNORE_ASK] must come from a prior Aegis response"
            : "affirmation missing or marker emitted in a question";
          process.stderr.write(
            `[aegis] ignored [GITIGNORE_CONSENT] — ${reason}\n`
          );
        }
      }

      if (response.includes("[GITIGNORE_REVOKE]")) {
        const scopedToExchange =
          topicWasOpenAtTurnStart || this.gitignoreConsent;
        if (scopedToExchange && isRetractionSignal(userInput)) {
          this.gitignoreConsent = false;
        } else {
          const reason = !scopedToExchange
            ? "no open gitignore exchange and no existing consent to revoke"
            : "no retraction signal in user turn";
          process.stderr.write(
            `[aegis] ignored [GITIGNORE_REVOKE] — ${reason}\n`
          );
        }
      }

      // After any post-ASK turn, close the topic — this covers both
      // the happy path (CONSENT/REVOKE processed above) and the
      // silent paths (options 2 and 3, where no marker is emitted at
      // all). A later CONSENT without a fresh ASK is correctly denied.
      if (topicWasOpenAtTurnStart) {
        this.gitignoreTopicOpen = false;
      }

      // Finally, process ASK last so its state change applies to the
      // NEXT iteration, not the current one. An ASK-and-CONSENT pair
      // in the same response leaves the topic open for the next turn
      // (in case the human's answer is still coming) but does not
      // let the pair self-authorize within one response.
      if (response.includes("[GITIGNORE_ASK]")) {
        this.gitignoreTopicOpen = true;
      }

      if (response.includes("[NO_CHANGES]")) {
        if (!isNoChangeConfirmation(userInput) || containsTrailingQuestion(response)) {
          process.stderr.write(
            "[aegis] ignored premature [NO_CHANGES] — no explicit no-change confirmation on record\n"
          );
          continue;
        }
        // Conversation concluded with no policy modifications needed.
        // Skip extraction entirely — the existing files are correct.
        this.ui.showNote("Policy unchanged. Everything's current.");

        return {
          transcript: [...this.messages],
          policy: null,
          status: "no_changes",
        };
      }

      if (response.includes("[DISCOVERY_COMPLETE]")) {
        if (!isSimpleAffirmative(userInput) || containsTrailingQuestion(response)) {
          process.stderr.write(
            "[aegis] ignored premature [DISCOVERY_COMPLETE] — no unambiguous user affirmation on record\n"
          );
          continue;
        }

        // Policy changes needed — extract and compile
        this.ui.showNote("Drafting your policy files...");

        const { policy, failure } = await this.extractPolicy();

        return {
          transcript: [...this.messages],
          policy,
          status: policy ? "completed" : "extraction_failed",
          extractionFailure: failure,
        };
      }

    }
  }

  private async switchModel(): Promise<void> {
    const result = await runModelSwitchFlow(this.ui);
    if (!result.switched) {
      this.ui.showNote("Model unchanged.");
      return;
    }

    this.provider = createProviderFromActive(result.active);
    const modelLabel = modelLabelForProvider(
      result.active.provider,
      result.active.model
    );
    const announcement =
      `Switched to ${modelLabel}. Soft reset: the conversation history is preserved, and this model will read the earlier turns on the next response even though it did not author them.`;
    this.ui.showAegisMessage(announcement);
    this.messages.push({ role: "system", content: announcement });
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
          span === "[GITIGNORE_ASK]" ||
          span === "[GITIGNORE_CONSENT]" ||
          span === "[GITIGNORE_REVOKE]" ||
          /^\[READ_FILE:\s*.+\]$/.test(span)
        ) {
          // Swallow silently — the full response string still has these,
          // so downstream marker checks (completion, read, consent) work.
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
        .replace(/\[GITIGNORE_ASK\]/g, "")
        .replace(/\[GITIGNORE_CONSENT\]/g, "")
        .replace(/\[GITIGNORE_REVOKE\]/g, "")
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
          role: "system",
          content: `Read limit reached for this turn (${MAX_READ_DEPTH} reads). Please respond to the human without another file read.`,
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

    // User-initiated reads opt out of the scan-time 10KB soft cap.
    // The scan cap exists to ration context across many files read
    // at once; here the human explicitly asked for ONE file and
    // expects its full contents. Using MAX_FILE_SIZE_ABSOLUTE means
    // files up to 1MB come through whole — only files over the
    // 1MB hard ceiling are refused outright.
    const result = await readFileSafe(absolutePath, {
      maxSize: MAX_FILE_SIZE_ABSOLUTE,
    });
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
      ? " [Content was truncated at 1MB — file exceeded the read ceiling.]"
      : "";
    // Normalize the display path to forward slashes for cross-
    // platform regex matching downstream. path.relative returns
    // OS-native separators (backslashes on Windows), which would
    // silently defeat any consumer that builds a regex assuming
    // POSIX paths — e.g. POLICY_READ_RE in extractPolicy. Path
    // operations elsewhere (isSensitiveFile, path.resolve, etc.)
    // continue to use the OS-native resolvedRelative; only the
    // emitted display string is canonicalized.
    const displayPath = resolvedRelative.split(path.sep).join("/");
    return framed(
      `Contents of ${displayPath}:${truncatedNote}`,
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
  async continueConversation(
    userInput: string,
    mode: PostCompletionMode = "completed"
  ): Promise<string> {
    this.messages.push({ role: "user", content: userInput });

    this.ui.startThinking();

    let firstToken = true;
    const response = await this.provider.chatStream(
      this.messages,
      buildPostCompletionSystemPrompt(mode),
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
   * True iff the human explicitly authorized Aegis to update .gitignore
   * during this session via an affirmed [GITIGNORE_CONSENT] marker.
   * The init command reads this to decide whether to append the
   * sanctioned Aegis paths to .gitignore after writePolicy. The
   * extraction output has no authority here — consent lives in the
   * engine's state, verified against the user's conversation turns.
   */
  getGitignoreConsent(): boolean {
    return this.gitignoreConsent;
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
  private async extractPolicy(): Promise<{
    policy: DiscoveryResult["policy"];
    failure?: ExtractionFailure;
  }> {
    const MAX_ATTEMPTS = 2;

    // Match user-role messages that carry a synthetic [system: file
    // read] payload for a file ALSO present in the EXISTING POLICY
    // BASELINE. Aegis emits [READ_FILE: .agentpolicy/...] markers
    // mid-discovery; the engine intercepts each one and pushes the
    // file's contents back as a user-role message via
    // readFileForAegis (see the framing in engine.ts:431). For files
    // in the baseline allowlist (constitution, governance,
    // state/ledger, roles/<name>), those bodies are duplicated by
    // the EXISTING POLICY BASELINE section of the extraction prompt
    // — concatenating both into the extraction input wastes prompt
    // budget and gives the LLM two sources of truth for the same
    // content. The regex MUST mirror the scanner's policy floor
    // exactly: broader matching would silently drop context the
    // user explicitly asked Aegis to read (e.g. a session transcript,
    // overrides.jsonl, future state files); narrower matching would
    // leak duplicated content back into extraction. File reads
    // OUTSIDE the baseline (charter docs, external research,
    // anything the user pointed Aegis at for context) are NOT
    // elided — those carry genuine context that belongs in
    // extraction input.
    //
    // Built from the centralized manifest's regex-alternatives
    // helper so a future spec change to the floor (renamed file,
    // added file, moved path) updates exactly one place
    // (manifest.ts) and this regex follows automatically.
    const POLICY_READ_RE = new RegExp(
      `^\\[system: file read\\] Contents of \\.agentpolicy/(${policyReadRegexAlternatives()})\\.json:`
    );

    // Carry forward a description of the previous attempt's failure
    // so the retry can address the specific defect rather than
    // replaying the same monolithic call blind. Set at each failure
    // branch (parse / structural / schema) before `continue`.
    let lastFailure: string | undefined;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Start or restart the extraction animation
      this.ui.startThinking("extraction");

      // Build the existing policy baseline for return visits
      const existingBaseline = this.buildExistingPolicyBaseline();
      const extractionPrompt = buildExtractionSystemPrompt(existingBaseline);

      const transcriptSummary = this.messages
        .map((m) => {
          if (m.role === "user" && POLICY_READ_RE.test(m.content)) {
            // The "Human:" prefix here matches the user-role branch
            // below — synthetic file-read payloads are injected as
            // user-role messages by readFileForAegis. If that
            // framing ever shifts (different role for system-injected
            // messages, separate provider channel, etc.), this
            // prefix needs to shift with it.
            const header = m.content.split("\n", 1)[0];
            return `Human: ${header}\n\n[body elided — see EXISTING POLICY BASELINE]`;
          }
          return `${transcriptRoleLabel(m.role)}: ${m.content}`;
        })
        .join("\n\n");

      const extractionMessages: Message[] = [];
      // On retry, prepend a remediation hint naming the specific
      // failure so the LLM addresses it rather than reproducing the
      // same defect. Without this, retry 2 is identical to retry 1
      // with no signal — the second attempt has no idea why the first
      // failed and burns the budget on the same bug.
      if (lastFailure) {
        extractionMessages.push({
          role: "system",
          content: `The previous extraction attempt failed: ${lastFailure}. Re-emit the JSON with this corrected. All other rules from the system prompt still apply — preserve baseline content verbatim, apply only the conversation-named edits, output a single valid JSON object.`,
        });
      }
      extractionMessages.push({
        role: "user",
        content: `Here is the complete discovery conversation transcript. Compile it into the .agentpolicy/ JSON files.\n\n${transcriptSummary}`,
      });

      try {
        const policy = await this.provider.chatJSON<NonNullable<DiscoveryResult["policy"]>>(
          extractionMessages,
          extractionPrompt
        );

        this.ui.stopThinking();

        // Validate the extraction produced the expected shape
        if (!policy || !policy.constitution || !policy.governance || !policy.roles || !policy.ledger) {
          // Enumerate which top-level keys were missing so the
          // forensic record names them specifically. Useful for
          // diagnosing whether the LLM consistently drops the same
          // key (e.g. "ledger") versus producing scattered failures.
          const missingKeys: string[] = [];
          if (!policy?.constitution) missingKeys.push("constitution");
          if (!policy?.governance) missingKeys.push("governance");
          if (!policy?.roles) missingKeys.push("roles");
          if (!policy?.ledger) missingKeys.push("ledger");
          const missingDetail =
            missingKeys.length > 0
              ? `missing keys: ${missingKeys.join(", ")}`
              : "extraction returned null or non-object";
          if (attempt < MAX_ATTEMPTS) {
            this.ui.stopThinking();
            this.ui.showNote("Extraction came back incomplete — retrying...");
            lastFailure =
              "the JSON was missing one or more of the required top-level keys (constitution, governance, roles, ledger). Emit ALL four keys this time.";
            continue;
          }
          this.ui.showError(
            "Extraction produced an incomplete result. Run aegis init again — sometimes the model needs a second pass."
          );
          return {
            policy: null,
            failure: { category: "structural", detail: missingDetail },
          };
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
          const summary = validationFailures
            .slice(0, 3)
            .map((f) => `${f.file}: ${f.errors[0] ?? "invalid"}`)
            .join("; ");
          // Forensic detail captures every failing file, not just the
          // first 3 the LLM-facing summary names. The retry-hint and
          // user-visible error stay terse; the transcript record
          // carries the full picture so a later debugger sees every
          // schema violation that contributed to the abort.
          const fullDetail = validationFailures
            .map((f) => `${f.file}: ${f.errors[0] ?? "invalid"}`)
            .join("; ");
          if (attempt < MAX_ATTEMPTS) {
            this.ui.showNote("Extraction produced invalid policy — retrying...");
            lastFailure = `the emitted JSON failed schema validation (${summary}). Fix these specific fields and re-emit.`;
            continue;
          }
          this.ui.showError(
            `Extracted policy failed schema validation (${summary}). Run aegis init again.`
          );
          return {
            policy: null,
            failure: { category: "schema", detail: fullDetail },
          };
        }

        // Default deployment_intent if extraction didn't produce one.
        //
        // Maturity check via repoHasRealSource — true iff the
        // project either has a recognized stack signal OR contains
        // source files in known languages (config-light source-only
        // repos count). When real source exists, default to "govern"
        // regardless of whether an .agentpolicy/ already exists:
        // adding governance to an existing codebase is a govern
        // operation whether or not the project has been governed
        // before, and a build handoff would tell the next agent to
        // build something that already exists.
        //
        // Skeletal repos (no real source) split on role count, not
        // on whether "default" is among them:
        //   - 1 role  → build_single (single agent, including a
        //     single specialist whose name isn't "default")
        //   - 2+ roles → build_multi
        // The previous filter `r => r !== "default"` mis-classified
        // a single specialist-named role as build_multi because
        // filtering out only "default" left length === 1. Counting
        // roles directly gives the right answer in every case
        // (validator already enforces ≥1 role).
        if (!policy.deployment_intent) {
          if (repoHasRealSource(this.scan)) {
            policy.deployment_intent = "govern";
          } else {
            const roleCount = Object.keys(policy.roles).length;
            policy.deployment_intent =
              roleCount > 1 ? "build_multi" : "build_single";
          }
        }

        // Default handoff_prompt if extraction didn't produce one
        if (!policy.handoff_prompt) {
          policy.handoff_prompt = "Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not take any action until you have called this tool and received confirmation from the user to proceed.";
        }

        return { policy };
      } catch (error) {
        this.ui.stopThinking();

        const detail =
          error instanceof Error
            ? error.message.slice(0, 200)
            : "unknown error";

        // Three failure shapes the catch can see, each with a
        // distinct retry hint and forensic category:
        //
        //   - MaxTokensError: provider stopped emitting because
        //     max_tokens was hit before completing the JSON. The
        //     model didn't emit anything wrong — it ran out of
        //     room. Retry with a hint explicitly naming truncation
        //     so the next attempt knows to budget output more
        //     carefully (e.g. by tightening preserved-verbatim
        //     content where the conversation allows).
        //   - SyntaxError: JSON.parse failed on the model's output.
        //     The model emitted invalid JSON — surface that
        //     concretely instead of conflating with transport.
        //   - Anything else: provider-side error (network, auth,
        //     rate limit, timeout). Not the model's fault; the
        //     retry hint should not accuse it of bad output.
        const isMaxTokensFailure = error instanceof MaxTokensError;
        const isParseFailure =
          !isMaxTokensFailure && error instanceof SyntaxError;
        const category: ExtractionFailure["category"] = isMaxTokensFailure
          ? "max_tokens"
          : isParseFailure
            ? "parse"
            : "transport";

        if (attempt < MAX_ATTEMPTS) {
          this.ui.showNote("Extraction hit a snag — retrying...");
          if (isMaxTokensFailure) {
            lastFailure = `the previous attempt was cut off at max_tokens before completing the JSON output. Tighten any verbatim-preserved sections that aren't strictly needed and emit the policy more compactly.`;
          } else if (isParseFailure) {
            lastFailure = `the previous attempt returned text that could not be parsed as JSON (${detail}).`;
          } else {
            lastFailure = `the previous attempt failed before producing usable output (${detail}). Try again.`;
          }
          continue;
        }

        this.ui.showError(
          `Policy extraction failed: ${error instanceof Error ? error.message : "Unknown error"}. Run aegis init again.`
        );
        return {
          policy: null,
          failure: {
            category,
            detail,
          },
        };
      }
    }

    // Defensive fall-through — every code path inside the for loop
    // either returns or continues, so reaching here would mean
    // MAX_ATTEMPTS was exhausted via continue without a final
    // return. Keep the type sound rather than relying on an
    // unreachable.
    return { policy: null };
  }

  /**
   * Format existing policy file contents as a baseline string
   * for the extraction prompt. Returns undefined when there is no
   * usable baseline — first-time init, or a return visit where the
   * on-disk state did not satisfy the full spec floor (constitution
   * + governance + ledger + at least one role) as parseable
   * non-empty JSON. Partial baselines must not be passed to
   * extraction labeled as "literal starting point" — that's the
   * silent-drift failure mode the scanner's hasUsableBaseline gate
   * exists to prevent.
   */
  private buildExistingPolicyBaseline(): string | undefined {
    if (!this.scan.hasUsableBaseline) {
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

export async function handleDiscoverySlashCommand(
  input: string,
  ui: Pick<TerminalUI, "showNote">,
  switchModel: () => Promise<void>
): Promise<boolean> {
  const command = resolveSlashCommand(input, DISCOVERY_COMMANDS);
  if (!command) return false;

  if (command.expanded) {
    ui.showNote(formatSlashCommandMatch(command.command));
  }
  if (
    command.command.name === "/quit" ||
    command.command.name === "/exit"
  ) {
    throw new AegisExit(
      0,
      "No worries — exiting without writing policy changes. Pick this up anytime with aegis init."
    );
  }
  if (command.command.name === "/model") {
    await switchModel();
  }

  return true;
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

/**
 * Heuristic for "the user's most recent message was an unambiguous
 * affirmation." Used as a gate for completion markers — the engine
 * refuses to honor [DISCOVERY_COMPLETE] or [NO_CHANGES] unless the
 * user turn that preceded the marker reads as a clear go-ahead.
 *
 * Conservative by design. False negatives (treating a real
 * affirmation as non-affirmation) just mean the marker is dropped
 * and the conversation continues — Aegis re-asks, the user confirms
 * again, extraction proceeds. False positives (treating a
 * non-affirmation as affirmation) would let premature extraction
 * slip through, which is the whole thing we're guarding against.
 *
 * Rules:
 * - Empty or very long messages never count as simple affirmations.
 * - Any question, hedge, refusal, or new-instruction signal blocks
 *   affirmation regardless of other content.
 * - The message must contain at least one recognized affirmative
 *   token — "yes", "proceed", "looks good", "ship it", and similar.
 */
function isSimpleAffirmative(userInput: string): boolean {
  const trimmed = userInput.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 80) return false;
  if (trimmed.includes("?")) return false;

  const hedgeSignals = [
    "but ", "actually", "however", "wait", "hmm",
    "add ", "remove ", "change ", "update ", "make ", "set ", "include ",
    "delete ", "fix ", "instead", "rather",
    "one more", "one thing", "except", "also", "additionally",
    " no ", "not ", "don't", "dont", "stop",
  ];
  if (hedgeSignals.some((s) => trimmed.includes(s))) return false;

  const affirmativeTokens = [
    "yes", "yeah", "yep", "yup",
    "ok", "okay",
    "sure", "alright", "cool",
    "proceed", "continue", "go ahead",
    "do it", "ship it", "let's go", "let's do it",
    "confirmed", "confirm",
    "looks good", "sounds good", "sounds right", "that works",
    "that's right", "exactly", "correct",
    "agreed", "approved", "perfect",
    "👍", "🚀", "+1",
  ];
  return affirmativeTokens.some((t) => trimmed.includes(t));
}

/**
 * Heuristic for "the user's most recent message was an unambiguous
 * statement that nothing needs to change." Gate for the [NO_CHANGES]
 * marker, paired with isSimpleAffirmative for [DISCOVERY_COMPLETE].
 *
 * Matches the specific no-change forms the system prompt teaches
 * Aegis to wait for — "no changes", "nothing needs to change",
 * "everything looks good", "just checking in, no changes". Those
 * forms either contain hedge words (" no ") or carry no affirmative
 * token, so isSimpleAffirmative legitimately rejects them — which is
 * why [NO_CHANGES] gets its own gate.
 *
 * Reversal discourse markers ("actually", "but", "wait", "except")
 * block the match so "no changes, actually add a role" cannot slip
 * through. Questions always block.
 */
function isNoChangeConfirmation(userInput: string): boolean {
  const trimmed = userInput.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (trimmed.includes("?")) return false;

  // Three categories of blockers. ANY match disqualifies the message
  // from firing [NO_CHANGES], regardless of whether a no-change
  // phrase is also present. "no changes, also refresh the handoff"
  // reads as a deliverable request, not a no-change confirmation,
  // and the extraction path should run.
  const blockers = [
    // Reversal discourse markers — user is qualifying their statement
    "actually", "but ", "wait", "hmm ", "except", "however",
    // Add-on connectors indicating a new instruction follows
    "also ", "plus ", "oh and ", "one more", "one thing", "additionally",
    // Imperative verbs for direct policy edits — all space-suffixed
    // so past-tense and gerund forms (updated, changing) don't trip
    // the blocker for legitimate no-change statements.
    "add ", "remove ", "change ", "update ", "modify ", "include ",
    "delete ", "fix ", "create ", "set ", "switch ",
    "adjust ", "tweak ", "revise ", "refactor ", "tune ",
    // Deliverable regeneration verbs — user wants output produced.
    // "extract " is space-suffixed on purpose so it matches the verb
    // form but not nouns like "extraction" or "extracted" (the second
    // of which Codex flagged as over-matching in the previous pass).
    "refresh", "regenerate", "re-extract", "reextract",
    "rewrite", "rebuild", "redo", "re-run", "rerun",
    "generate ", "produce ",
    "extract ",
  ];
  if (blockers.some((w) => trimmed.includes(w))) return false;

  const noChangePhrases = [
    "no changes",
    "no change",
    "nothing needs to change",
    "nothing to change",
    "nothing needs changing",
    "nothing needs updating",
    "nothing's changed",
    "nothing has changed",
    "everything looks good",
    "everything's good",
    "everything still looks good",
    "looks good as is",
    "all good here",
    "all looks good",
    "no updates needed",
    "no updates",
    "no modifications",
    "we're good",
    "we're all set",
  ];
  return noChangePhrases.some((p) => trimmed.includes(p));
}

function transcriptRoleLabel(role: Message["role"]): string {
  switch (role) {
    case "system":
      return "System";
    case "user":
      return "Human";
    case "assistant":
      return "Aegis";
  }
}

/**
 * Heuristic for "the user is retracting or declining something." Used
 * to gate [GITIGNORE_REVOKE] so a drifted marker cannot silently
 * clear consent the user actually granted earlier in the session.
 * Conservative in the opposite direction of isSimpleAffirmative —
 * false negatives mean a legitimate retraction gets ignored and the
 * user can rephrase; false positives mean we accept a spurious
 * revoke and the user loses an opt-in they made (recoverable by
 * re-opting-in, which is cheap).
 */
function isRetractionSignal(userInput: string): boolean {
  const trimmed = userInput.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (trimmed.includes("?")) return false;

  const retractionTokens = [
    "skip", "don't", "dont",
    "cancel", "revoke", "undo", "nevermind",
    "scratch that", "retract", "forget it",
    "change my mind", "changed my mind",
    "actually no", "actually, no",
    "no thanks", "no thank you",
    "not anymore", "never mind",
    "leave it", "hands off",
    "stop",
  ];
  return retractionTokens.some((t) => trimmed.includes(t));
}
