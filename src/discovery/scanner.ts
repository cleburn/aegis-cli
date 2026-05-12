import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import ignoreLib from "ignore";
import mammoth from "mammoth";
import * as pdfParse from "pdf-parse";
import {
  POLICY_FLOOR,
  POLICY_FLOOR_PATHS,
  ROLES_DIR_RELATIVE,
  ROLES_GLOB,
  ROLE_SCHEMA,
} from "../policy/manifest.js";
import { validateAgainstSchema } from "../policy/validator.js";
import {
  detectPolicyDeprecations,
  detectSchemaValidationDrift,
  type PolicyMigrationFinding,
} from "../policy/deprecations.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface FileContent {
  /** Relative path from project root */
  path: string;
  /** File contents (may be truncated) */
  content: string;
  /** Whether the content was truncated to fit size limits */
  truncated: boolean;
}

/**
 * Scan tier — determines how much of the project's content gets read into
 * the discovery briefing.
 *
 * - tiny: <50 eligible files. Full content scan (current behavior).
 * - normal: default. Targeted reads — config files, CI workflows, root
 *   README (first 200 lines). No recursive markdown, no docs/, no tests/.
 * - massive: too large for a content scan. Metadata only. The opener
 *   pivots straight to conversation.
 *
 * Tier is selected by `detectScanTier` using fs.stat only (no content
 * reads). Env var `AEGIS_SCAN_MODE` forces a specific tier for power users.
 */
export type ScanTier = "tiny" | "normal" | "massive";

export interface ScanResult {
  /** Absolute path to project root */
  root: string;
  /** Scan tier — controls how aggressively file contents were read */
  scanTier: ScanTier;
  /** Total eligible file count observed by the pre-scan */
  scanFileCount: number;
  /** Total eligible byte size observed by the pre-scan */
  scanByteSize: number;
  /** Project name (from package.json, pyproject.toml, or directory name) */
  projectName: string;
  /** Project description if found (package.json description, README first paragraph, etc.) */
  projectDescription: string;
  /** Detected languages */
  languages: string[];
  /** Detected frameworks */
  frameworks: string[];
  /** Detected package managers */
  packageManagers: string[];
  /** Detected infrastructure/CI */
  infrastructure: string[];
  /** Top-level directories (likely modules) */
  topLevelDirs: string[];
  /** Directory tree structure, 2 levels deep */
  directoryTree: Record<string, string[]>;
  /** Key config files found */
  configFiles: string[];
  /** Whether .agentpolicy/ already exists */
  hasExistingPolicy: boolean;
  /** Whether .agentpolicy/ contains canonical user-authored policy files */
  hasAuthoredPolicy: boolean;
  /**
   * Whether the on-disk .agentpolicy/ provides a baseline downstream
   * code can use as a return-visit starting point. True iff the full
   * spec floor (constitution.json + governance.json +
   * state/ledger.json + at least one role file) all loaded as
   * non-empty parseable JSON. Schema-invalid but parseable files are
   * still usable as migration baselines and surface separately in
   * policyMigrationFindings; malformed, empty, unreadable, or missing
   * floor pieces are not usable.
   */
  hasUsableBaseline: boolean;
  /** Existing .agentpolicy files if found */
  existingPolicyFiles: string[];
  /** Contents of existing .agentpolicy files */
  existingPolicyContents: FileContent[];
  /** User-authored policy shapes that need conversational migration */
  policyMigrationFindings: PolicyMigrationFinding[];
  /** Transcripts from prior Aegis sessions */
  existingSessionTranscripts: FileContent[];
  /** Raw package.json data if found */
  packageJson?: Record<string, unknown>;
  /** Scripts from package.json (or equivalent) */
  scripts: Record<string, string>;
  /** Approximate file counts by extension */
  fileCounts: Record<string, number>;
  /** Contents of high-value files Aegis actually read */
  fileContents: FileContent[];
  /** Files detected but intentionally not read (sensitive/private) */
  skippedSensitiveFiles: string[];
}

// ── Constants ──────────────────────────────────────────────────────────

/** Maximum bytes to read from any single file */
const MAX_FILE_SIZE = 10 * 1024; // 10KB

const LANGUAGE_SIGNALS: Record<string, { files: string[]; name: string }> = {
  typescript: {
    files: ["tsconfig.json", "tsconfig.*.json"],
    name: "TypeScript",
  },
  javascript: { files: ["jsconfig.json"], name: "JavaScript" },
  python: {
    files: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
    name: "Python",
  },
  rust: { files: ["Cargo.toml"], name: "Rust" },
  go: { files: ["go.mod"], name: "Go" },
  java: { files: ["pom.xml", "build.gradle", "build.gradle.kts"], name: "Java" },
  ruby: { files: ["Gemfile"], name: "Ruby" },
  php: { files: ["composer.json"], name: "PHP" },
  csharp: { files: ["*.csproj", "*.sln"], name: "C#" },
  swift: { files: ["Package.swift"], name: "Swift" },
};

const FRAMEWORK_SIGNALS: Record<string, { files?: string[]; deps?: string[] }> =
  {
    "next.js": { files: ["next.config.*"], deps: ["next"] },
    react: { deps: ["react"] },
    vue: { files: ["vue.config.*", "nuxt.config.*"], deps: ["vue"] },
    angular: { files: ["angular.json"], deps: ["@angular/core"] },
    svelte: { files: ["svelte.config.*"], deps: ["svelte"] },
    express: { deps: ["express"] },
    fastapi: { deps: ["fastapi"] },
    django: { deps: ["django"], files: ["manage.py"] },
    flask: { deps: ["flask"] },
    rails: { files: ["Gemfile"], deps: ["rails"] },
    prisma: { files: ["prisma/schema.prisma"], deps: ["prisma", "@prisma/client"] },
    drizzle: { deps: ["drizzle-orm"] },
    tailwind: { files: ["tailwind.config.*"], deps: ["tailwindcss"] },
  };

const PACKAGE_MANAGER_SIGNALS: Record<string, string[]> = {
  pnpm: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
  npm: ["package-lock.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lockb"],
  pip: ["requirements.txt", "requirements-*.txt"],
  poetry: ["poetry.lock"],
  pipenv: ["Pipfile.lock"],
  cargo: ["Cargo.lock"],
  "go modules": ["go.sum"],
};

const INFRA_SIGNALS: Record<string, string[]> = {
  docker: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", ".dockerignore"],
  terraform: ["*.tf", "terraform/"],
  "github-actions": [".github/workflows/"],
  gitlab: [".gitlab-ci.yml"],
  aws: ["serverless.yml", "samconfig.toml", "cdk.json"],
  vercel: ["vercel.json"],
  netlify: ["netlify.toml"],
  kubernetes: ["k8s/", "kubernetes/", "*.k8s.yml"],
};

/**
 * Files Aegis will always try to read for substance.
 * Config files, documentation, CI — anything that reveals
 * how the project works, not just that it exists.
 */
