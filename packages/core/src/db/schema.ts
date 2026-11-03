/**
 * SQLite schema。
 *
 * Storing as TS strings instead of .sql files is to avoid additional resource copy steps during the build——
 * tsc won't include .sql files in dist, rather than adding a copy script, it's better to inline it here.
 */

export const SCHEMA_SQL = String.raw`
-- RepoLens 知识图谱 schema
--
-- 设计要点：
-- 1. 结构事实（files/symbols/imports）与语义产物（summaries）分表，前者可重算，后者是缓存。
-- 2. 所有边统一进 edges 表，带 confidence 字段，查询时按置信度过滤。
-- 3. 目录级/包级聚合边预先算好落在 rollup_edges，避免前端每次展开都做实时聚合。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 结构实体
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packages (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  dir          TEXT NOT NULL UNIQUE,
  manager      TEXT NOT NULL,
  version      TEXT,
  entry_points TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS directories (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  parent_path TEXT,
  name        TEXT NOT NULL,
  depth       INTEGER NOT NULL,
  package_id  INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  -- 以下为子树累计值，由 rollup 阶段回填
  loc         INTEGER NOT NULL DEFAULT 0,
  file_count  INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  complexity  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dir_parent ON directories(parent_path);

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  dir_path    TEXT NOT NULL,
  name        TEXT NOT NULL,
  language    TEXT NOT NULL,
  role        TEXT NOT NULL,
  package_id  INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  loc         INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  complexity  INTEGER NOT NULL DEFAULT 0,
  hash        TEXT NOT NULL,
  parsed      INTEGER NOT NULL DEFAULT 0,
  parse_error TEXT,
  -- M4：入口标记，逗号分隔的入口类型
  entry_kind  TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_dir ON files(dir_path);
CREATE INDEX IF NOT EXISTS idx_file_pkg ON files(package_id);
CREATE INDEX IF NOT EXISTS idx_file_role ON files(role);
CREATE INDEX IF NOT EXISTS idx_file_lang ON files(language);

CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  container     TEXT,
  exported      INTEGER NOT NULL DEFAULT 0,
  signature     TEXT,
  params        TEXT,          -- JSON: ParamDto[]
  return_type   TEXT,
  doc           TEXT,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  start_byte    INTEGER NOT NULL,
  end_byte      INTEGER NOT NULL,
  complexity    INTEGER NOT NULL DEFAULT 1,
  is_async      INTEGER NOT NULL DEFAULT 0,
  is_static     INTEGER NOT NULL DEFAULT 0,
  receiver_type TEXT,
  /** Symbol content fingerprint, used for LLM cache invalidation determination */
  hash          TEXT NOT NULL DEFAULT '',
  /** Structural fingerprint: The AST shape ignoring names and literals, used to identify duplicate implementations */
  shape         TEXT,
  /** Test cases or test suites in the test file */
  test_kind     TEXT,
  /** 0 indicates that there is only a signature without an implementation: interface methods, overloaded declarations, trait method signatures */
  implemented   INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sym_test ON symbols(test_kind);
CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_shape ON symbols(shape);
CREATE INDEX IF NOT EXISTS idx_sym_exported ON symbols(exported);
CREATE INDEX IF NOT EXISTS idx_sym_lookup ON symbols(name, kind);

-- ---------------------------------------------------------------------------
-- import / 模块解析
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_source    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  confidence    TEXT NOT NULL,       -- exact | external | unresolved
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  target_dir    TEXT,                -- Go 包级 import 落在目录
  external_name TEXT,
  unresolved_reason TEXT,
  is_type_only  INTEGER NOT NULL DEFAULT 0,
  line          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imp_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imp_target ON imports(target_file_id);

CREATE TABLE IF NOT EXISTS import_specifiers (
  id           INTEGER PRIMARY KEY,
  import_id    INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  imported     TEXT NOT NULL,
  local        TEXT NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,
  is_namespace INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_impspec_import ON import_specifiers(import_id);
CREATE INDEX IF NOT EXISTS idx_impspec_local ON import_specifiers(local);

CREATE TABLE IF NOT EXISTS exports (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  source    TEXT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  line      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exp_file ON exports(file_id);
CREATE INDEX IF NOT EXISTS idx_exp_name ON exports(name);
CREATE INDEX IF NOT EXISTS idx_exp_symbol ON exports(symbol_id);

-- ---------------------------------------------------------------------------
-- 调用点（原始事实）
-- ---------------------------------------------------------------------------

-- 与 edges 分表存放，因为二者性质不同：call_sites 是 AST 里读出来的原始事实，
-- edges 是链接后的派生结果。分开之后重跑链接器不需要重新解析源码，
-- 增量扫描只要替换变更文件的 call_sites，再整体重算一遍链接即可。
--
-- resolution 起的几列是链接阶段逐行回填的派生值。edges 按 (调用者, 被调者)
-- 合并、只留第一处行号，回答不了「这个函数体里依次调了谁」；单步走读要的
-- 正是每一处调用各自落到哪里。
CREATE TABLE IF NOT EXISTS call_sites (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  caller_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name      TEXT NOT NULL,
  receiver         TEXT,
  receiver_type    TEXT,             -- 解析器看到的接收者类型线索，链接阶段据此解析方法调用
  callee_path      TEXT,
  call_kind        TEXT NOT NULL,
  arg_count        INTEGER NOT NULL DEFAULT 0,
  argument_texts   TEXT NOT NULL DEFAULT '[]',
  line             INTEGER NOT NULL,
  end_byte         INTEGER NOT NULL DEFAULT 0,
  name_line        INTEGER NOT NULL DEFAULT 0,   -- 被调名本身的位置，列为 UTF-16 偏移
  name_col         INTEGER NOT NULL DEFAULT 0,
  resolution       TEXT NOT NULL DEFAULT 'unresolved',
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  target_name      TEXT,             -- external 时的库名
  candidates       TEXT,             -- ambiguous 时的候选符号 id，JSON 数组
  io_kind          TEXT,             -- 识别出的 I/O 访问：database | network | filesystem | ...
  blocks           TEXT,             -- 所在的控制结构，JSON：ControlBlock[]，直接在函数体里时为 NULL
  discarded        INTEGER NOT NULL DEFAULT 0  -- 独立成句、返回值没人用
);

CREATE INDEX IF NOT EXISTS idx_callsite_file ON call_sites(file_id);
CREATE INDEX IF NOT EXISTS idx_callsite_caller ON call_sites(caller_symbol_id);
-- 外键的子表列都要有索引：删一个符号时 SQLite 要找出所有指向它的行，没有索引就是整表扫，
-- 大仓库重新解析一批文件会慢成几百秒
CREATE INDEX IF NOT EXISTS idx_callsite_target ON call_sites(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_callsite_name ON call_sites(callee_name);

CREATE TABLE IF NOT EXISTS entry_hints (
  id           INTEGER PRIMARY KEY,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  framework    TEXT NOT NULL,
  handler_name TEXT,
  line         INTEGER NOT NULL,
  label        TEXT NOT NULL,
  method       TEXT,
  route        TEXT,
  confidence   TEXT NOT NULL,
  evidence     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entryhint_file ON entry_hints(file_id);

-- ---------------------------------------------------------------------------
-- 边
-- ---------------------------------------------------------------------------

-- 符号级与文件级的原始边。src/dst 以 kind + id 二元组表达，
-- 用两列而不是多态外键，换来一张表统一查询的便利。
CREATE TABLE IF NOT EXISTS edges (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  src_kind     TEXT NOT NULL,       -- file | symbol
  src_id       INTEGER NOT NULL,
  dst_kind     TEXT NOT NULL,       -- file | symbol | external
  dst_id       INTEGER,
  dst_name     TEXT,                -- dst_kind = external 时的名字
  confidence   TEXT NOT NULL,
  line         INTEGER,
  call_kind    TEXT,
  /** Candidate symbol id when ambiguous, JSON array */
  candidates   TEXT,
  weight       REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_edge_src ON edges(src_kind, src_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst_kind, dst_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_type_conf ON edges(type, confidence);

-- 预聚合的高层边：目录→目录、包→包。
CREATE TABLE IF NOT EXISTS rollup_edges (
  id         INTEGER PRIMARY KEY,
  level      TEXT NOT NULL,          -- package | directory
  type       TEXT NOT NULL,
  src        TEXT NOT NULL,          -- 包名或目录路径
  dst        TEXT NOT NULL,
  confidence TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  weight     REAL NOT NULL DEFAULT 1.0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rollup_uniq
  ON rollup_edges(level, type, src, dst, confidence);
CREATE INDEX IF NOT EXISTS idx_rollup_level ON rollup_edges(level, type);

-- ---------------------------------------------------------------------------
-- 类型关系（extends / implements / embeds）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS type_relations (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  subject_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  target      TEXT NOT NULL,
  target_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  confidence  TEXT NOT NULL,
  line        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_typerel_subject ON type_relations(subject_id);
CREATE INDEX IF NOT EXISTS idx_typerel_target ON type_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_typerel_file ON type_relations(file_id);

-- ---------------------------------------------------------------------------
-- 架构体检
-- ---------------------------------------------------------------------------

-- 结论存表而不是查询时现算：判据里有跨全仓的比较（同形状符号分组、
-- 环检测），实时算会让每次展开都扫全表。而它和 edges 一样是纯派生数据，
-- 每次链接阶段整体重建。
--
-- 一条 finding 挂在一个「作用域」上（包/目录/文件/符号），这样图上任何
-- 一层都能直接问「我这里有没有问题」，不必反向遍历。
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,        -- duplicate | cycle
  severity    TEXT NOT NULL,        -- high | medium | low
  scope_kind  TEXT NOT NULL,        -- package | directory | file | symbol
  /** Graph node id, in the form pkg:core / dir:src/db / sym:1337, convenient for direct alignment with the graph */
  scope_key   TEXT NOT NULL,
  /** The relative path of the repository. Upper-level nodes use it as a prefix for aggregation; otherwise, the issue is only visible at the deepest level. */
  path        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  /** Relevant node IDs, in a JSON array; on the interface, they can be lit up all at once with one click */
  related     TEXT NOT NULL DEFAULT '[]',
  /** Grouping key shared by the same set of questions, used to link the various members of a finding together */
  group_key   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_finding_scope ON findings(scope_kind, scope_key);
CREATE INDEX IF NOT EXISTS idx_finding_kind ON findings(kind, severity);
CREATE INDEX IF NOT EXISTS idx_finding_group ON findings(group_key);
CREATE INDEX IF NOT EXISTS idx_finding_path ON findings(path);

-- ---------------------------------------------------------------------------
-- 语义层缓存（M3）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL,        -- repo | package | directory | file | symbol
  target_key  TEXT NOT NULL,        -- 稳定键：包名 / 目录路径 / 文件路径 / 符号签名键
  flavor      TEXT NOT NULL,        -- summary | summary-v2 | tooltip-summary | pseudocode | pseudocode-map
  lang        TEXT NOT NULL,
  content     TEXT NOT NULL,
  /** Generate the content fingerprint of the target at the time, and if it does not match, it is considered expired. */
  source_hash TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_uniq
  ON summaries(target_kind, target_key, flavor, lang);

CREATE TABLE IF NOT EXISTS layers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ordinal     INTEGER NOT NULL DEFAULT 0,
  members     TEXT NOT NULL DEFAULT '[]',  -- JSON: 节点 id 数组
  source_hash TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- 入口与单步走读（全部可由解析事实重建）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entry_points (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  framework   TEXT,
  symbol_id   INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line        INTEGER NOT NULL,
  label       TEXT NOT NULL,
  method      TEXT,
  route       TEXT,
  confidence  TEXT NOT NULL,
  evidence    TEXT NOT NULL,
  -- 从处理函数出发沿确定/可能的调用能走到的仓库内函数数、文件数，以及途经的 I/O 类型
  reach_symbols INTEGER NOT NULL DEFAULT 0,
  reach_files   INTEGER NOT NULL DEFAULT 0,
  reach_io      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entry_symbol ON entry_points(symbol_id);
CREATE INDEX IF NOT EXISTS idx_entry_kind ON entry_points(kind);
CREATE INDEX IF NOT EXISTS idx_entry_file ON entry_points(file_id);

-- 每个函数往下走最少几跳能碰到某类 I/O；0 表示它自己就在做。
-- 走读时据此提示「从这一步进去会访问数据库」，人才知道该往哪个分支走。
CREATE TABLE IF NOT EXISTS io_reach (
  symbol_id   INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  depth       INTEGER NOT NULL,
  PRIMARY KEY (symbol_id, kind)
);

-- 测试覆盖：哪些用例能沿确定/可能的调用走到这个源码符号。用例是人写下的行为说明，
-- 读一个函数时先看「谁在测它、测的是什么」，比看 AI 摘要更可信。链接阶段整表重建。
CREATE TABLE IF NOT EXISTS test_coverage (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  tests     INTEGER NOT NULL,
  direct    INTEGER NOT NULL,
  nearest   TEXT NOT NULL DEFAULT '[]'   -- JSON: [[用例符号 id, 层数], …]，最近的几条
);

-- SQL 字面量里读写的表。只认写在代码里的 SQL 文本，ORM 的模型方法不在其中。
CREATE TABLE IF NOT EXISTS data_access (
  id           INTEGER PRIMARY KEY,
  call_site_id INTEGER NOT NULL REFERENCES call_sites(id) ON DELETE CASCADE,
  symbol_id    INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  table_name   TEXT NOT NULL,
  write        INTEGER NOT NULL DEFAULT 0,
  line         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_data_table ON data_access(table_name);
CREATE INDEX IF NOT EXISTS idx_data_call ON data_access(call_site_id);
CREATE INDEX IF NOT EXISTS idx_data_symbol ON data_access(symbol_id);
CREATE INDEX IF NOT EXISTS idx_data_file ON data_access(file_id);

-- git 历史（默认近 12 个月）。按路径存而不是按文件 id：它来自 git 而不是解析，
-- 扫描时整表重建，和文件表按路径对上即可。
CREATE TABLE IF NOT EXISTS file_history (
  path         TEXT PRIMARY KEY,
  commits      INTEGER NOT NULL,
  recent       INTEGER NOT NULL,       -- 近 90 天
  last_at      TEXT,
  authors      INTEGER NOT NULL,
  ai_commits   INTEGER NOT NULL DEFAULT 0
);

-- 每次提交改了哪些文件。模块的提交数要按提交去重，把文件各自的次数加起来会数重
CREATE TABLE IF NOT EXISTS history_commits (
  id      INTEGER PRIMARY KEY,
  recent  INTEGER NOT NULL,              -- 近 90 天
  ai      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS history_files (
  commit_id INTEGER NOT NULL REFERENCES history_commits(id) ON DELETE CASCADE,
  path      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_files_path ON history_files(path);
CREATE INDEX IF NOT EXISTS idx_history_files_commit ON history_files(commit_id);

-- 总是一起改的源码文件对。代码里有没有依赖关系留给体检判断。
CREATE TABLE IF NOT EXISTS co_changes (
  a        TEXT NOT NULL,
  b        TEXT NOT NULL,
  together INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

-- ---------------------------------------------------------------------------
-- 全文搜索
-- ---------------------------------------------------------------------------

-- role 冗余在这里而不是查询时回表：搜索要按噪音开关过滤，而 FTS5
-- 的 MATCH 必须先跑完才能拿到行，回表 JOIN 会让 LIMIT 失去意义
-- （先取 30 条再过滤掉 25 条测试文件，结果只剩 5 条）。
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  label,
  detail,
  kind UNINDEXED,
  ref  UNINDEXED,
  role UNINDEXED,
  tokenize = 'unicode61'
);
`;

/** Schema version, bump when changed. In database.ts, if there is an old version for migration, upgrade it in place; if not, rebuild the entire database. */
export const SCHEMA_VERSION = "9";
