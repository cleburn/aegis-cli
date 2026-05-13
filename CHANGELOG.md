# Changelog

All notable changes to `aegis-cli` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.7] — 2026-05-12

### Added
- License-grounded project identity discovery. The scanner now reads `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENSE-MIT`, `LICENSE-APACHE`, `LICENSE-APACHE-2.0`, `COPYING`, `COPYING.md`, and `COPYING.txt` files and surfaces them as `PROJECT LICENSE EVIDENCE` in the scan briefing. The discovery prompt now grounds project license claims in observable file evidence or direct user confirmation rather than inferring from adjacent context (e.g. a mentioned foundation-layer license).
- Extraction shape normalization for typed-object arrays. Legacy string-array forms in extracted policies (e.g. `tech_stack.key_libraries: ["pytest", "ruff"]`) are now repaired to their required object shape (`[{name: "pytest", purpose: "..."}]`) before schema validation, so extraction reliably produces schema-valid output on the first attempt across all typed-object fields in constitution, governance, role, and ledger schemas.
- Identity-grounding language in the discovery system prompt to distinguish project claims from claims about dependencies, foundation layers, forks, upstream templates, or adjacent context.

### Changed
- Streaming UI replaces the bounded live-tail with progressive line commit. As each wrapped line of an Aegis turn completes, it moves into the persistent conversation history immediately; only the currently-in-progress line stays in the dynamic region. Visible incremental progress is preserved for long messages while still rendering each line exactly once.

### Fixed
- Long Aegis turns no longer produce duplicate first-line content in terminal scrollback when the response exceeds the viewport.

## [0.4.6] — 2026-05-12

### Added
- Discovery completion salvage now accepts long-form user affirmations. A user message ending with a clear go-ahead (e.g. "...all of that looks right. Draft it.") transitions discovery to extraction even when the prior turn carried other content, while hedge signals (`but`, `actually`, `add`, `change`, `one more`, etc.) continue to block premature completion.
- System prompt guidance directs Aegis to ask for a clean final confirmation when the user introduces final changes alongside an affirmation, so the policy is drafted against the final intended scope.

### Changed
- Discovery completion gate split into two functions: short standalone confirmations still go through `isSimpleAffirmative`; longer messages use the new `isDiscoveryCompletionAffirmation` with its own end-of-message regex and late-change blocker list.

### Fixed
- Inline comments document why `isDiscoveryCompletionAffirmation` diverges intentionally from `isSimpleAffirmative`'s blocker list, and why the streaming live tail is capped at six lines.

## [0.4.5] — 2026-05-12

### Added
- Last-resort discovery completion salvage. When the model omits the literal `[DISCOVERY_COMPLETE]` marker after an unambiguous user affirmation, the engine auto-injects the marker provided four structural gates pass (no existing marker, prior user turn affirmed, response contains no trailing question, response shows positive completion intent). Auto-injection emits a stderr breadcrumb so the path is observable from outside.
- System prompt strengthened with an explicit example of the exact final acknowledgement-plus-marker shape.

### Changed
- Streaming response render is bounded to a terminal-height-aware live tail. Long Aegis turns no longer scroll early content into permanent scrollback before the static-history commit fires.
- `isSimpleAffirmative` recognizes additional draft-style affirmations: `draft it`, `draft those`, `draft them`, `write it`, `write those`, `write them`.

## [0.4.4] — 2026-05-12

### Fixed
- Terminal render regressions in the Ink-based UI, including word wrap and line-tagging seams around the `wrapConversationTurn` helper.
- Extraction animation now loops continuously for the full lifetime of an extraction call. The previous behavior of holding the final shield frame after one pass read as "stuck" when extraction ran longer than the animation length.

## [0.4.3] — 2026-05-12

### Added
- Schema-drift surfacing in policy migration. Schema-invalid but parseable policy files now load into `existingPolicyContents` rather than being skipped silently. Validation failures become structured `PolicyMigrationFinding[]` entries with `source: "registry" | "schema_validation"` and per-field error details, which the discovery LLM raises conversationally with the human. Known drift categories detected: `module_map[].owner: null`, `tech_stack.key_libraries[]` as string array, ledger legacy field names (`agent_role`, `description`, `timestamp`, `affected_paths`, `action`).
- Ghost-text slash-command autocomplete in the input prompt. Typing `/m` shows a dimmed `odel - switch models during this discovery session` completion inline; the ghost updates on every keystroke and uses a post-completion command set (`/d` hints `/done`) after extraction.

