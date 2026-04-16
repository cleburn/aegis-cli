import * as fs from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import ignoreLib from "ignore";
import mammoth from "mammoth";
import * as pdfParse from "pdf-parse";

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
  /** Existing .agentpolicy files if found */
  existingPolicyFiles: string[];
  /** Contents of existing .agentpolicy files */
  existingPolicyContents: FileContent[];
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
const MAX_FILE_SIZE_ABSOLUTE = 1024 * 1024; // 1MB

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
 */
export async function readFileSafe(
  filePath: string
): Promise<FileContent | null | typeof UNSUPPORTED_BINARY> {
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
          const truncated = extractedText.length > MAX_FILE_SIZE;
          const finalContent = truncated
            ? extractedText.slice(0, MAX_FILE_SIZE) +
              `\n\n[... truncated at 10KB — parsed from ${ext.slice(1).toUpperCase()} ...]`
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

    // Plaintext path — unchanged
    const truncated = stat.size > MAX_FILE_SIZE;
    const content = fs.readFileSync(filePath, "utf-8");
    const finalContent = truncated
      ? content.slice(0, MAX_FILE_SIZE) + "\n\n[... truncated at 10KB ...]"
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
 * Check if a relative file path matches sensitive patterns.
 */
export function isSensitiveFile(relativePath: string): boolean {
  // Safe .env variants are explicitly allowed
  const basename = path.basename(relativePath);
  if (SAFE_ENV_PATTERNS.some((p) => p.test(basename))) return false;

  // Check against sensitive patterns (test both full relative path and basename)
  return SENSITIVE_FILE_PATTERNS.some(
    (p) => p.test(relativePath) || p.test(basename)
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
  let existingPolicyFiles: string[] = [];
  const existingPolicyContents: FileContent[] = [];

  if (hasExistingPolicy) {
    try {
      existingPolicyFiles = glob.sync("**/*.json", { cwd: policyDir });
      // Read every policy file — Aegis needs to know what's already established
      for (const policyFile of existingPolicyFiles) {
        const fullPath = path.join(policyDir, policyFile);
        const content = await readFileSafe(fullPath);
        if (content && typeof content !== "symbol") {
          content.path = `.agentpolicy/${policyFile}`;
          existingPolicyContents.push(content);
        }
      }
    } catch {
      // Can't read
    }
  }

  // ── Session transcripts ──────────────────────────────────────────
  const existingSessionTranscripts: FileContent[] = [];
  const sessionsDir = path.join(policyDir, "sessions");
  if (hasExistingPolicy && fs.existsSync(sessionsDir)) {
    try {
      const sessionFiles = glob.sync("*.json", { cwd: sessionsDir }).sort();
      for (const sessionFile of sessionFiles) {
        const fullPath = path.join(sessionsDir, sessionFile);
        const content = await readFileSafe(fullPath);
        if (content && typeof content !== "symbol") {
          content.path = `.agentpolicy/sessions/${sessionFile}`;
          existingSessionTranscripts.push(content);
        }
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
  const tierResult = hasExistingPolicy
    ? { tier: "normal" as ScanTier, fileCount: 0, byteSize: 0, fileCounts: {} as Record<string, number> }
    : detectScanTier(projectRoot, isIgnored);
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

  if (hasExistingPolicy) {
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

  // Pick up high-value dotfiles that glob may have missed at root
  for (const hvFile of HIGH_VALUE_FILES) {
    const fullPath = path.join(projectRoot, hvFile);
    if (fs.existsSync(fullPath) && !priorityFiles.includes(hvFile)) {
      priorityFiles.push(hvFile);
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
    existingPolicyFiles,
    existingPolicyContents,
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

  // Tier indicator — flags when the briefing is shallow so the model
  // doesn't pretend to have read files it didn't.
  if (scan.scanTier === "massive") {
    const mb = (scan.scanByteSize / 1024 / 1024).toFixed(1);
    lines.push(
      `Scan mode: massive tier (${scan.scanFileCount}+ files, ${mb}MB) — metadata only, no file contents read.`
    );
  } else if (scan.scanTier === "tiny") {
    lines.push(
      `Scan mode: tiny tier (${scan.scanFileCount} files) — full content scan.`
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
  if (scan.hasExistingPolicy && scan.existingPolicyContents.length > 0) {
    lines.push("");
    lines.push("== EXISTING .agentpolicy/ CONTENTS ==");
    lines.push("");
    for (const file of scan.existingPolicyContents) {
      lines.push(`--- ${file.path} ---`);
      lines.push(file.content);
      lines.push("");
    }
  } else if (scan.hasExistingPolicy) {
    lines.push("");
    lines.push(`⚠ Existing .agentpolicy/ found with: ${scan.existingPolicyFiles.join(", ")}`);
  }

  // ── Sensitive files Aegis noticed but didn't read ────────────────
  if (scan.skippedSensitiveFiles.length > 0) {
    lines.push("");
    lines.push("== FILES YOU NOTICED BUT DID NOT READ (potentially sensitive) ==");
    lines.push(scan.skippedSensitiveFiles.join(", "));
  }

  return lines.join("\n");
}