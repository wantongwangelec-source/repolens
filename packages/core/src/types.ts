/**
 * RepoLens domain types.
 *
 * This document is the contract for the entire project and must maintain **zero runtime dependencies**:
 * The frontend directly imports through `import type { ... } from "@repolens/core/types"`,
 * Once Node-specific modules are introduced here, the front-end build will be contaminated.
 */

// ---------------------------------------------------------------------------
// Basic Enumeration
// ---------------------------------------------------------------------------

export type BuiltinLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "vue"
  | "svelte"
  | "astro"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "powershell"
  | "swift"
  | "dart"
  | "lua"
  | "scala"
  | "elixir"
  | "erlang"
  | "haskell"
  | "clojure"
  | "objective-c"
  | "groovy"
  | "perl"
  | "r"
  | "zig"
  | "nim"
  | "solidity"
  | "sql"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "graphql"
  | "protobuf"
  | "terraform"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "other";

/** Third-party registered languages use namespaces to avoid name conflicts with future built-in languages. */
export type Language = BuiltinLanguage | `custom:${string}`;

/** Languages involved in AST construction (having grammar and extractors, or capable of extracting embedded scripts). */
export type AnalyzableLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "vue"
  | "svelte"
  | "astro"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "powershell"
  | "shell"
  | "css"
  | `custom:${string}`;

/**
 * File roles. Except for `source`, all others are folded by default from the graph and statistics,
 * According to docs/INTERACTION.md, "noise does not participate by default."
 */
export type FileRole = "source" | "test" | "config" | "generated" | "types" | "docs" | "asset" | "vendor";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "trait"
  | "impl"
  | "constant"
  | "variable"
  | "module"
  | "property";

export type EdgeType =
  | "contains"
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "embeds"
  | "instantiates"
  | "references"
  /** Frontend requests match backend routes by URL: no import, inferred from literals, always likely */
  | "http";

/**
 * The confidence of calling/referencing edges. For semantics, see docs/ARCHITECTURE.md#calling-edge-confidence-model.
 * The order is meaningful: exact > likely > ambiguous > external > unresolved.
 */
export type Confidence = "exact" | "likely" | "ambiguous" | "external" | "unresolved";

export const CONFIDENCE_ORDER: readonly Confidence[] = [
  "exact",
  "likely",
  "ambiguous",
  "external",
  "unresolved",
];

export type PackageManager = "pnpm" | "npm" | "yarn" | "go" | "cargo" | "python" | "none";

export type ImportKind = "static" | "dynamic" | "require" | "side-effect" | "re-export" | "module-decl";

/** render: JSX element `<Comp/>`, semantically it is a call to the component function */
export type CallKind = "call" | "method" | "new" | "macro" | "render";

// ---------------------------------------------------------------------------
// Extractor Contract — Each language's extractor must produce the following structures
// ---------------------------------------------------------------------------

export interface ParsedParam {
  name: string;
  type?: string | undefined;
  defaultValue?: string | undefined;
  optional: boolean;
  variadic: boolean;
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** Name of the class / struct / trait; top-level symbol is undefined */
  container?: string | undefined;
  exported: boolean;
  /** Original signature, used for direct display on the details panel */
  signature?: string | undefined;
  params?: ParsedParam[] | undefined;
  returnType?: string | undefined;
  /** Adjacent documentation comments (JSDoc / docstring / `///`) */
  doc?: string | undefined;
  /** 1-based, closed interval */
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  /** Approximate cyclomatic complexity, minimum is 1 */
  complexity: number;
  isAsync?: boolean | undefined;
  isStatic?: boolean | undefined;
  /** Go method receiver type, such as `*Server` */
  receiverType?: string | undefined;
  /** Structural fingerprint: The shape of the AST after ignoring names and literals, used to identify duplicate implementations */
  shape?: string | null | undefined;
  /**
   * Test cases or test case groups registered by the testing framework: the callback symbols composed by `it("…", () => …)`, or in the test file
   * Test functions named according to the convention. Only valid in test files, and will be verified again according to the file's role when entering the repository.
   */
  testKind?: TestKind | undefined;
  /** Only the signature without a function body: method declarations in interfaces and type literals, overload declarations, trait method signatures */
  declarationOnly?: boolean | undefined;
}

export type TestKind = "case" | "suite";

/**
 * The control structure where the call point is located is arranged from the outside to the inside of the function body. According to this, read through and arrange the steps by branches and loops.
 * Callback grouping allows talent to see which calls only occur under certain conditions.
 */
export interface ControlBlock {
  /** Starting byte of the block: the same if recognizes it as the same block in different steps based on this */
  b: number;
  k: ControlBlockKind;
  /** Condition, case value, loop head, catch parameter or the name of the call to which the callback belongs, truncated original source code */
  t?: string | undefined;
  /** Block starting line, 1-based */
  l: number;
  /** if branches end with return / throw / break / continue: guard branches, the main path will not enter */
  x?: 1 | undefined;
}

export type ControlBlockKind = "if" | "else" | "case" | "loop" | "try" | "catch" | "finally" | "callback" | "defer";

export interface ParsedImportSpecifier {
  /** The name in the source module; `*` indicates a namespace import or wildcard import */
  imported: string;
  /** Local Binding Name */
  local: string;
  isDefault?: boolean | undefined;
  isNamespace?: boolean | undefined;
}

export interface ParsedImport {
  /** Raw specifier text, such as `./foo`, `github.com/x/y`, `crate::a::b` */
  source: string;
  kind: ImportKind;
  specifiers: ParsedImportSpecifier[];
  line: number;
  isTypeOnly?: boolean | undefined;
}

export interface ParsedExport {
  name: string;
  kind: "named" | "default" | "star" | "star-as";
  /** Source specifier of re-export */
  source?: string | undefined;
  /** Local declaration names behind the export names: `export default foo`, `export { foo as bar }` */
  local?: string | undefined;
  line: number;
}