const HIGH_VALUE_FILES: string[] = [
  // Documentation — read in full
  "README.md",
  "README",
  "readme.md",
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "ARCHITECTURE.md",
  "docs/README.md",

  // Project config — read for substance
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",

  // Framework config
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "svelte.config.js",
  "angular.json",

  // Database / ORM
  "prisma/schema.prisma",
  "drizzle.config.ts",

  // CI / Infrastructure
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".github/workflows/ci.yml",
  ".github/workflows/ci.yaml",
  ".github/workflows/main.yml",
  ".github/workflows/main.yaml",
  ".github/workflows/deploy.yml",
  ".github/workflows/deploy.yaml",
  ".gitlab-ci.yml",
  "vercel.json",
  "netlify.toml",

  // Linting / formatting
  ".eslintrc.json",
  ".eslintrc.js",
  "eslint.config.js",
  "eslint.config.mjs",
  ".prettierrc",
  ".prettierrc.json",
  "prettier.config.js",
  ".editorconfig",

  // Environment shape (not values)
  ".env.example",
  ".env.template",
  ".env.sample",
];

/**
 * Patterns that indicate a file is sensitive and should NOT be read.
 * Aegis will note these files exist but respect their privacy.
 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  // Environment files with real values
  /^\.env$/,
  /^\.env\.local$/,
  /^\.env\.production$/,
  /^\.env\.development$/,
  /^\.env\.[^.]+$/, // .env.anything (except .example, .template, .sample — handled below)

  // Credentials and keys
  /credentials\.json$/i,
  /serviceAccountKey\.json$/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /^id_rsa/,
  /^id_ed25519/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,

  // Token files
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^auth\.json$/,
  /^\.netrc$/,
  /^\.docker\/config\.json$/,

  // Secret management
  /secrets?\.(ya?ml|json|toml)$/i,
  /vault\.(ya?ml|json)$/i,

  // Private directories
  /^secrets?\//i,
  /^private\//i,
  /^\.keys?\//i,

  // Database files (sensitive data + context bloat risk)
  /\.sqlite3?$/i,
  /\.db$/i,
  /\.sql$/i,
  /\.mdb$/i,
  /\.rdb$/i,
  /\.dump$/i,
  /\.bak$/i,

  // Database / data directories
  /^data\//i,
  /^db\//i,
  /^dumps?\//i,
  /^backups?\//i,
];

/** These .env variants are safe to read (they're templates, not real values) */
const SAFE_ENV_PATTERNS: RegExp[] = [
  /\.env\.example$/,
  /\.env\.template$/,
  /\.env\.sample$/,
];

/**
 * File extensions that indicate actual source code, used by the
 * deployment_intent maturity heuristic in extractPolicy. A repo with
 * any of these — even without a recognized language config file —
 * counts as a real codebase, not a skeletal hand-authored policy.
 * Kept liberal to cover common stacks including shell scripts and
 * less-popular languages.
 */
const SOURCE_FILE_EXTENSIONS = new Set<string>([
  // Mainstream general-purpose
  ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs",
  ".rs", ".go", ".java", ".kt", ".scala", ".groovy",
  ".rb", ".php", ".swift", ".m", ".mm",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp",
  ".cs", ".fs", ".fsx", ".vb",
  // Shell + scripting
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".psm1", ".psd1",
  ".bat", ".cmd",
  ".pl", ".pm", ".lua", ".tcl",
  // Functional + academic
  ".hs", ".ml", ".mli", ".ex", ".exs", ".elm", ".clj", ".cljs", ".cljc",
  ".erl", ".hrl", ".jl", ".r",
  // Data science + notebooks
  ".ipynb", ".rmd",
  // Mobile + web component
  ".dart", ".vue", ".svelte",
  // C# web
  ".razor", ".cshtml",
  // Database
  ".sql",
  // Emerging / niche
  ".sol", ".zig", ".nim", ".cr", ".v",
]);

/**
 * True when the scanned repo looks like an actual codebase rather
 * than a skeletal project with only policy or documentation. Checks
 * both the config-driven stack detectors (languages, frameworks,
 * infrastructure) and the raw file-extension tally so a repo made
 * of root-level scripts with no config still registers as mature.
 */
