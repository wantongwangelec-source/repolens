export * from "./types.js";
export {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_FILENAME,
  LOCAL_CONFIG_FILENAME,
  LOCK_FILENAME,
  globalConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadLock,
  updateRepoConfig,
  writeLock,
} from "./config.js";
export {
  architectureModules,
  buildLock,
  moduleDependencies,
  unapprovedDependencies,
  type ArchitectureModule,
  type ModuleDependency,
} from "./db/architecture.js";
export { getBoundary, getModuleCard } from "./db/boundary.js";
export { getSpec, testCoverageOf } from "./db/spec.js";
export { dataTables, getSkeleton, getTypeFlow } from "./db/skeleton.js";
export { fileHistory } from "./db/file-history.js";
export { groundText } from "./db/grounding.js";
export { getLens } from "./lens.js";
export { lookupNode, type LookupCandidate, type LookupResult } from "./lookup.js";
export { runCheck, type CheckOptions, type CheckReport } from "./check.js";

export {
  getMeta,
  getMetaJson,
  indexPath,
  isIndexCurrent,
  INDEX_DIR,
  INDEX_FILE,
  openDb,
  setMeta,
  setMetaJson,
  transact,
  type Db,
} from "./db/database.js";

export {
  EXTERNAL_NODE_ID,
  ROOT_SCOPE,
  confirmedLayers,
  getCallGraph,
  getFindings,
  getFindingSummary,
  getRevealChain,
  getFileDetail,
  getOverview,
  getScopeGraph,
  getScopeReadme,
  getSource,
  getSymbolDetail,
  getTree,
  search,
  symbolKey,
  type GraphOptions,
} from "./db/queries.js";

export { getFileTree, readRepoFile, RepoFileError } from "./db/file-tree.js";

export { getEntryPoints, getWalkFrame } from "./db/walk.js";

// The types RegisteredRepo / RepoEntry / RepoStatus are exported by `export *` in types.js
// Export it here without repeating the export, otherwise the same name will have two sources.
export {
  HOME_DIR,
  REGISTRY_FILE,
  forgetRepo,
  gitBranch,
  listRepos,
  probe,
  readRegistry,
  registryPath,
  rememberRepo,
  repoId,
} from "./registry.js";
export { NoteInputError, addNote, deleteNote, listNotes, notesPath, parseNoteInput } from "./notes.js";

export { scanRepo, type ScanOptions } from "./pipeline/scan.js";
export { refreshConventions } from "./pipeline/conventions.js";
export { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "./discovery/ignore.js";
export { indexChangeFilter } from "./watch.js";
export { evaluateRules, type RuleReport, type RuleViolation } from "./pipeline/rules.js";
export { BaselineError, buildBaseline, headCommit, listCommits, type Baseline } from "./diff/baseline.js";
export { diffIndexes, type DiffOptions } from "./diff/compare.js";
export { buildChangeReport, type ChangeReportOptions } from "./diff/report.js";
export {
  dropSemanticsFromOutdatedInput,
  enrichRepository,
  generateFileSummary,
  generateSymbolSemantics,
  semanticInputOutdated,
} from "./llm/enrich.js";
export {
  LlmResponseError,
  LlmUnavailableError,
  OpenAiCompatibleClient,
  llmUnavailableReason,
} from "./llm/client.js";
export { currentLlmStatus } from "./llm/status.js";
export {
  buildChatContext,
  parseChatRequest,
  recordChatUsage,
  streamRepositoryChat,
  type ChatStreamHandlers,
} from "./llm/chat.js";
export { countLoc } from "./pipeline/metrics.js";

export {
  detectLanguage,
  isAnalyzable,
  languageDefinition,
  languageDefinitions,
  registerLanguage,
  type EmbeddedSourceKind,
  type ExtractorFamily,
  type LanguageDefinition,
  type ResolverFamily,
} from "./discovery/language.js";
export { classifyRole, createRoleClassifier, type RoleClassifier } from "./discovery/roles.js";
export { discoverPackages } from "./discovery/workspace.js";
export { walkRepo } from "./discovery/walk.js";

export { ParserPool } from "./parse/parser-pool.js";
export { extractorFor, registerExtractorFor } from "./parse/extractors/registry.js";
export type { ExtractInput, LanguageExtractor } from "./parse/extractors/types.js";
export { createResolvers, registerResolverFor } from "./resolve/registry.js";
export { registerLanguagePlugin, type LanguagePlugin } from "./language-plugin.js";
export * from "./resolve/path-utils.js";