### Changed
- The `aegis init` splash banner always renders in full on every invocation. The previous quiet-mode return-visit variant has been removed.

### Fixed
- Banner-render-order regression where validation errors could print to stderr before the Ink banner mounted.

## [0.4.2] — 2026-05-12

### Added
- Auto-discovery of local model servers on the Custom (OpenAI-compatible) path. Ollama, LM Studio, llama.cpp, and vLLM running on conventional ports are detected and offered as model options during setup.
- Validation timeouts on provider auth checks: 15 seconds for Anthropic, OpenAI, DeepSeek, and Custom providers, preventing indefinite hangs on slow networks or unreachable endpoints.
- `.github/secret_scanning.yml` configuration for repo-level secret scanning policy.

### Changed
- Hidden-input paste hardening for API key entry: pasted keys no longer leak partial echoes during the masked-input phase.
- Slash-command submit-time prefix matching: typing `/m` and pressing Enter resolves to `/model` rather than rejecting the partial command.

### Removed
- Mistral provider option removed entirely.
- Anthropic Haiku 4.5 removed from the model menu (low confidence in Haiku-tier sessions for Aegis discovery work).
- Model menu reduced from 11 options to 9.

## [0.4.1] — 2026-05-11

### Fixed
- Google OAuth scope corrected to `generative-language.retriever`, unblocking the native Google OAuth path introduced in 0.4.0.

## [0.4.0] — 2026-05-11

### Added
- Native Google Desktop OAuth flow for Gemini authentication. The CLI now performs a full OAuth dance with Google's Desktop App OAuth client and stores refresh tokens at `~/.aegis/oauth/google/credentials.json`. No more dependency on `gcloud` Application Default Credentials.
- Improved Google sign-in messaging through the OAuth handoff.

### Removed
- ADC (`gcloud auth application-default login`) path for Google authentication. The native OAuth flow replaces it entirely.

## [0.3.9] — 2026-05-11

### Added
- Google `gcloud` auth path and validation timeout for the Gemini provider (interim solution before native OAuth landed in 0.4.0).

## [0.3.8] — 2026-05-11

### Changed
- Mid-session `/model` switch menu now renders inside Ink rather than as a separate readline interaction, eliminating the crash that occurred when readline reclaimed stdin from the Ink-managed surface.

## [0.3.7] — 2026-05-10

### Fixed
- Restored cooked-mode terminal state for readline prompts so model-selection and API-key entry render and accept input cleanly.

## [0.3.6] — 2026-05-10

### Fixed
- Ink input is now paused during model-switch flows to prevent input from being dispatched to both readline and Ink simultaneously.

## [0.3.5] — 2026-05-10

### Changed
- Disabled OpenAI reasoning drafts that were leaking partial chain-of-thought into discovery output.

## [0.3.4] — 2026-05-10

### Fixed
- Hidden key entry no longer drops or echoes characters on certain terminal emulators; max-length cap added so accidental long pastes don't silently truncate.

## [0.3.3] — 2026-05-10

### Changed
- OpenAI model IDs corrected to the real published identifiers (`gpt-5.5`, `gpt-5.4`) replacing earlier guesses.

## [0.3.2] — 2026-05-10

### Fixed
- Fresh-init aborts no longer load stale repo session transcripts as if they were part of the new init briefing.
- Authored policy content is now cleanly separated from scaffolding output in the writer, so partially-completed inits don't contaminate the next run's existing-policy detection.

## [0.3.1] — 2026-05-10

### Changed
- Init lock file moved out of `.agentpolicy/` and into a sibling location, so the lock is never mistaken for policy content during scans.

## [0.3.0] — 2026-05-10

The Path B release: agent-agnostic, multi-provider, Node 22.3.0+.