export function repoHasRealSource(scan: ScanResult): boolean {
  if (scan.languages.length > 0) return true;
  if (scan.frameworks.length > 0) return true;
  if (scan.infrastructure.length > 0) return true;
  for (const ext of Object.keys(scan.fileCounts)) {
    if (SOURCE_FILE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/**
 * Directories and artifacts that should never enter the scan. Shared
 * between the tier pre-scan and the full discovery glob so both views
 * see the same candidate set.
 */
const NOISE_IGNORE_PATTERNS: string[] = [
  "node_modules/**", "dist/**", "build/**", ".git/**",
  "__pycache__/**", ".next/**", ".nuxt/**", ".output/**",
  "coverage/**", ".cache/**", ".turbo/**", ".vercel/**",
  ".netlify/**", "vendor/**", "target/**", ".agentpolicy/**",
];

// ── Tier Configuration ────────────────────────────────────────────────
//
// Thresholds that decide which tier a repo falls into. Tuned to cover
// roughly 95% of projects with the "normal" targeted-read path.
// Override any of these with env vars for specific repos.
//
//   AEGIS_SCAN_MODE       auto (default) | tiny | normal | massive
//   AEGIS_SCAN_MAX_FILES  file-count ceiling for normal tier
//   AEGIS_SCAN_MAX_BYTES  byte-size ceiling for normal tier

const TIER_DEFAULTS = {
  TINY_MAX_FILES: 50,
  MASSIVE_MAX_FILES: 500,
  MASSIVE_MAX_BYTES: 5 * 1024 * 1024,
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTierThresholds(): {
  tinyMaxFiles: number;
  massiveMaxFiles: number;
  massiveMaxBytes: number;
} {
  return {
    tinyMaxFiles: TIER_DEFAULTS.TINY_MAX_FILES,
    massiveMaxFiles: envInt("AEGIS_SCAN_MAX_FILES", TIER_DEFAULTS.MASSIVE_MAX_FILES),
    massiveMaxBytes: envInt("AEGIS_SCAN_MAX_BYTES", TIER_DEFAULTS.MASSIVE_MAX_BYTES),
  };
}

function resolveForcedTier(): ScanTier | null {
  const mode = (process.env.AEGIS_SCAN_MODE || "auto").toLowerCase();
  if (mode === "tiny" || mode === "normal" || mode === "massive") return mode;
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────

function fileExists(
  root: string,
  pattern: string,
  isIgnored: IgnoreFilter = () => false
): boolean {
  if (pattern.endsWith("/")) {
    const bare = pattern.replace(/\/+$/, "");
    if (!fs.existsSync(path.join(root, pattern))) return false;
    return !isIgnored(bare);
  }
  if (pattern.includes("*")) {
    try {
      const matches = glob.sync(pattern, { cwd: root, nodir: true });
      return matches.some((m) => !isIgnored(m));
    } catch {
      return false;
    }
  }
  if (!fs.existsSync(path.join(root, pattern))) return false;
  return !isIgnored(pattern);
}

function readPackageJson(
  root: string
): Record<string, unknown> | undefined {
  const pkgPath = path.join(root, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    }
  } catch {
    // Not valid JSON
  }
  return undefined;
}

function getDeps(pkg: Record<string, unknown> | undefined): string[] {
  if (!pkg) return [];
  const deps = {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };
  return Object.keys(deps);
}

/** Hard ceiling — don't even attempt files larger than this */
export const MAX_FILE_SIZE_ABSOLUTE = 1024 * 1024; // 1MB

// ── Document Parsers ──────────────────────────────────────────────────

/**
 * Extensions that Aegis can parse from binary formats into text.
 * Maps lowercase extension (with dot) to an async parser function.
 */
const PARSEABLE_EXTENSIONS: Record<
  string,
  (filePath: string) => Promise<string | null>
> = {
  ".docx": parseDocx,
  ".pdf": parsePdf,
};

async function parseDocx(filePath: string): Promise<string | null> {
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || null;
  } catch {
    return null;
  }
}

async function parsePdf(filePath: string): Promise<string | null> {
  try {
    const buffer = fs.readFileSync(filePath);
    const result = await (pdfParse as any).default(buffer);
    return result.text || null;
  } catch {
    return null;
  }
}

// ── Sentinel for unsupported binary files ─────────────────────────────

export const UNSUPPORTED_BINARY = Symbol("unsupported-binary");

/**
 * Read a file's contents, respecting the size cap.
 * - Plaintext files: read directly with truncation.
 * - Recognized document formats (DOCX, PDF, XLSX): parse to text.
 * - Unknown binary files: returns UNSUPPORTED_BINARY symbol so the
 *   caller can flag it visibly in skippedSensitiveFiles.
 * Returns null if the file doesn't exist, can't be read, or exceeds 1MB.
 *
 * `opts.maxSize` overrides the default 10KB soft truncation cap.
 * Scan-time reads use the default because they're dealing with many
 * files and a tight shared context budget. User-initiated reads —
 * Aegis asked to read a specific file mid-conversation via
 * [READ_FILE: path] — should pass MAX_FILE_SIZE_ABSOLUTE so the
 * whole file (up to the 1MB hard ceiling) comes through: truncating
 * a user-requested read at 10KB defeats the purpose of the request.
 */
export async function readFileSafe(
  filePath: string,
  opts: { maxSize?: number } = {}
): Promise<FileContent | null | typeof UNSUPPORTED_BINARY> {
  const softCap = opts.maxSize ?? MAX_FILE_SIZE;
  const humanCap =
    softCap >= 1024 * 1024
      ? `${(softCap / 1024 / 1024).toFixed(0)}MB`
      : `${Math.round(softCap / 1024)}KB`;

  try {
    if (!fs.existsSync(filePath)) return null;

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;

    // Hard ceiling — skip entirely if over 1MB
    if (stat.size > MAX_FILE_SIZE_ABSOLUTE) return null;

    // Check first 512 bytes for null bytes (binary heuristic)
    const probe = Buffer.alloc(Math.min(512, stat.size));
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, probe, 0, probe.length, 0);
    fs.closeSync(fd);

    if (probe.includes(0)) {
      // Binary file detected — check if we have a parser for this format
      const ext = path.extname(filePath).toLowerCase();
      const parser = PARSEABLE_EXTENSIONS[ext];

      if (parser) {
        const extractedText = await parser(filePath);
        if (extractedText) {
          const truncated = extractedText.length > softCap;
          const finalContent = truncated
            ? extractedText.slice(0, softCap) +
              `\n\n[... truncated at ${humanCap} — parsed from ${ext.slice(1).toUpperCase()} ...]`
            : extractedText;
          return {
            path: "", // caller sets this
            content: finalContent,
            truncated,
          };
        }
        // Parser returned nothing — treat as unsupported
        return UNSUPPORTED_BINARY;
      }

      // No parser available for this binary format
      return UNSUPPORTED_BINARY;
    }

    // Plaintext path
    const truncated = stat.size > softCap;
    const content = fs.readFileSync(filePath, "utf-8");
    const finalContent = truncated
      ? content.slice(0, softCap) + `\n\n[... truncated at ${humanCap} ...]`
      : content;

    return {
      path: "", // caller sets this to the relative path
      content: finalContent,
      truncated,
    };
  } catch {
    return null;
  }
}

/**
 * Prompt-ingestion ceiling for a single session transcript. A normal
 * aegis init produces a file in the tens-of-KB range; a very long
 * power-user session might reach 1-2MB. Anything beyond this is
 * almost certainly either a tampered file or an accidental paste of
 * bulk data, and either way it should not be reserialized and
 * injected into the discovery prompt — doing so would spike memory
 * and bloat the request. 5MB leaves generous headroom over every
 * realistic session while keeping the worst-case prompt overhead
 * bounded. Oversize files are preserved on disk for audit; they
 * just get a placeholder entry in the prompt instead of being
 * loaded wholesale.
 */
const MAX_SESSION_TRANSCRIPT_SIZE = 5 * 1024 * 1024;

export const OVERSIZE_SESSION = Symbol("oversize-session");

export interface OversizeSessionInfo {
  readonly marker: typeof OVERSIZE_SESSION;
  readonly size: number;
}

/**
 * Read a prior Aegis session transcript without the 10KB truncation
 * cap that general scan files use. The "pick up where you left off"
 * contract requires full conversation history, not a truncated view.
 */
export async function readSessionTranscript(
  filePath: string
): Promise<FileContent | null | OversizeSessionInfo> {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SESSION_TRANSCRIPT_SIZE) {
      return { marker: OVERSIZE_SESSION, size: stat.size };
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      path: "", // caller sets this to the relative path
      content,
      truncated: false,
    };
  } catch {
    return null;
  }
}

/**
 * Parse + shape-validate a transcript string before it gets reused
 * as LLM prompt context. Session files are plain JSON on disk with
 * no write-time signature, so a user (or anything with write access)
 * could tamper with one and re-run aegis init. Message contents
 * themselves must stay verbatim (they're the conversation), but the
 * surrounding JSON structure is worth locking down: extra top-level
 * fields, unexpected types, or a completely different payload shape
 * should never reach the prompt unchallenged.
 *
 * On success, returns the re-serialized clean shape — stripping any
 * injected fields while preserving every message verbatim. On
 * failure, returns null; the caller substitutes a placeholder entry
 * so the LLM sees that a transcript existed but could not be loaded.
 */
export function validateAndNormalizeTranscript(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as {
    timestamp?: unknown;
    messages?: unknown;
  };

  if (!Array.isArray(obj.messages)) return null;

  const cleanMessages: Array<{ role: string; content: string }> = [];
  for (const m of obj.messages) {
    if (!m || typeof m !== "object") return null;
    const msg = m as { role?: unknown; content?: unknown };
    if (typeof msg.role !== "string") return null;
    if (typeof msg.content !== "string") return null;
    cleanMessages.push({ role: msg.role, content: msg.content });
  }

  const clean: { timestamp?: string; messages: typeof cleanMessages } = {
    messages: cleanMessages,
  };
  if (typeof obj.timestamp === "string") {
    clean.timestamp = obj.timestamp;
  }

  return JSON.stringify(clean, null, 2);
}

/**
 * Check if a relative file path matches sensitive patterns.
 *
 * Patterns in SENSITIVE_FILE_PATTERNS are slash-anchored (e.g.
 * /^secrets?\//, /^\.docker\/config\.json$/, /^private\//) so they
 * can match either a basename or a path prefix. On Windows, the
 * caller may pass a path with backslash separators (e.g.
 * "secrets\\foo.txt", ".docker\\config.json"), which would silently
 * miss those slash-anchored patterns. Normalize OS-native separators
 * to forward slashes before testing, and use path.posix.basename so
 * the basename split also operates on the forward-slash form
 * regardless of OS — path.basename uses the platform separator and
 * would mis-split a forward-slash-normalized path on Windows.
 */
export function isSensitiveFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.posix.basename(normalized);

  // Safe .env variants are explicitly allowed
  if (SAFE_ENV_PATTERNS.some((p) => p.test(basename))) return false;

  // Check against sensitive patterns (test both full relative path and basename)
  return SENSITIVE_FILE_PATTERNS.some(
    (p) => p.test(normalized) || p.test(basename)
  );
}