export interface ParsedCall {
  /** Name of the containing symbol; null indicates top-level module code */
  callerName: string | null;
  callerContainer?: string | undefined;
  /** The last segment of the name being referenced, such as `c` in `a.b.c()` */
  callee: string;
  /** Receiver text, such as `this` / `self` / `obj` / Go's package alias */
  receiver?: string | undefined;
  /**
   * Receiver type hints, link stage parsing: `T:Type` comes from annotations, `new`, `as`;
   * `R:path` indicates that the receiver is the return value of that function, and `A:path` is the awaited return value;
   * `M:clue` is an attribute chain `c.req`, the clue belongs to the root variable; `C:method|clue` is an untyped callback parameter,
   * Passed in from the method of the object indicated by the clue. `P:` is a parameter whose type cannot be determined, `D: path` is destructured from the return value of that call.
   * These two are only for explaining the walk-through interface. Bare calls record the clue of the name being called itself.
   */
  receiverType?: string | undefined;
  /** Complete point split path, such as '["a","b","c"]' */
  calleePath?: string[] | undefined;
  line: number;
  /** The byte offset where the invocation expression ends; nested invocations on the same line use it to determine the order of evaluation */
  endByte: number;
  /** The position of the referenced name itself (listed as a UTF-16 offset), single-step reading is highlighted accordingly */
  nameLine: number;
  nameColumn: number;
  argCount: number;
  /** The source code text of the first few actual parameters; used for entry recognition and step-by-step demonstration of actual parameters, without evaluation. */
  argumentTexts?: string[] | undefined;
  kind: CallKind;
  /** Starting byte of the call expression; the control structure should be searched from here upwards */
  startByte?: number | undefined;
  /** The byte range of the owning function; no top-level call */
  ownerStartByte?: number | undefined;
  ownerEndByte?: number | undefined;
  /** Control structures in the function body proceed from the outside to the inside; calls written directly in the function body are empty */
  blocks?: ControlBlock[] | undefined;
  /** The entire statement is just this call, and the return value is not used (`log(x);`, `await save(x);`) */
  discarded?: boolean | undefined;
}

/** In the framework registration syntax, entry hints that can be directly proven by the AST. */
export interface ParsedEntryHint {
  kind: "http" | "cli";
  framework: string;
  /** The name of the registered handler; empty if an anonymous closure cannot be statically named. */
  handlerName?: string | undefined;
  line: number;
  label: string;
  method?: string | undefined;
  route?: string | undefined;
  confidence: "exact" | "likely";
  evidence: string;
}

export interface ParsedTypeRelation {
  subject: string;
  subjectKind: SymbolKind;
  relation: "extends" | "implements" | "embeds";
  target: string;
  /** Restricted paths, such as `pkg.Type` / `crate::Trait` */
  targetPath?: string[] | undefined;
  line: number;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  calls: ParsedCall[];
  entryHints?: ParsedEntryHint[] | undefined;
  typeRelations: ParsedTypeRelation[];
  /** Rust `mod foo;` declaration, used for module tree resolution */
  moduleDecls?: string[] | undefined;
  /** Analyze whether a syntax error is encountered (does not block, but will be recorded) */
  hasError: boolean;
}

// ---------------------------------------------------------------------------
// Discovery Phase
// ---------------------------------------------------------------------------

export interface DiscoveredPackage {
  /** Package name, such as `@repolens/core`, `github.com/x/y/pkg`, crate name */
  name: string;
  /** Repository relative path (POSIX, root is `.`) */
  dir: string;
  manager: PackageManager;
  /** Entry candidates resolved from exports/main/module/types in package.json */
  entryPoints: string[];
  version?: string | undefined;
}

export interface DiscoveredFile {
  /** Repository relative path (POSIX) */
  path: string;
  language: Language;
  role: FileRole;
  bytes: number;
  /** Content hash, basis for determining incremental scanning */
  hash: string;
  packageDir: string | null;
}

// ---------------------------------------------------------------------------
// Module Resolver Contract
// ---------------------------------------------------------------------------

export interface ResolveContext {
  /** Absolute root path of the repository */
  root: string;
  /** File that initiates import (repository relative POSIX path) */
  fromFile: string;
  /** The collection of all file paths in the warehouse, used for existence determination */
  hasFile: (repoRelPath: string) => boolean;
  /** Does the directory exist */
  hasDir: (repoRelPath: string) => boolean;
  /** Discovered packages */
  packages: readonly DiscoveredPackage[];
}

export type ResolveOutcome =
  /** Parse files in the warehouse */
  | { status: "internal"; target: string }
  /** Parse to the directory within the repository (Go package-level import) */
  | { status: "internal-dir"; target: string }
  /** Third-party dependencies or language built-ins */
  | { status: "external"; name: string }
  /** Clearly cannot be parsed and needs to be exposed on the UI */
  | { status: "unresolved"; reason: string };