### Added
- Multi-provider LLM runtime. The discovery and extraction engine now runs against Anthropic, OpenAI, Google Gemini, DeepSeek, and Mistral via a shared provider abstraction, with per-provider streaming, retry, and error semantics.
- Multi-provider configuration with migration from earlier single-provider configs to the new `providers` block in `~/.aegis/config.json`.
- `/model` slash command for mid-session provider/model switching with soft conversation reset (history preserved, the new model reads earlier turns on its next response).
- Model selection prompt before the init banner, so users confirm or change the active model up front.
- Provider install flow with API-key entry, validation, and (for Google) OAuth or ADC handoff.
- Provider smoke tests covering auth and basic chat for each supported provider.
- Schema validation of policy files in the scanner before they're accepted as a usable baseline. Invalid baselines are skipped with structured reasons rather than silently included.
- Policy migration detection: legacy `agent_role`-style ledger entries and other known-drift shapes are flagged for the LLM to surface conversationally.
- Session transcript persistence on every exit path, including SIGINT.
- Typed `MaxTokensError` and explicit `max_tokens` extraction-failure category, so truncation is no longer silent or mistaken for a transport failure.
- System message role for engine-generated context insertions (e.g. model switch announcements).

### Changed
- Node engine floor raised to `>=22.3.0` to match `@google/genai` requirements; Node 20 dropped after April 2026 EOL.
- `@anthropic-ai/sdk` bumped to `^0.95.1`.
- `glob` bumped to `^13.0.6`.
- Aegis-MCP entry merging into pre-existing `.mcp.json` is now silent and additive instead of writing a parallel file.
- First-visit opener split by scan tier (greenfield, normal, dense), with tier-specific briefing prose.
- Cross-platform path normalization in `isSensitiveFile` and file-read display paths so slash-anchored patterns and regex matches work on Windows.
- Transport-failure copy no longer claims a network cause for rate-limit, 5xx, or timeout errors; auth and transport failures are differentiated in `provider.validate()`.
- Policy-baseline reads tightened to an explicit allowlist; oversized policy files and non-regular files surface clear errors.

### Fixed
- Centralized the `.agentpolicy/` contract surface in `src/policy/manifest.ts` so contract drift between writer, scanner, and validator is structurally prevented.
- `repoHasRealSource` now gates the "mature-no-docs" opener rather than relying on stack signals alone.
- Stale 10KB read-cap note and outdated `$schema` URLs removed from the system prompt.
- Working non-canonical `.mcp.json` setups are no longer called "broken" in skipped-path copy; malformed Aegis entries are surfaced separately.
- Role-identity check extended to `validatePolicy`; path leaks in read errors are sanitized.
- Outer-key vs inner `role.name` reconciliation enforced on both read and write sides.
- Two `deployment_intent` fallback misclassifications corrected.
- `LockConflictError` no longer claims "PID 0" when the holder PID is genuinely unknown.

## [0.2.x] — 2026-03-11 → 2026-04-16

Pre-Path-B iteration phase (versions 0.1.12 through 0.2.39). Forty-plus releases of rapid early-development iteration on the single-provider (Anthropic) CLI, including the initial discovery engine, the first `.agentpolicy/` writer, schema scaffolding, and the foundation for the multi-provider refactor that became 0.3.0. Tag history is preserved in the repository; no per-version release notes are backfilled for this phase.

[Unreleased]: https://github.com/cleburn/aegis-cli/compare/v0.4.7...HEAD
[0.4.7]: https://github.com/cleburn/aegis-cli/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/cleburn/aegis-cli/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/cleburn/aegis-cli/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/cleburn/aegis-cli/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/cleburn/aegis-cli/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/cleburn/aegis-cli/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/cleburn/aegis-cli/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/cleburn/aegis-cli/compare/v0.3.9...v0.4.0
[0.3.9]: https://github.com/cleburn/aegis-cli/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/cleburn/aegis-cli/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/cleburn/aegis-cli/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/cleburn/aegis-cli/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/cleburn/aegis-cli/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/cleburn/aegis-cli/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/cleburn/aegis-cli/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/cleburn/aegis-cli/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/cleburn/aegis-cli/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/cleburn/aegis-cli/releases/tag/v0.3.0