/**
 * Build a predicate that returns true when a project-relative path is
 * ignored by .gitignore or .claudeignore. Uses the spec-compliant
 * `ignore` library so directory patterns (e.g. `docs/`) correctly
 * match all descendants, negation (`!foo`) works, and path anchoring
 * matches git's semantics.
 *
 * Both files are merged into a single filter so callers don't need to
 * track two sources. Missing or unreadable files contribute nothing
 * rather than erroring.
 */
type IgnoreFilter = (relativePath: string) => boolean;

function buildIgnoreFilter(root: string): IgnoreFilter {
  const ig = ignoreLib();

  for (const fileName of [".gitignore", ".claudeignore"]) {
    try {
      const filePath = path.join(root, fileName);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8");
      ig.add(content);
    } catch {
      // Unreadable — skip this source, don't fail the whole scan
    }
  }

  return (relativePath: string) => {
    if (!relativePath) return false;
    // `ignore` throws on absolute paths or empty strings. Normalize
    // defensively — our callers already pass root-relative paths, but
    // this keeps the predicate robust to '/' prefixes and './' noise.
    const normalized = relativePath
      .replace(/^\.\//, "")
      .replace(/^\/+/, "");
    if (!normalized) return false;
    try {
      return ig.ignores(normalized);
    } catch {
      return false;
    }
  };
}

/**
 * Build a directory tree 2 levels deep from project root.
 * Skips common noise directories.
 */
function buildDirectoryTree(root: string): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  const skipDirs = new Set([
    "node_modules", "dist", "build", ".git", "__pycache__",
    ".next", ".nuxt", ".output", "coverage", ".cache",
    ".turbo", ".vercel", ".netlify", "vendor", "target",
  ]);

  try {
    const topEntries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (skipDirs.has(entry.name)) continue;

      const subPath = path.join(root, entry.name);
      const children: string[] = [];

      try {
        const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.name.startsWith(".")) continue;
          if (skipDirs.has(sub.name)) continue;
          children.push(sub.isDirectory() ? `${sub.name}/` : sub.name);
        }
      } catch {
        // Can't read subdirectory
      }

      tree[entry.name] = children;
    }
  } catch {
    // Can't read root
  }

  return tree;
}

/**
 * Scan for any markdown files at project root that might be documentation.
 * Returns relative paths for files not already in HIGH_VALUE_FILES.
 */
function findRootMarkdownFiles(root: string): string[] {
  const knownMd = new Set(
    HIGH_VALUE_FILES.filter((f) => f.endsWith(".md") && !f.includes("/"))
      .map((f) => f.toLowerCase())
  );

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isFile() &&
          e.name.toLowerCase().endsWith(".md") &&
          !knownMd.has(e.name.toLowerCase())
      )
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Discover CI workflow files beyond the ones hardcoded in HIGH_VALUE_FILES.
 */
function findCIWorkflows(root: string): string[] {
  const workflowDir = path.join(root, ".github", "workflows");
  try {
    if (!fs.existsSync(workflowDir)) return [];
    const entries = fs.readdirSync(workflowDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && (e.name.endsWith(".yml") || e.name.endsWith(".yaml")))
      .map((e) => `.github/workflows/${e.name}`);
  } catch {
    return [];
  }
}

// ── Tier Pre-Scan ─────────────────────────────────────────────────────

/**
 * Cheap tier decision — fs.stat only, no content reads. Enumerates
 * candidate files after filtering noise directories, .gitignore,
 * .claudeignore, and sensitive patterns, then picks the tier by
 * file count and byte size.
 *
 * `AEGIS_SCAN_MODE=tiny|normal|massive` forces the tier regardless of
 * observed size — the enumeration still runs so callers get accurate
 * counts for the briefing.
 *
 * Also returns `fileCounts` — extension-keyed tallies used by the
 * briefing. Reuses this pass so we don't enumerate the tree twice.
 */
function detectScanTier(
  root: string,
  isIgnored: IgnoreFilter
): {
  tier: ScanTier;
  fileCount: number;
  byteSize: number;
  fileCounts: Record<string, number>;
} {
  const thresholds = resolveTierThresholds();
  const forced = resolveForcedTier();

  // Forced massive skips enumeration entirely — the whole point of the
  // escape hatch is "don't walk this tree." Counts are zeroed; the
  // briefing will note the mode is forced.
  if (forced === "massive") {
    return { tier: "massive", fileCount: 0, byteSize: 0, fileCounts: {} };
  }

  let candidates: string[] = [];
  try {
    candidates = glob.sync("**/*", {
      cwd: root,
      nodir: true,
      dot: true,
      ignore: NOISE_IGNORE_PATTERNS,
    });
  } catch {
    // Enumeration failed — treat as empty, caller will pick normal tier
  }

  let fileCount = 0;
  let byteSize = 0;
  const fileCounts: Record<string, number> = {};

  for (const rel of candidates) {
    if (isIgnored(rel)) continue;
    if (isSensitiveFile(rel)) continue;

    try {
      const stat = fs.statSync(path.join(root, rel));
      if (!stat.isFile()) continue;
      fileCount++;
      byteSize += stat.size;
      const ext = path.extname(rel).toLowerCase() || "(no ext)";
      fileCounts[ext] = (fileCounts[ext] || 0) + 1;
    } catch {
      // stat failure — skip
    }
  }

  const tier: ScanTier =
    forced !== null
      ? forced
      : fileCount < thresholds.tinyMaxFiles
      ? "tiny"
      : fileCount >= thresholds.massiveMaxFiles ||
        byteSize >= thresholds.massiveMaxBytes
      ? "massive"
      : "normal";

  return { tier, fileCount, byteSize, fileCounts };
}

// ── Main Scanner ───────────────────────────────────────────────────────