export interface ModuleResolver {
  languages: readonly AnalyzableLanguage[];
  resolve: (specifier: string, ctx: ResolveContext) => ResolveOutcome;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface LlmConfig {
  /** OpenAI-compatible base URL, such as `https://api.openai.com/v1` */
  baseUrl: string;
  model: string;
  /** Files/functions can be generated on demand with a faster model; null means to continue using the model */
  interactiveModel: string | null;
  /** Environment variable name, do not store the key directly */
  apiKeyEnv: string;
  maxConcurrency: number;
  temperature: number;
  /** Models that support this OpenAI extension field are available; it can be set to null if not supported. */
  reasoningEffort: "low" | "medium" | "high" | null;
  /** What is the maximum number of tokens returned in a single generation? */
  maxOutputTokens: number;
  /** Single HTTP request timeout; the local model also cannot hang scanning indefinitely */
  requestTimeoutMs: number;
  /** 429 / 5xx / Number of retries for network errors */
  maxRetries: number;
  /** During the scanning period, how many package/directory digests does a request generate in bulk? */
  scanBatchSize: number;
  /** How many times can the model be called at most during the scanning period to prevent accidentally exceeding the budget for large repositories */
  scanMaxCalls: number;
  /** Language of the generated content */
  outputLanguage: "zh" | "en";
  enabled: boolean;
  /** When following up, let the model read files, search code, and check git history as needed; automatically fall back when the model or gateway does not support function calls. */
  chatTools: boolean;
  /** When following up, the model is allowed to access public web pages; it can only be enabled in the user-level settings. */
  webFetch: boolean;
}

export interface RepolensConfig {
  /** Extra ignored glob */
  exclude: string[];
  /** Glob patterns that are forcibly included have a higher priority than exclude */
  include: string[];
  /** Path glob → file roles; explicitly override built-in heuristic rules. */
  roleOverrides: Record<string, FileRole>;
  /** Files exceeding this byte size will be skipped for parsing */
  maxFileBytes: number;
  /** The maximum number of nodes in the default view; exceed this number and they will be aggregated */
  maxNodesPerView: number;
  /** Default file role participating in the graph */
  defaultRoles: FileRole[];
  /** Dependency ban declared by the warehouse, violated import goes through inspection */
  rules: ArchitectureRule[];
  /** Confirmed layering, from top to bottom; lower layers depending on upper layers are considered inverted layering */
  layers: ConfirmedLayer[];
  /** Which new issues in `repolens check --baseline` caused the check to fail */
  ratchet: RatchetConfig;
  /** Reading git history calculates change hotspots and collaborative changes; when the repository is very large or you don't want to read history, you can turn it off. */
  history: boolean;
  llm: LlmConfig;
}

/**
 * The confirmed first layer. The members are graph node IDs (`pkg:name` / `dir:path`), corresponding one-to-one with the nodes on the interface.
 * AI is only responsible for making suggestions; it is only brought into the agreed-upon hierarchy for deterministic inversion checks.
 */
export interface ConfirmedLayer {
  name: string;
  description: string | null;
  members: string[];
}

/** Ratchet: Several Types of Problems That Should Not Worsen Relative to the Baseline */
export type RatchetKind = "cycle" | "violation" | "unapproved" | "layering" | "bypass" | "duplicate" | "oversized";

export interface RatchetConfig {
  /** Adding is a failure */
  fail: RatchetKind[];
  /** Add only prompt */
  warn: RatchetKind[];
}

/**
 * Dependency lock: approved inter-module dependencies. It's the same principle as package-lock—newly appearing internal dependencies
 * It should be treated as a change that requires review, not something that quietly grows.
 */
export interface ArchitectureLock {
  version: 1;
  /** Is it locking between packages (monorepo) or between top-level module directories? */
  level: "package" | "directory";
  /** When level is directory, those directories are treated as modules */
  modules: string[];
  dependencies: LockedDependency[];
}

export interface LockedDependency {
  /** Package name or directory path */
  from: string;
  to: string;
  type: "imports" | "http";
}

/**
 * A dependency ban: source files in `from` are not allowed to import the targets specified in `disallow`.
 * The target can be either a path glob within the repository or an external package name (`electron`, `node:fs`, `@nestjs/*`).
 */
export interface ArchitectureRule {
  /** Abbreviation in the physical examination title; default is 'from ↛ disallow' */
  name: string | null;
  from: string[];
  disallow: string[];
  /** Exceptions that hit 'disallow' but are still allowed */
  allow: string[];
  /** Pure type imports are not considered a violation by default: sharing DTO types does not constitute runtime coupling */
  includeTypeOnly: boolean;
  severity: FindingSeverity;
  /** Why is there this rule, displayed in the medical examination details? */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// Scan Results Statistics
// ---------------------------------------------------------------------------

/** The connection where the frontend request infers the backend route based on the URL */
export interface HttpLinkStats {
  /** The number of backend routes registered in the code; no matching is done when it is 0 */
  routes: number;
  /** The connected 'Caller → Route' pair, with multiple meanings */
  linked: number;
  ambiguous: number;
}

export interface ScanStats {
  durationMs: number;
  filesDiscovered: number;
  filesParsed: number;
  filesReused: number;
  filesDeleted: number;
  symbols: number;
  imports: number;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
  calls: number;
  callsByConfidence: Record<Confidence, number>;
  /** The stats written into the index in the old version do not have this item */
  http?: HttpLinkStats | undefined;
  parseErrors: number;
  packages: number;
  loc: number;
  /** Only count the lines of source code */
  sourceLoc?: number | undefined;
  byLanguage: Record<string, { files: number; loc: number }>;
  /** Number of test cases, and the number of source code functions covered by at least one test case */
  tests?: { cases: number; covered: number; functions: number } | undefined;
  /** Git history that has been read; not in git or not available when turned off */
  history?: { commits: number; files: number; aiCommits: number } | undefined;
  /** M3; even when LLM is unavailable, it still returns status, and structural scanning never fails because of this */
  llm?: LlmRunStats | undefined;
}

export interface LlmUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmRunStats extends LlmUsage {
  enabled: boolean;
  available: boolean;
  model: string;
  generated: number;
  cacheHits: number;
  failures: number;
  durationMs: number;
  reason?: string | undefined;
}

// ---------------------------------------------------------------------------
// API Transfer Object — The data shape solely depended on by the front end
// ---------------------------------------------------------------------------

export type GraphNodeKind = "package" | "directory" | "file" | "symbol" | "external" | "aggregate";

export interface NodeMetrics {
  loc: number;
  files: number;
  symbols: number;
  complexity: number;
  inDegree: number;
  outDegree: number;
}

/**
 * - duplicate / cycle / oversized: the smell of the structure itself
 * - violation / unapproved / layering: Violated the written agreement (dependency rules, dependency locks, confirmed layering)
 * - bypass: bypass the entry point of another package and directly import its internal files
 * - coupling: files that always change together in git history but have no dependency in the code
 * - stale-doc: The path referenced in the document no longer exists in the repository
 */
export type FindingKind =
  | "duplicate" | "cycle" | "violation" | "oversized"
  | "unapproved" | "layering" | "bypass" | "coupling" | "stale-doc";
export const FINDING_KINDS: readonly FindingKind[] = [
  "duplicate", "cycle", "violation", "oversized", "unapproved", "layering", "bypass", "coupling", "stale-doc",
];
export type FindingSeverity = "high" | "medium" | "low";

export interface FindingDto {
  groupKey: string;
  kind: FindingKind;
  severity: FindingSeverity;
  scopeKind: "package" | "directory" | "file" | "symbol";
  /** Graph node id, can be directly jumped to on the interface */
  scopeKey: string;
  path: string;
  title: string;
  detail: string;
  /** IDs of other nodes in the same group, can be lit together */
  related: string[];
  /** This group involves several nodes */
  members: number;
  /** The number of commits in the file in the past 90 days; within the same severity, the ones changed more frequently are ranked higher, those are the ones that should be looked at first */
  recentCommits?: number;
}

export interface FindingSummaryDto {
  total: number;
  high: number;
  byKind: Record<string, number>;
}

export interface FindingQuery {
  kind?: FindingKind | undefined;
  /** Limited to a certain graph node: `pkg:` / `dir:` takes the subtree, `file:` includes symbols in the file, `sym:` only takes itself */
  scope?: string | undefined;
  limit?: number | undefined;
}

/** Health check badge attached to the graph node */
export interface NodeFindings {
  count: number;
  high: number;
}

export interface GraphNodeDto {
  /** In the form of `pkg:core` / `dir:src/db` / `file:42` / `sym:1337` / `external` / `agg:...` */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** The relative path of the warehouse, with the symbolic node being the path of the file it is in */
  path?: string | null;
  language?: Language | null;
  role?: FileRole | null;
  symbolKind?: SymbolKind | null;
  metrics: NodeMetrics;
  /** Number of drillable child nodes; 0 indicates a leaf */
  childCount: number;
  expandable: boolean;
  /** The IDs of the real nodes folded by the aggregation node */
  aggregatedIds?: string[] | null;
  /** Call the central node of the graph, the starting point needs to be highlighted on the interface */
  focus?: boolean | null;
  /** Medical examination conclusion count, including sub-items; this field is not included when there are no issues */
  findings?: NodeFindings | null;
  /** M3: Architecture Layer Identified by LLM */
  layer?: string | null;
  /** M3: A one-sentence summary generated by LLM */
  summary?: string | null;
}

export interface GraphEdgeDto {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  confidence: Confidence;
  /** Normalized intensity, used for edge width */
  weight: number;
  /** How many underlying edges are aggregated */
  count: number;
  /** Number of candidates when ambiguous */
  candidates?: number | null;
}

export interface GraphDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  /** Total number of aggregated nodes, used for the 'Other N items' prompt */
  truncated: number;
}

export interface LanguageBreakdown {
  language: Language;
  files: number;
  loc: number;
  share: number;
}

/**
 * Index the current total amount.
 *
 * It must be separated from ScanStats: ScanStats describes 'how much was done in the most recent scan.'
 * After one incremental scan, its filesParsed is 1, and imports are single-digit. Treat it as
 * Warehouse scale display, the interface will indicate that this warehouse only has 4 imports.
 */
export interface IndexTotals {
  files: number;
  /** All text lines that have been indexed, including tests, documentation, and configurations */
  loc: number;
  /** Only count the source code involved in the analysis; 'how big is this repository' refers to it */
  sourceFiles: number;
  sourceLoc: number;
  symbols: number;
  calls: number;
  imports: number;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
  packages: number;
}

/** Incremental information from the most recent scan, used for 'what was scanned last time' rather than 'how big the repository is' */
export interface LastScanDto {
  durationMs: number;
  filesParsed: number;
  filesReused: number;
  filesDeleted: number;
  parseErrors: number;
}

export interface OverviewDto {
  repoName: string;
  repoRoot: string;
  scannedAt: string;
  totals: IndexTotals;
  lastScan: LastScanDto;
  languages: LanguageBreakdown[];
  packages: Array<{
    id: string;
    name: string;
    dir: string;
    manager: PackageManager;
    loc: number;
    files: number;
  }>;
  /** M3 */
  summary?: string | null;
  /** When the warehouse overview is missing, the specific reason from the last scan record. */
  summaryUnavailableReason?: string | null;
  layers?: Array<{ name: string; description: string; nodeIds: string[] }> | null;
  /** Layers come from confirmed conventions (.repolens.json), not AI suggestions */
  layersConfirmed?: boolean;
  /** Overview of dependency locks; null when there is no lock file */
  lock?: { level: ArchitectureLock["level"]; dependencies: number } | null;
  /** Overview of the git history read */
  history?: { commits: number; aiCommits: number } | null;
  llm?: LlmStatusDto | null;
}

export interface LlmStatusDto {
  enabled: boolean;
  available: boolean;
  model: string;
  interactiveModel?: string | null;
  reason?: string | null;
  usage: LlmUsage;
}

// ---------------------------------------------------------------------------
// Warehouse inventory
// ---------------------------------------------------------------------------

/**
 * The two categories other than `ok` are 'in the list, but can't be used now': the index was deleted, or the repository.
 * The entire thing was removed. The interface should be able to gray them out and explain the reason, instead of letting people click in and run into an error.
 */
export type RepoStatus = "ok" | "index-missing" | "root-missing";

export interface RegisteredRepo {
  /** Short hash of an absolute path, URL-safe and fixed-length */
  id: string;
  root: string;
  name: string;
  /** ISO timestamp, used for sorting and elimination */
  lastOpenedAt: string;
}

export interface RepoEntry extends RegisteredRepo {
  status: RepoStatus;
  /** Current Git branch; detached HEAD is shown as detached@short commit, and non-Git repository is null. */
  branch: string | null;
}

export interface ReposDto {
  /** The repository specified at startup, default requests fall to it; if not specified on the desktop, it is null */
  current: string | null;
  repos: RepoEntry[];
}

// ---------------------------------------------------------------------------
// Warehouse scanning task
// ---------------------------------------------------------------------------

/** Scan pipeline stages; CLI, server-side tasks, and front-end progress indicators share the same set of values. */
export type ScanPhase =
  | "discover"
  | "parse"
  | "resolve"
  | "link"
  | "rollup"
  | "enrich"
  | "index";

export type RepoScanStatus = "running" | "completed" | "failed";

/** A snapshot of scan tasks on the web that can be polled. The range of progress is 0..1. */
export interface RepoScanTaskDto {
  id: string;
  root: string;
  name: string;
  status: RepoScanStatus;
  phase: ScanPhase | null;
  done: number;
  total: number;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  repo: RepoEntry | null;
}

export interface PickRepoResultDto {
  cancelled: boolean;
  task?: RepoScanTaskDto;
}

export interface TreeNodeDto {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  language?: Language | null;
  role?: FileRole | null;
  loc: number;
  files: number;
  symbols: number;
  complexity: number;
  /** Relative heat compared to the maximum of the same level 0-1, for thermal coloring */
  heat: number;
  hasChildren: boolean;
  children?: TreeNodeDto[] | null;
  /**
   * Only the structure tree listed by disk has: analyzed participated in analysis; noise went into the index but is not on the main graph by role
   * (Testing, configuration, documentation, etc., the role of the file is shown in role); excluded means it was not indexed, the reason can be found in excludedBy.
   */
  status?: "analyzed" | "noise" | "excluded";
  excludedBy?: ExclusionReason | null;
}

/** The reason why a file or directory is not indexed, the judgment rules are consistent with the traversal during scanning */
export type ExclusionReason =
  /** Dependency and build directories that are commonly skipped, such as node_modules, .venv, and target */
  | "builtin"
  /** .gitignore, .repolensignore, or excludes in the configuration */
  | "ignored"
  | "vendor"
  /** Exceeds configured maxFileBytes */
  | "too-large"
  /** Do not follow symbolic links to avoid loops or pointing outside the repository */
  | "symlink"
  /** It only appeared after the last scan */
  | "unscanned";

export interface SymbolSummaryDto {
  id: string;
  name: string;
  kind: SymbolKind;
  container?: string | null;
  exported: boolean;
  signature?: string | null;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  callerCount: number;
  calleeCount: number;
}

export interface FileDetailDto {
  id: string;
  path: string;
  language: Language;
  role: FileRole;
  loc: number;
  bytes: number;
  packageName?: string | null;
  parseError?: string | null;
  symbols: SymbolSummaryDto[];
  imports: Array<{
    source: string;
    kind: ImportKind;
    confidence: Confidence;
    targetPath?: string | null;
    specifiers: string[];
    line: number;
  }>;
  importedBy: Array<{ id: string; path: string }>;
  summary?: string | null;
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
  /** Which node in the code corresponds to the names mentioned in the abstract */
  grounding?: GroundingDto[] | null;
  /** The extent to which the functions in the file are covered by tests */
  tests?: { functions: number; covered: number; cases: number } | null;
  history?: FileHistoryDto | null;
}

/**
 * A name appearing in AI text (an identifier or path enclosed in backticks) matched something.
 * You can click when it matches; those that never appear in the source code or the index are marked—most likely made up by the model.
 */
export interface GroundingDto {
  text: string;
  nodeId: string | null;
  missing: boolean;
}

/** The git history of a file (default is the past 12 months) */
export interface FileHistoryDto {
  commits: number;
  /** Last 90 days */
  recentCommits: number;
  lastChangedAt: string | null;
  authors: number;
  /** Indicate in the submitted information if AI was involved (Co-authored-by: Claude / Cursor / Copilot, etc.) */
  aiCommits: number;
  /** Files that are often modified together with it; linked being false indicates that the two do not have a direct dependency in the code. */
  coChanged: Array<{ id: string | null; path: string; together: number; linked: boolean }>;
}

/**
 * A step in the pseudocode. `lines` is the source code closed interval marked by the model, already sorted by its corresponding symbol or file.
 * The range check has been done; it is still AI inference, not a fact provided by the parser. The old cache does not have this.
 * The correspondence relationship, at this time `lines` is empty.
 */
export interface PseudocodeStepDto {
  text: string;
  lines?: [number, number] | null;
  children: PseudocodeStepDto[];
}

export interface ParamDto {
  name: string;
  type?: string | null;
  defaultValue?: string | null;
  optional: boolean;
  variadic: boolean;
}

export interface RelationDto {
  id: string;
  name: string;
  kind: SymbolKind;
  /** The file containing the other party's symbol */
  path: string;
  /** The line where the call occurs, in the caller's file */
  line: number;
  /** The definition line of the other party's symbol is in the path */
  definedAt: number;
  confidence: Confidence;
  /** candidates with the same name when ambiguous */
  candidates?: Array<{ id: string; path: string }> | null;
  /** The relationship comes from JSX `<Comp/>` rather than a function call */
  rendered?: boolean;
  /** The relationship comes from the backend route matched by the frontend request according to the URL, with no import evidence. */
  http?: boolean;
}

export interface SymbolDetailDto {
  id: string;
  name: string;
  kind: SymbolKind;
  container?: string | null;
  filePath: string;
  fileId: string;
  language: Language;
  exported: boolean;
  signature?: string | null;
  params: ParamDto[];
  returnType?: string | null;
  doc?: string | null;
  startLine: number;
  endLine: number;
  complexity: number;
  isAsync?: boolean | null;
  receiverType?: string | null;
  callers: RelationDto[];
  callees: RelationDto[];
  /** Calls pointing outside the repository, aggregated display */
  externalCallees: Array<{ name: string; count: number }>;
  typeRelations: Array<{ relation: "extends" | "implements" | "embeds"; target: string; targetId?: string | null }>;
  /** M3, generate on demand */
  summary?: string | null;
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
  grounding?: GroundingDto[] | null;
  /** Which test cases can reach it through calls; the titles of the cases written by people are the behaviors it should have. */
  tests?: TestCoverageDto | null;
  /** Test case itself: Which test case group is it in? */
  testKind?: TestKind | null;
}

export interface TestCoverageDto {
  /** The number of test cases it can reach */
  total: number;
  /** The number of use cases that directly call it */
  direct: number;
  /** The several use cases closest to it */
  nearest: TestRefDto[];
}

export interface TestRefDto {
  id: string;
  /** Use case title or test function name */
  name: string;
  /** Outer test suite, the title of `describe`, combined with › across multiple layers */
  suite: string | null;
  path: string;
  line: number;
  /** The number of call layers from the use case to the target, 1 indicates a direct call */
  depth: number;
}

/** Behavior specification for a certain scope (file, directory, package): test cases that reach here should be organized according to test files and test case groups */
export interface SpecDto {
  cases: number;
  files: Array<{
    id: string;
    path: string;
    suites: Array<{ name: string | null; cases: Array<SpecCaseDto> }>;
  }>;
}

export interface SpecCaseDto {
  id: string;
  name: string;
  line: number;
  /** How many layers does the function closest to the range have? */
  depth: number;
  /** The function names within the range it reaches, at most how many */
  targets: string[];
}

/** Unified return shape of the file/symbol on-demand generation interface. */
export interface SemanticResultDto {
  summary: string | null;
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
  /** If there is no content for the model to understand, skip it directly and do not initiate an LLM request. */
  skipReason?: "empty-file" | null;
  generated: boolean;
  cacheHit: boolean;
  model: string;
  usage: LlmUsage;
}

export interface SearchHitDto {
  id: string;
  kind: "file" | "symbol" | "package" | "directory";
  label: string;
  detail: string;
  score: number;
}

export interface SourceSliceDto {
  path: string;
  language: Language;
  startLine: number;
  endLine: number;
  code: string;
}

/** The explanation written by the author in the package/directory, the original text is rendered by the interface */
export interface ReadmeDto {
  /** README Your Own File Node */
  fileId: string;
  path: string;
  /** rst, txt, and files without extensions are displayed as plain text and are not parsed as markdown */
  format: "markdown" | "text";
  content: string;
  /** Exceeded the reading limit, only provided the first paragraph */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Boundary Contracts and Module Business Cards
// ---------------------------------------------------------------------------

/**
 * What exactly constitutes a dependency between two nodes? The edge on the architecture diagram is just a line and a number.
 * To judge whether 'this dependency is reasonable,' one should look at the names that cross the boundaries.
 */
export interface BoundaryDto {
  from: BoundaryEndDto;
  to: BoundaryEndDto;
  /** File-level import: who imported whose file, and which names were imported */
  imports: BoundaryImportDto[];
  /** Symbols used by the other party: the number of times they are called, the number of callers, and those only imported (types, constants) */
  symbols: BoundarySymbolDto[];
  /** The front-end request matches the back-end route according to the URL */
  http: Array<{ callerId: string; caller: string; callerPath: string; line: number; routeId: string; route: string; routePath: string }>;
  totals: { files: number; imports: number; typeOnly: number; bypass: number; calls: number; symbols: number };
  /** When there is no direct dependency on either side, the shortest file-level import chain from 'from' to 'to' */
  path: Array<{ id: string; path: string }> | null;
}

export interface BoundaryEndDto {
  id: string;
  label: string;
  path: string;
}

export interface BoundaryImportDto {
  fromId: string;
  fromPath: string;
  toId: string;
  toPath: string;
  line: number;
  names: string[];
  typeOnly: boolean;
  /** Bypassed the other party's package entry and directly led to internal files */
  bypass: boolean;
}

export interface BoundarySymbolDto {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  calls: number;
  callers: number;
  /** Only appears in import, not called (type, constant, class) */
  importOnly: boolean;
}

/**
 * Module business card: Everything you need to know when treating a package or directory as a black box—its external interfaces, what it depends on, and who depends on it,
 * Which I/Os are involved, what are the entry points, how well it has been tested, and how frequently it is modified. By understanding the business card, you don't need to read its entire internals.
 */
export interface ModuleCardDto {
  id: string;
  label: string;
  path: string;
  /** Symbols called or imported from outside this scope, ranked by the number of external callers */
  api: ModuleApiDto[];
  apiTotal: number;
  dependsOn: ModuleLinkDto[];
  usedBy: ModuleLinkDto[];
  externals: Array<{ name: string; files: number }>;
  io: Array<{ kind: IoKind; functions: number }>;
  entries: Array<{ id: string; kind: EntryPointKind; label: string; symbolId: string | null }>;
  tests: { functions: number; covered: number; cases: number };
  history: { commits: number; recentCommits: number; aiCommits: number; hottest: Array<{ id: string; path: string; recentCommits: number; complexity: number }> } | null;
  layer: { name: string; confirmed: boolean } | null;
}

export interface ModuleApiDto {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  signature: string | null;
  /** Number of caller functions outside the scope */
  callers: number;
  /** Number of files referencing it outside the scope */
  files: number;
}

export interface ModuleLinkDto {
  /** The other party's node ID: package or directory */
  id: string;
  label: string;
  /** Number of import statements */
  imports: number;
  /** Names used across boundaries, ranked by frequency, top several */
  names: string[];
  /** All are import type */
  typeOnly: boolean;
  /** There is a frontend request matching the route by URL */
  http: boolean;
}

// ---------------------------------------------------------------------------
// Framework: Core Data Structures and Data Tables
// ---------------------------------------------------------------------------

/** How a type flows in code: who creates it, who returns it, who receives it, who implements it */
export interface TypeFlowDto {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  /** `new T()` or the place where it is constructed */
  creators: FlowRefDto[];
  /** A function whose return type is specified */
  producers: FlowRefDto[];
  /** Its function is written in the parameter type */
  consumers: FlowRefDto[];
  /** The types that inherit, implement, or embed it */
  implementers: FlowRefDto[];
  /** import its file count */
  importers: number;
}

export interface FlowRefDto {
  id: string;
  name: string;
  path: string;
  line: number;
  /** Appears in: parameter names, return type text, etc. */
  detail: string | null;
}

export interface SkeletonDto {
  /** The type most referenced by function signatures: system skeleton */
  types: Array<{ id: string; name: string; kind: SymbolKind; path: string; line: number; uses: number; producers: number; consumers: number }>;
  /** Data tables appearing in SQL literals, and the functions that read and write them */
  tables: DataTableDto[];
}

export interface DataTableDto {
  name: string;
  reads: DataAccessRefDto[];
  writes: DataAccessRefDto[];
}

export interface DataAccessRefDto {
  symbolId: string | null;
  name: string;
  path: string;
  line: number;
}

// ---------------------------------------------------------------------------
// Perspective
// ---------------------------------------------------------------------------

/** A layer of perspective overlaid on the diagram: each node is a set of numbers, and the interface uses them according to the perspective */
export type LensKind = "heat" | "tests";

export interface LensValueDto {
  /** Change activity: Number of commits in the past 90 days and the past year, number of commits involving AI */
  recent?: number;
  commits?: number;
  aiCommits?: number;
  /** Test coverage: the number of functions involved in statistics, and the number that were exercised during testing */
  total?: number;
  covered?: number;
}

// ---------------------------------------------------------------------------
// Entry and Step-by-Step Reading
// ---------------------------------------------------------------------------

export type EntryPointKind = "main" | "cli" | "http" | "public-api" | "test";
/** I/O access recognized at the call site */
export type IoKind = "database" | "network" | "filesystem" | "message-queue" | "process";

export interface EntryPointDto {
  id: string;
  kind: EntryPointKind;
  framework?: string | null;
  /** Handler function; an anonymous closure is empty when it has no independent symbol, and such an entry cannot be walked through. */
  symbolId?: string | null;
  fileId: string;
  filePath: string;
  fileRole: FileRole;
  line: number;
  label: string;
  method?: string | null;
  route?: string | null;
  confidence: "exact" | "likely";
  evidence: string;
  /** The number of internal functions in the repository that can be reached from the handler downward along defined/possible calls (capped at 999) */
  reachSymbols: number;
  /** The functions above are distributed across several other files, not including the file where the processing function itself is located. */
  reachFiles: number;
  /** The types of I/O that will be encountered below */
  reachIo: IoKind[];
}

/** How many minimum jumps down a function will encounter a certain type of I/O; 0 means it is doing it itself */
export interface IoReachDto {
  kind: IoKind;
  depth: number;
}

/** Call the function in the repository pointed to within one run of walk-through */
export interface WalkTargetDto {
  id: string;
  /** Full name with container, such as `IndexWriter.upsertFile` */
  name: string;
  kind: SymbolKind;
  fileId: string;
  filePath: string;
  line: number;
  /** There are still a few callable points in its function body where it can continue; 0 indicates that it reaches the end once entered. */
  steps: number;
  /** Cached AI one-sentence summary; read-only cache, does not trigger generation for on-the-fly reading */
  summary?: string | null;
  reaches: IoReachDto[];
  complexity?: number;
  /** The function body merely passes the call to another function as is: stepping into it is like going one level deeper, directly to the one that actually does the work. */
  forwardsTo?: WalkTargetDto | null;
  /** The number of test cases it can reach */
  tests?: number;
}

/** A call inside the function body, arranged in execution order in WalkFrameDto.calls */
export interface WalkCallDto {
  id: string;
  /** The line where the name is being modified; in cross-line chained calls, each segment is on its own line */
  line: number;
  /** The adjusted name is at the starting column of that line (UTF-16 offset), and the interface highlights the specific position accordingly */
  column: number;
  callee: string;
  receiver?: string | null;
  kind: CallKind;
  arguments: string[];
  resolution: Confidence;
  /** The landing point when exact/likely; when ambiguous, it is the first among the candidates, based on candidates. */
  target?: WalkTargetDto | null;
  candidates?: WalkTargetDto[] | null;
  /** Library name when external */
  external?: string | null;
  /** external falls on the language built-ins (Map, console, len), rather than the library imported by some file */
  builtin?: boolean;
  /** The reason why 'unresolved' cannot be pushed at the time, and the interface provides specific prompts accordingly */
  unresolved?: UnresolvedReason | null;
  io?: IoKind | null;
  /** Control structure from the outside to the inside of the function body: in which if/else/loop/try/callback */
  blocks?: ControlBlock[];
  /** Independent call whose return value is unused */
  discarded?: boolean;
  /**
   * Timing, logging, and tracking-like side calls: the target function is very small, called everywhere, its return value is unused, or that's just its name
   * log / time / trace. Reading daily notes is collapsed by default, the main thread reads coherently; write down truthfully how much is collapsed.
   */
  trivial?: boolean;
  /** Data table read and written in SQL literal */
  tables?: Array<{ name: string; write: boolean }>;
}

/**
 * Why wasn't the call parsed:
 * callback is the function passed in as a parameter; function-value is the function stored in a variable; source is the call that produced it (such as `useT()`).
 * destructured means it is extracted from the return value of that call (for example, `useState()`).
 * chained is attached to a return value of an un-inferable type; untyped means the receiving variable's type cannot be inferred, and source is the call that assigns a value to it.
 * param indicates that it is an untyped parameter; inherited means the method on this was not found in the class or the parent class.
 */
export type UnresolvedReason =
  | { kind: "callback" }
  | { kind: "function-value"; source: string | null; destructured?: boolean }
  | { kind: "chained" }
  | { kind: "untyped"; source?: string; param?: boolean }
  | { kind: "inherited" };

/** A single-step frame: the source code range of a function, and the calls that occur within it in sequence */
export interface WalkFrameDto {
  id: string;
  name: string;
  kind: SymbolKind;
  fileId: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  signature?: string | null;
  summary?: string | null;
  reaches: IoReachDto[];
  calls: WalkCallDto[];
}

// ---------------------------------------------------------------------------
// Change of perspective: Structural differences between the two indexes
// ---------------------------------------------------------------------------

export type ChangeStatus = "added" | "removed" | "modified";

export interface FileChangeDto {
  status: ChangeStatus | "moved";
  path: string;
  /** The old path when moved */
  from?: string | null;
  /** The file node ID in head; null when removed */
  id: string | null;
  role: FileRole;
  language: Language;
  loc: number;
  locBefore: number;
}

export interface SymbolChangeDto {
  status: ChangeStatus;
  /** The symbol node id in head; null when removed */
  id: string | null;
  name: string;
  container: string | null;
  kind: SymbolKind;
  path: string;
  line: number;
  exported: boolean;
  role: FileRole;
  complexity: number;
  complexityBefore: number | null;
  signature: string | null;
  signatureBefore: string | null;
  /** Whether the AST shape changed when modified; false indicates only the name, literal, or format was changed */
  shapeChanged: boolean;
  /** Number of direct callers: take from the baseline if removed, otherwise take from the current */
  callers: number;
  /** The current number of test cases that reach it; null when removed */
  tests?: number | null;
}

/**
 * What has changed in the behavior of a function: who it now calls, who it no longer calls, which types of I/O it starts or stops directly accessing.
 * Line-by-line diff looks at the characters, here we look at its interactions with the outside world — when reviewing AI's changes, this layer should be examined first.
 */
export interface BehaviorChangeDto {
  /** The symbol id in the head corresponds to the same entry in symbols */
  id: string | null;
  name: string;
  path: string;
  line: number;
  status: "added" | "modified";
  callsAdded: CallChangeDto[];
  callsRemoved: CallChangeDto[];
  ioAdded: IoKind[];
  ioRemoved: IoKind[];
}

export interface CallChangeDto {
  /** Name to be adjusted: With containers inside the warehouse, with warehouse name outside */
  name: string;
  /** The symbol ID in the head when it falls into the warehouse */
  target: string | null;
  /** External libraries or built-in language features */
  external: string | null;
}

/**
 * Change unit: A set of changes connected along call relationships. Reviewing one concept at a time is easier than looking at files one by one.
 * Figure out exactly how many things AI did this time and which areas each thing touched.
 */
export interface ChangeClusterDto {
  id: string;
  /** The function at the top upstream in this group */
  label: string;
  /** head id of the symbol changed in the group */
  members: string[];
  /** Number of entries that can reach this set of changes */
  entries: number;
  /** The bigger it is, the more it should be reviewed first: export interfaces, new I/O, new calls, increasing complexity, no tests */
  risk: number;
  reasons: Array<{ kind: ClusterReason; count: number }>;
}

export type ClusterReason = "exported" | "signature" | "io" | "calls" | "complexity" | "untested" | "entries";

export interface DependencyChangeDto {
  status: "added" | "removed";
  level: "package" | "directory";
  source: string;
  target: string;
  type: "imports" | "references" | "http";
  count: number;
}

export interface FindingChangeDto {
  status: "added" | "resolved";
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  scopeKey: string;
  path: string;
}

export interface EntryChangeDto {
  /** affected: The entry point itself is still there, but the code it can reach has changed */
  status: "added" | "removed" | "affected";
  /** The entry id in head; null when removed */
  id: string | null;
  /** The handler function corresponding to the head entry */
  symbolId: string | null;
  kind: EntryPointKind;
  label: string;
  path: string;
  /** Symbols that can be reached from the entry point, sorted by call depth */
  via: Array<{ id: string; name: string; depth: number }>;
  /** The I/O types newly encountered / no longer encountered going down this entry: changes in behavior and security aspects */
  ioAdded?: IoKind[];
  ioRemoved?: IoKind[];
}

/** The baseline commits that can be selected for change comparison only list those that have modified the scan root. */
export interface CommitDto {
  commit: string;
  short: string;
  subject: string;
  author: string;
  /** Submission time, ISO format */
  date: string;
  /** This is the one currently detected. */
  head: boolean;
  branches: string[];
  tags: string[];
}

export interface ChangeReportDto {
  base: { ref: string; commit: string };
  /** head being null indicates the workspace (including uncommitted changes) */
  head: { ref: string; commit: string } | null;
  /** When was the current index used for comparison scanned: the workspace comparison only reflects the code at that moment */
  headIndexedAt: string | null;
  generatedAt: string;
  files: FileChangeDto[];
  symbols: SymbolChangeDto[];
  dependencies: DependencyChangeDto[];
  externals: { added: string[]; removed: string[] };
  findings: FindingChangeDto[];
  entries: EntryChangeDto[];
  behavior: BehaviorChangeDto[];
  clusters: ChangeClusterDto[];
}

// ---------------------------------------------------------------------------
// Follow-up question AI
// ---------------------------------------------------------------------------

/**
 * A follow-up question with accompanying context. The browser only sends the node ID and the text referenced by the user, source code, calls
 * Relationships and summaries are queried by the server according to the id—neither allowing the frontend to stuff the entire source code into the request, nor
 * Let the model see a 'source code' that may have been tampered with.
 */
export type ChatRefDto =
  | { kind: "node"; id: string }
  | {
      kind: "quote";
      text: string;
      /** Which node the citation comes from; when line numbers are included, the server will attach those lines of the original text. */
      nodeId?: string | null;
      lines?: [number, number] | null;
    }
  | {
      kind: "view";
      mode: "structure" | "callgraph" | "walk";
      /** The root scope of the structure view, or `call:<symbolId>` in the call graph */
      scope?: string | null;
      expanded?: string[] | null;
      /** Call stack for single-step execution, starting from the entry point; each frame contains the function ID and the point at which the call is paused */
      walk?: Array<{ id: string; at: string | null }> | null;
    };

export interface ChatMessageDto {
  role: "user" | "assistant";
  content: string;
  refs?: ChatRefDto[] | null;
}

export interface ChatRequestDto {
  messages: ChatMessageDto[];
}

/** The server actually puts the prompt context in and echoes it back to the interface, so that people know what the AI has seen. */
export interface ChatContextItemDto {
  label: string;
  detail: string;
  nodeId?: string | null;
}

/**
 * The step where the model itself looks things up during the answering process (reading files, searching code, checking submissions, grabbing web pages). For the same id, first with
 * Press run once, after completion press again for the final state, and the interface updates in place accordingly.
 */
export interface ChatToolStepDto {
  id: string;
  tool: ChatToolName;
  /** Objects for viewing by people: paths, search terms, submission numbers, or URLs */
  target: string;
  status: "running" | "done" | "error";
  /** Nodes that can be opened on the interface; files not indexed are `raw:path` */
  nodeId?: string | null;
  lines?: [number, number] | null;
  url?: string | null;
  error?: string | null;
}

export type ChatToolName =
  | "list_files"
  | "read_file"
  | "search_code"
  | "find_symbols"
  | "get_node"
  | "git_log"
  | "git_show"
  | "git_blame"
  | "git_diff"
  | "fetch_url";

export interface ChatDoneDto {
  model: string;
  usage: LlmUsage;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Where to hang the notes. The node ID changes with each scan, so the file and symbol are stored with the path and line number.
 * The IDs of packages and directories are themselves composed of names and paths, and can be saved as they are.
 */
export type NoteTargetDto =
  | {
      kind: "file";
      path: string;
      lines: [number, number] | null;
      /** Use the symbol name noted from the symbol to indicate on the interface what these lines are */
      symbol: string | null;
    }
  | { kind: "scope"; id: string; label: string };

export interface NoteDto {
  id: string;
  target: NoteTargetDto;
  text: string;
  /** The follow-up question corresponding to taking notes */
  question: string | null;
  createdAt: string;
  /** The node corresponding to the current index; null if the file has been deleted or renamed */
  nodeId: string | null;
  /** The document has been modified after taking notes, so the line numbers may no longer match. */
  stale: boolean;
}

export interface NoteInputDto {
  /** The node id in the current index, which the server uses to calculate the stable path and line number */
  nodeId: string;
  lines?: [number, number] | null;
  text: string;
  question?: string | null;
}

// ---------------------------------------------------------------------------
// Chart Query Parameters
// ---------------------------------------------------------------------------

export interface GraphQuery {
  /** View hierarchy */
  level: "package" | "directory" | "file" | "symbol";
  /** Use this node as the scope; default is the entire warehouse */
  scope?: string | undefined;
  /** Number of neighbor layers centered on this node */
  focus?: string | undefined;
  depth?: number | undefined;
  /** Allowed confidence levels */
  confidence?: Confidence[] | undefined;
  /** Allowed file roles */
  roles?: FileRole[] | undefined;
  /** Maximum number of nodes; if exceeded, aggregate */
  limit?: number | undefined;
  /** Whether to include external aggregation nodes */
  includeExternal?: boolean | undefined;
  edgeTypes?: EdgeType[] | undefined;
}

/** Call graph query centered on a single symbol */
export interface CallGraphOptions {
  symbolId: number;
  /** Each upstream and downstream spreads a few hops, 1-4 */
  depth?: number | undefined;
  direction?: "callers" | "callees" | "both" | undefined;
  /** How many edges can be taken per node per layer at most, to prevent hot functions from overloading the graph */
  limit?: number | undefined;
  confidence?: Confidence[] | undefined;
}