export async function scanRepo(root: string): Promise<ScanResult> {
  const projectRoot = path.resolve(root);
  const isIgnored = buildIgnoreFilter(projectRoot);
  // Respect ignore rules for package.json itself — a user who explicitly
  // adds package.json to .claudeignore is saying "don't use this as a
  // signal." Skipping the read propagates that through every downstream
  // detector (deps, languages, frameworks, scripts).
  const pkg = isIgnored("package.json") ? undefined : readPackageJson(projectRoot);
  const deps = getDeps(pkg);

  // ── Detect languages ─────────────────────────────────────────────
  const languages: string[] = [];
  for (const [lang, signal] of Object.entries(LANGUAGE_SIGNALS)) {
    if (signal.files.some((f) => fileExists(projectRoot, f, isIgnored))) {
      languages.push(lang);
    }
  }
  if (deps.length > 0 && !languages.includes("javascript") && !languages.includes("typescript")) {
    languages.push("javascript");
  }

  // ── Detect frameworks ────────────────────────────────────────────
  const frameworks: string[] = [];
  for (const [fw, signal] of Object.entries(FRAMEWORK_SIGNALS)) {
    const hasFile = signal.files?.some((f) => fileExists(projectRoot, f, isIgnored));
    const hasDep = signal.deps?.some((d) => deps.includes(d));
    if (hasFile || hasDep) {
      frameworks.push(fw);
    }
  }

  // ── Detect package managers ──────────────────────────────────────
  const packageManagers: string[] = [];
  for (const [pm, files] of Object.entries(PACKAGE_MANAGER_SIGNALS)) {
    if (files.some((f) => fileExists(projectRoot, f, isIgnored))) {
      packageManagers.push(pm);
    }
  }

  // ── Detect infrastructure ────────────────────────────────────────
  const infrastructure: string[] = [];
  for (const [infra, files] of Object.entries(INFRA_SIGNALS)) {
    if (files.some((f) => fileExists(projectRoot, f, isIgnored))) {
      infrastructure.push(infra);
    }
  }

  // ── Top-level directories ────────────────────────────────────────
  const topLevelDirs: string[] = [];
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules" &&
        entry.name !== "dist" &&
        entry.name !== "build" &&
        entry.name !== "__pycache__" &&
        entry.name !== ".git"
      ) {
        topLevelDirs.push(entry.name);
      }
    }
  } catch {
    // Can't read directory
  }

  // ── Directory tree (2 levels deep) ───────────────────────────────
  const directoryTree = buildDirectoryTree(projectRoot);

  // ── Config files ─────────────────────────────────────────────────
  const configSignals = [
    "tsconfig.json", "next.config.*", "vite.config.*", "tailwind.config.*",
    ".eslintrc*", "eslint.config.*", ".prettierrc*", "prettier.config.*",
    ".env.example", "docker-compose.yml", "Dockerfile",
    "prisma/schema.prisma", ".editorconfig",
  ];
  const configFiles: string[] = [];
  for (const pattern of configSignals) {
    if (fileExists(projectRoot, pattern, isIgnored)) {
      configFiles.push(pattern);
    }
  }

  // ── Existing policy ──────────────────────────────────────────────
  const policyDir = path.join(projectRoot, ".agentpolicy");
  const hasExistingPolicy = fs.existsSync(policyDir);
  let hasAuthoredPolicy = false;
  let existingPolicyFiles: string[] = [];
  const existingPolicyContents: FileContent[] = [];
  let policyMigrationFindings: PolicyMigrationFinding[] = [];
  let hasUsableBaseline = false;

  if (hasExistingPolicy) {
    // Policy contract surface is exactly four shapes — the spec floor
    // every conforming .agentpolicy/ defines: constitution, governance,
    // the role files, and the ledger. Everything else under the
    // directory (session transcripts, overrides.jsonl, future state
    // files, tooling caches) is implementation surface, not contract,
    // and does not belong in the extraction baseline. The previous
    // recursive glob misclassified session transcripts as policy and
    // would silently treat any future state-dir artifact the same
    // way; the centralized POLICY_FLOOR manifest names the contract
    // directly and self-documents intent.
    try {
      const fixedPresent = POLICY_FLOOR_PATHS.filter((rel) =>
        fs.existsSync(path.join(policyDir, rel))
      );
      let roleFiles: string[] = [];
      // Sort role files alphabetically so the prompt ordering is
      // deterministic across filesystems and across runs. glob's
      // internal order is implementation-dependent (readdir order on
      // most systems, which varies by filesystem and inode layout);
      // sorting here gives a stable briefing for prompt-cache hits
      // and human-readable diffs across sessions.
      try {
        roleFiles = glob.sync(ROLES_GLOB, { cwd: policyDir }).sort();
      } catch {
        // Fixed floor files are still enough to distinguish authored
        // partial policy from Aegis-only scaffolding.
      }
      hasAuthoredPolicy = fixedPresent.length > 0 || roleFiles.length > 0;
      // Order: non-ledger floor files, then role files, then the
      // ledger last. Pull the ledger path from the manifest so a
      // future spec change that renames or moves the ledger doesn't
      // desync the briefing layout from the floor definition.
      const ledgerPath =
        POLICY_FLOOR.find((e) => e.name === "ledger")?.relativePath ??
        "state/ledger.json";
      existingPolicyFiles = [
        ...fixedPresent.filter((f) => f !== ledgerPath),
        ...roleFiles,
        ...fixedPresent.filter((f) => f === ledgerPath),
      ];
    } catch {
      // Can't enumerate directory — leave existingPolicyFiles empty
      // and let the downstream "no readable policy" path in
      // system-prompt.ts handle the briefing.
    }

    // Use MAX_FILE_SIZE_ABSOLUTE (1MB) rather than the 10KB scan
    // default — the extraction prompt declares this content the
    // "literal starting point" the LLM must preserve verbatim, so
    // any silent mid-document truncation here corrupts the baseline.
    //
    // Each candidate file must clear three gates before it joins
    // the baseline:
    //   1. Read succeeded (readFileSafe returned a FileContent, not
    //      null or UNSUPPORTED_BINARY). Read failure can mean over
    //      the 1MB hard ceiling, restricted permissions, not a
    //      regular file, or vanished between listing and read.
    //   2. Content is non-empty after trimming. An empty file is
    //      typically a partial-write artifact (atomic-rename
    //      interrupted) or a hand-cleared placeholder, not a
    //      baseline.
    //   3. Content parses as valid JSON. Malformed JSON cannot be
    //      fed to the extraction prompt as "literal starting point"
    //      without poisoning the model's understanding of what the
    //      policy currently is.
    //
    // Files failing any gate are surfaced to stderr (so a partial
    // baseline is visible, not silent) and skipped. A previous
    // version threw on unreadable files so silent baseline drift
    // could not slip past on a real return visit; that's still the
    // right safety target for return-visit corruption, but the same
    // code path also fires on stray empty `.agentpolicy/`
    // directories left by an aborted prior init and on partial
    // hand-edits — aborting init in those cases is hostile (the
    // user can't even rerun init to fix things). The new behavior
    // warns loudly, skips the offending file, and lets
    // hasUsableBaseline (computed below) fall through to false so
    // the session is routed as near-first-time. Schema validation is
    // intentionally not a skip gate: parseable older-spec content is
    // the exact material the migration conversation needs to see.
    for (const policyFile of existingPolicyFiles) {
      const fullPath = path.join(policyDir, policyFile);
      const content = await readFileSafe(fullPath, {
        maxSize: MAX_FILE_SIZE_ABSOLUTE,
      });
      if (content === null) {
        process.stderr.write(
          `[aegis] policy file ".agentpolicy/${policyFile}" could not be read — it may exceed the 1MB ceiling, have restrictive permissions, not be a regular file, or have vanished between listing and read. Skipping; treating session as near-first-time so init can still run.\n`
        );
        continue;
      }
      if (typeof content === "symbol") {
        // UNSUPPORTED_BINARY — policy files must be JSON, not a
        // binary format that happened to land at this path.
        process.stderr.write(
          `[aegis] policy file ".agentpolicy/${policyFile}" is a binary file, not JSON. Skipping; treating session as near-first-time.\n`
        );
        continue;
      }
      const trimmed = content.content.trim();
      if (trimmed.length === 0) {
        process.stderr.write(
          `[aegis] policy file ".agentpolicy/${policyFile}" is empty. Skipping; treating session as near-first-time.\n`
        );
        continue;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(trimmed);
      } catch (err) {
        const detail =
          err instanceof Error ? err.message : "unknown parse error";
        process.stderr.write(
          `[aegis] policy file ".agentpolicy/${policyFile}" is not valid JSON (${detail}). Skipping; treating session as near-first-time.\n`
        );
        continue;
      }

      // Schema-validate against the bundled spec schemas. A parseable
      // file that fails current schema validation is not corruption;
      // it may be older user-authored policy that needs a
      // conversational migration. Capture the drift, keep the content
      // in the baseline, and let extraction correct it only after the
      // user confirms the migration.
      //
      // Schema name comes from the centralized manifest: floor
      // entries are looked up by their relativePath; role files
      // share a single schema. Anything not matching either case
      // is left unvalidated (defensive — existingPolicyFiles only
      // ever contains floor + role paths, but the fallback keeps
      // the loop robust to a future enumeration change).
      const floorEntry = POLICY_FLOOR.find(
        (e) => e.relativePath === policyFile
      );
      const schemaName: string | null = floorEntry
        ? floorEntry.schema
        : policyFile.startsWith(`${ROLES_DIR_RELATIVE}/`)
          ? ROLE_SCHEMA
          : null;
      if (schemaName) {
        const result = validateAgainstSchema(
          parsedJson,
          schemaName,
          `.agentpolicy/${policyFile}`
        );
        if (!result.valid) {
          policyMigrationFindings.push(
            ...detectSchemaValidationDrift(
              `.agentpolicy/${policyFile}`,
              result,
              parsedJson
            )
          );
        }

        // Role-file identity cross-check: the on-disk filename's
        // bare name (e.g. roles/frontend.json → "frontend") must
        // match the inner role.name. The role schema validates the
        // inner shape in isolation; this check catches a hand-
        // edited or otherwise out-of-sync file where the filename
        // and the inner role.name disagree. A mismatched baseline
        // would feed extraction one identity at the outer/policy.roles
        // key (built from the filename) and a different identity
        // inside role.name — confusing the LLM about what the role
        // is actually called and breaking deleted_role_names
        // matching on return visits.
        if (schemaName === ROLE_SCHEMA) {
          const bareName = path.basename(policyFile, ".json");
          const declaredName = (
            parsedJson as { role?: { name?: unknown } }
          ).role?.name;
          if (
            typeof declaredName === "string" &&
            declaredName !== bareName
          ) {
            process.stderr.write(
              `[aegis] policy file ".agentpolicy/${policyFile}" has role.name "${declaredName}" but the filename implies "${bareName}". Skipping; treating session as near-first-time.\n`
            );
            continue;
          }
        }
      }

      content.path = `.agentpolicy/${policyFile}`;
      existingPolicyContents.push(content);
    }

    // Floor check — the spec requires constitution + governance +
    // ledger + at least one role for any return-visit context that
    // downstream consumers can use. Anything less is partial state,
    // not a baseline. Schema-drifted files still count as loaded:
    // they are parseable user-authored content and are carried into
    // extraction together with policyMigrationFindings.
    //
    // The check is strict on every enumerated file, not just floor
    // membership. If the directory holds five role files but two
    // failed to load (malformed JSON, empty, unreadable), the
    // extraction baseline would silently be missing those roles —
    // the writer would then see them on disk during reconciliation
    // and preserve them as orphans, exactly the silent-drift mode
    // the return-visit bundle was closing. Requiring every
    // enumerated file (every entry in existingPolicyFiles, which
    // mirrors what fs.existsSync + the roles glob found) to be in
    // the loaded set means any partial load routes through the
    // empty-baseline branch.
    //
    // The per-file load loop above gates each candidate file
    // through readability, non-empty content, and JSON.parse.
    // Schema validation failures are not skipped; they become drift
    // findings so the LLM can ask before migrating the content.
    const loadedPaths = new Set(
      existingPolicyContents.map((c) => c.path)
    );
    const allEnumeratedLoaded = existingPolicyFiles.every((rel) =>
      loadedPaths.has(`.agentpolicy/${rel}`)
    );
    const allFloorLoaded = POLICY_FLOOR.every((entry) =>
      loadedPaths.has(`.agentpolicy/${entry.relativePath}`)
    );
    const hasRole = existingPolicyContents.some((c) =>
      c.path.startsWith(`.agentpolicy/${ROLES_DIR_RELATIVE}/`)
    );
    hasUsableBaseline = allEnumeratedLoaded && allFloorLoaded && hasRole;
    policyMigrationFindings = [
      ...policyMigrationFindings,
      ...detectPolicyDeprecations(existingPolicyContents),
    ];
  }

  // ── Session transcripts ──────────────────────────────────────────
  // Load prior session transcripts verbatim via readSessionTranscript,
  // which skips the 10KB cap that readFileSafe applies to general scan
  // files. The "pick up where you left off" contract requires full
  // conversation history, not a truncated preview. A transcript over
  // the 1MB safety ceiling is surfaced as a placeholder entry so the
  // LLM and the user both see that a session existed but could not
  // be loaded in full.
  const existingSessionTranscripts: FileContent[] = [];
  const sessionsDir = path.join(policyDir, "sessions");
  if (hasExistingPolicy && fs.existsSync(sessionsDir)) {
    try {
      // Sort by mtime so mixed-format directories (legacy ISO-timestamp
      // transcripts alongside new NN-session.json ones) still return
      // in chronological order — pure lexicographic sort would put
      // NN-prefixed names before ISO-prefixed ones because "0" < "2".
      // Secondary sort key is the filename so ties (identical mtime,
      // rare but possible) resolve deterministically rather than
      // falling back to whatever order glob returned.
      const sessionFiles = glob
        .sync("*.json", { cwd: sessionsDir })
        .map((name) => {
          let mtime = 0;
          try {
            mtime = fs.statSync(path.join(sessionsDir, name)).mtimeMs;
          } catch {
            // Fall back to name-based ordering via mtime=0 on failure
          }
          return { name, mtime };
        })
        .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name))
        .map((entry) => entry.name);

      for (const sessionFile of sessionFiles) {
        const fullPath = path.join(sessionsDir, sessionFile);
        const result = await readSessionTranscript(fullPath);
        if (!result) continue;
        if ("marker" in result && result.marker === OVERSIZE_SESSION) {
          const mb = (result.size / 1024 / 1024).toFixed(1);
          existingSessionTranscripts.push({
            path: `.agentpolicy/sessions/${sessionFile}`,
            content: `[Session transcript omitted — file size ${mb}MB exceeds the 5MB prompt-ingestion limit. Transcript is preserved on disk for audit; open the file directly if this history is needed.]`,
            truncated: true,
          });
          continue;
        }
        const rawContent = (result as FileContent).content;

        // Validate shape and re-serialize before feeding into the
        // discovery prompt. A user-tampered transcript with an
        // unexpected shape (extra top-level directives, array root,
        // etc.) gets replaced with a placeholder rather than being
        // trusted as LLM context. Message contents themselves still
        // flow through verbatim — they are the conversation.
        const clean = validateAndNormalizeTranscript(rawContent);
        if (clean === null) {
          existingSessionTranscripts.push({
            path: `.agentpolicy/sessions/${sessionFile}`,
            content: `[Session transcript omitted — malformed or unexpected shape. The file may have been edited outside aegis.]`,
            truncated: true,
          });
          continue;
        }

        existingSessionTranscripts.push({
          path: `.agentpolicy/sessions/${sessionFile}`,
          content: clean,
          truncated: false,
        });
      }
    } catch {
      // Can't read sessions
    }
  }

  // ── Tier pre-scan ────────────────────────────────────────────────
  // Cheap fs.stat-only enumeration decides how aggressively we read file
  // contents. Also produces extension tallies so we don't walk the tree
  // twice. Skipped on return visits — the tree wasn't read in full for
  // content on return anyway, and tier gating adds no value when the
  // policy files and transcripts already carry the context.
  // detectScanTier runs on every invocation, including return visits.
  // Return visits don't need the tier for file-read gating (they only
  // ever read HIGH_VALUE_FILES), but they DO benefit from the real
  // file-count and extension-tally data downstream: the briefing shows
  // real numbers instead of zeros, and the deployment_intent fallback
  // in extractPolicy inspects scan.fileCounts to decide whether a
  // return-visit project is substantial enough to govern.
  const tierResult = detectScanTier(projectRoot, isIgnored);
  const scanTier = tierResult.tier;
  const fileCounts = tierResult.fileCounts;

  // ── Discover and read project files ──────────────────────────────
  // Four branches:
  //   - Return visit: HIGH_VALUE_FILES only (policy + transcripts carry
  //     the rest). Tier ignored — the existing policy is authoritative.
  //   - Tiny tier: current full first-visit discovery. Everything gets
  //     read up to 10KB per file.
  //   - Normal tier: targeted reads. Stack-detection files + CI workflows
  //     + root README (first 200 lines). No recursive docs/, tests/,
  //     examples/, or markdown sprawl.
  //   - Massive tier: skip content reads entirely. Metadata-only briefing.
  //     The opener pivots straight to conversation.
  const fileContents: FileContent[] = [];
  const skippedSensitiveFiles: string[] = [];

  if (hasAuthoredPolicy) {
    // Return visit — only read high-value files for lightweight project
    // context alongside the policy files. Respect ignore rules: if a
    // user explicitly ignored README.md or package.json, we don't leak
    // it into the prompt even though it's on the high-value list.
    for (const hvFile of HIGH_VALUE_FILES) {
      if (isIgnored(hvFile)) continue;
      const fullPath = path.join(projectRoot, hvFile);
      if (fs.existsSync(fullPath)) {
        const content = await readFileSafe(fullPath);
        if (content && typeof content !== "symbol") {
          content.path = hvFile;
          fileContents.push(content);
        }
      }
    }
  } else if (scanTier === "massive") {
    // Massive tier — skip content reads. The opener acknowledges the
    // lack of file-level knowledge and pivots to conversation.
  } else if (scanTier === "normal") {
    // Normal tier — targeted: HIGH_VALUE_FILES + CI workflows + README
    // truncated to first 200 lines. No recursive content.
    const readTargets = new Set<string>();

    for (const hvFile of HIGH_VALUE_FILES) {
      if (isIgnored(hvFile)) continue;
      if (fs.existsSync(path.join(projectRoot, hvFile))) {
        readTargets.add(hvFile);
      }
    }

    for (const wf of findCIWorkflows(projectRoot)) {
      if (isIgnored(wf)) continue;
      readTargets.add(wf);
    }

    for (const target of readTargets) {
      if (isSensitiveFile(target)) {
        skippedSensitiveFiles.push(target);
        continue;
      }

      const fullPath = path.join(projectRoot, target);
      const content = await readFileSafe(fullPath);

      if (content === UNSUPPORTED_BINARY) {
        skippedSensitiveFiles.push(`${target} (binary — unsupported format)`);
      } else if (content && typeof content !== "symbol") {
        content.path = target;
        // Root README gets a 200-line cap on top of the 10KB cap —
        // whichever is tighter wins. Large READMEs are a major source
        // of context bloat in markdown-heavy repos that still qualify
        // as "normal" tier on file count alone.
        const isRootReadme = /^readme(\.md)?$/i.test(target);
        if (isRootReadme) {
          const lines = content.content.split("\n");
          if (lines.length > 200) {
            content.content =
              lines.slice(0, 200).join("\n") +
              "\n\n[... truncated at 200 lines ...]";
            content.truncated = true;
          }
        }
        fileContents.push(content);
      }
    }
  } else {
  // ── Tiny tier — full first-visit discovery ───────────────────────
  const highValueSet = new Set(HIGH_VALUE_FILES.map((f) => f.toLowerCase()));

  let allProjectFiles: string[] = [];
  try {
    allProjectFiles = glob.sync("**/*", {
      cwd: projectRoot,
      nodir: true,
      dot: true,
      ignore: NOISE_IGNORE_PATTERNS,
    });
  } catch {
    // Fall back to empty if glob fails
  }

  const priorityFiles: string[] = [];
  const discoveredFiles: string[] = [];

  for (const relativePath of allProjectFiles) {
    if (highValueSet.has(relativePath.toLowerCase())) {
      priorityFiles.push(relativePath);
    } else {
      discoveredFiles.push(relativePath);
    }
  }

  // Promote parseable documents at project root to priority list.
  // A DOCX/PDF at root is almost certainly intentional project docs.
  const parseableExtSet = new Set(Object.keys(PARSEABLE_EXTENSIONS));
  const prioritySet = new Set(priorityFiles.map((f) => f.toLowerCase()));

  const promotedFromDiscovered: string[] = [];
  const remainingDiscovered: string[] = [];

  for (const relativePath of discoveredFiles) {
    const ext = path.extname(relativePath).toLowerCase();
    const isRootLevel = !relativePath.includes(path.sep) && !relativePath.includes("/");
    if (isRootLevel && parseableExtSet.has(ext) && !prioritySet.has(relativePath.toLowerCase())) {
      promotedFromDiscovered.push(relativePath);
    } else {
      remainingDiscovered.push(relativePath);
    }
  }

  const allFilesToProcess = [...priorityFiles, ...promotedFromDiscovered, ...remainingDiscovered];

  for (const relativePath of allFilesToProcess) {
    const fullPath = path.join(projectRoot, relativePath);

    if (isSensitiveFile(relativePath)) {
      if (fs.existsSync(fullPath)) {
        skippedSensitiveFiles.push(relativePath);
      }
      continue;
    }

    if (isIgnored(relativePath)) {
      if (!SAFE_ENV_PATTERNS.some((p) => p.test(relativePath))) {
        if (fs.existsSync(fullPath)) {
          skippedSensitiveFiles.push(relativePath);
        }
        continue;
      }
    }

    const content = await readFileSafe(fullPath);

    if (content === UNSUPPORTED_BINARY) {
      skippedSensitiveFiles.push(
        `${relativePath} (binary — unsupported format)`
      );
    } else if (content && typeof content !== "symbol") {
      content.path = relativePath;
      fileContents.push(content);
    } else if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > MAX_FILE_SIZE_ABSOLUTE) {
          skippedSensitiveFiles.push(`${relativePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB — too large)`);
        }
      } catch {
        // Can't stat, move on
      }
    }
  }
  } // end tiny-tier discovery

  // ── Project metadata ─────────────────────────────────────────────
  const projectName = (pkg?.name as string) || path.basename(projectRoot);

  const projectDescription =
    (pkg?.description as string) || "";

  const scripts = (pkg?.scripts as Record<string, string>) || {};

  return {
    root: projectRoot,
    scanTier,
    scanFileCount: tierResult.fileCount,
    scanByteSize: tierResult.byteSize,
    projectName,
    projectDescription,
    languages,
    frameworks,
    packageManagers,
    infrastructure,
    topLevelDirs,
    directoryTree,
    configFiles,
    hasExistingPolicy,
    hasAuthoredPolicy,
    hasUsableBaseline,
    existingPolicyFiles,
    existingPolicyContents,
    policyMigrationFindings,
    existingSessionTranscripts,
    packageJson: pkg,
    scripts,
    fileCounts,
    fileContents,
    skippedSensitiveFiles,
  };
}

// ── Briefing Formatter ─────────────────────────────────────────────────

/**
 * Format scan results as a rich briefing for the LLM.
 * This is what Aegis reads before starting the conversation.
 * Not a raw dump — a distilled understanding of the project.
 */
export function formatScanBriefing(scan: ScanResult): string {
  const lines: string[] = [
    `PROJECT SCAN BRIEFING`,
    `====================`,
    `Project: ${scan.projectName}`,
  ];

  if (scan.projectDescription) {
    lines.push(`Description: ${scan.projectDescription}`);
  }

  // Scan-mode indicator — describes what was actually read into the
  // prompt so the model doesn't claim knowledge it lacks or believe
  // claims the briefing makes about itself. Three return-visit
  // subcases matter because hasExistingPolicy only says the directory
  // exists — a transcript-only .agentpolicy/ is fresh-project context,
  // while a directory with canonical authored files but no usable
  // baseline is a recovery case. hasUsableBaseline is the strongest
  // gate: true iff the full spec floor (constitution + governance +
  // ledger + at least one role) all loaded as non-empty parseable JSON.
  // Schema drift still counts as a loaded baseline and rides as
  // migration context.
  const transcriptCount = scan.existingSessionTranscripts?.length ?? 0;

  if (scan.hasUsableBaseline) {
    // Only name transcripts in the scope list if any were actually
    // loaded. The opener already checks transcriptCount > 0 before
    // mentioning them; the briefing now matches so the prompt doesn't
    // claim content in one section that another section silently omits.
    const parts = [".agentpolicy/ contents"];
    if (transcriptCount > 0) {
      parts.push(`${transcriptCount} prior session transcript(s)`);
    }
    parts.push("HIGH_VALUE_FILES");
    const scopeList =
      parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
    lines.push(
      `Scan mode: return visit — focused read of ${scopeList}. The rest of the repo is not part of this prompt's context unless you and the user discuss it.`
    );
  } else if (scan.hasAuthoredPolicy) {
    const transcriptNote =
      transcriptCount > 0
        ? ` ${transcriptCount} prior session transcript(s) did load.`
        : "";
    lines.push(
      `Scan mode: return visit, but no readable .agentpolicy/ content was loaded — the directory exists on disk but its files are empty, malformed, or unreadable.${transcriptNote} Treat as near-first-time for baseline context; do not claim knowledge of an existing policy you cannot see.`
    );
  } else if (scan.scanTier === "massive") {
    const mb = (scan.scanByteSize / 1024 / 1024).toFixed(1);
    lines.push(
      `Scan mode: massive tier (${scan.scanFileCount}+ files, ${mb}MB) — metadata only, no file contents read.`
    );
  } else if (scan.scanTier === "tiny") {
    lines.push(
      `Scan mode: tiny tier (${scan.scanFileCount} files) — full content scan.`
    );
  } else if (scan.scanTier === "normal") {
    // Normal-tier discovery reads HIGH_VALUE_FILES + CI workflows
    // + the root README (first 200 lines). Source code itself is
    // NOT read at this tier — only configs and docs. Disclosing
    // the mode in the briefing keeps the model from claiming
    // codebase-level familiarity it doesn't have.
    lines.push(
      `Scan mode: normal tier (${scan.scanFileCount} files) — targeted read of high-value config and documentation files (no source).`
    );
  }

  lines.push("");

  // ── Stack overview ───────────────────────────────────────────────
  if (scan.languages.length > 0) {
    lines.push(`Languages: ${scan.languages.join(", ")}`);
  } else {
    lines.push("Languages: (nothing detected — likely a new project)");
  }
  if (scan.frameworks.length > 0) {
    lines.push(`Frameworks: ${scan.frameworks.join(", ")}`);
  }
  if (scan.packageManagers.length > 0) {
    lines.push(`Package managers: ${scan.packageManagers.join(", ")}`);
  }
  if (scan.infrastructure.length > 0) {
    lines.push(`Infrastructure: ${scan.infrastructure.join(", ")}`);
  }

  // ── Scripts ──────────────────────────────────────────────────────
  if (Object.keys(scan.scripts).length > 0) {
    lines.push("");
    lines.push("Scripts:");
    for (const [name, cmd] of Object.entries(scan.scripts)) {
      lines.push(`  ${name}: ${cmd}`);
    }
  }

  // ── Project structure ────────────────────────────────────────────
  lines.push("");

  if (Object.keys(scan.directoryTree).length > 0) {
    lines.push("Project structure:");
    for (const [dir, children] of Object.entries(scan.directoryTree)) {
      if (children.length === 0) {
        lines.push(`  ${dir}/`);
      } else {
        lines.push(`  ${dir}/`);
        for (const child of children) {
          lines.push(`    ${child}`);
        }
      }
    }
  } else if (scan.topLevelDirs.length > 0) {
    lines.push(`Top-level directories: ${scan.topLevelDirs.join(", ")}`);
  }

  if (scan.configFiles.length > 0) {
    lines.push("");
    lines.push(`Config files: ${scan.configFiles.join(", ")}`);
  }

  const topExts = Object.entries(scan.fileCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  if (topExts.length > 0) {
    lines.push(`File distribution: ${topExts.map(([ext, n]) => `${ext}: ${n}`).join(", ")}`);
  }

  // ── File contents Aegis studied ──────────────────────────────────
  if (scan.fileContents.length > 0) {
    lines.push("");
    lines.push("== FILES YOU STUDIED ==");
    lines.push("");
    for (const file of scan.fileContents) {
      lines.push(`--- ${file.path} ${file.truncated ? "(truncated)" : ""} ---`);
      lines.push(file.content);
      lines.push("");
    }
  }

  // ── Existing policy ──────────────────────────────────────────────
  // Only render the full "EXISTING CONTENTS" section when the loaded
  // set actually constitutes a usable baseline. Schema-drifted JSON
  // still renders here because it is the starting point for a
  // user-approved migration; malformed or missing floor pieces get
  // the warning line instead.
  if (scan.hasUsableBaseline) {
    lines.push("");
    lines.push("== EXISTING .agentpolicy/ CONTENTS ==");
    lines.push("");
    for (const file of scan.existingPolicyContents) {
      lines.push(`--- ${file.path} ---`);
      lines.push(file.content);
      lines.push("");
    }

    if (scan.policyMigrationFindings.length > 0) {
      lines.push("== POLICY MIGRATION FINDINGS ==");
      lines.push("");
      for (const finding of scan.policyMigrationFindings) {
        lines.push(`- ${finding.location}: ${finding.summary}`);
        lines.push(`  Since: ${finding.since}`);
        lines.push(`  Guidance: ${finding.guidance}`);
      }
      lines.push("");
    }
  } else if (scan.hasAuthoredPolicy) {
    lines.push("");
    lines.push(
      `⚠ Existing .agentpolicy/ found but no usable baseline loaded. Files seen on disk: ${scan.existingPolicyFiles.join(", ") || "(none enumerated)"}`
    );
  }

  // ── Sensitive files Aegis noticed but didn't read ────────────────
  if (scan.skippedSensitiveFiles.length > 0) {
    lines.push("");
    lines.push("== FILES YOU NOTICED BUT DID NOT READ (potentially sensitive) ==");
    lines.push(scan.skippedSensitiveFiles.join(", "));
  }

  return lines.join("\n");
}
