# RepoLens 架构设计

## 一句话

RepoLens 是一个本地运行的代码仓库理解工具：CLI 扫描仓库产出一份确定性的代码知识图谱（SQLite），
本地 Web UI 以渐进式下钻的方式可视化架构、目录、调用关系、函数传参与逻辑伪代码。

## 设计立场

这类工具最容易崩塌的地方是**可信度**。一旦用户发现图上的一条调用边是模型编出来的，
整张图的价值就归零了。所以 RepoLens 的第一原则是：

> **结构由解析器决定，语义由模型补充，两者在数据模型里严格分离，并在 UI 上可区分。**

具体体现：

| 内容 | 来源 | 是否可能出错 |
| --- | --- | --- |
| 文件、目录、包、语言、行数 | 文件系统 | 否 |
| 函数/类/结构体定义、位置、签名 | tree-sitter AST | 否 |
| import 语句、导出符号 | tree-sitter AST | 否 |
| import 目标文件 | 各语言模块解析器 | 可解析失败，但不会猜 |
| 调用边 | AST 调用点 + 解析器 | 分四档置信度，见下 |
| 前后端 HTTP 连线 | 前端请求 URL 字面量 × 后端路由注册，按路径段推断 | 是，一律 `likely` / `ambiguous`，UI 标 `HTTP` |
| 架构规则违规 | 仓库声明的规则 × 已解析到确定目标的 import | 判据不误报，只会因 import 未解析而漏报 |
| 摘要、伪代码、架构分层命名 | LLM | 是，UI 明确标注为 AI 生成 |

参考实现 [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) 的做法是：
tree-sitter 只提取 `{ caller: string, callee: string, lineNumber }`（纯名字，无目标文件），
再由 LLM agent 拿着 importMap 去推断 callee 属于哪个文件。这意味着调用图的正确性依赖模型。
RepoLens 把这一步做成确定性的，代价是每种语言要写一个模块解析器。

## 调用边置信度模型

每条 `calls` 边带 `confidence` 字段：

| 档位 | 判定条件 | UI 呈现 | 默认可见 |
| --- | --- | --- | --- |
| `exact` | 同文件定义；`this.x` 命中同一个类；import 链（含 re-export、`export *` 传递闭包）一路走到定义；`api.load()` 沿 import 绑定解析到对象方法 `api.load` | 实线 | 是 |
| `likely` | 有文件级证据但没有符号级证据（Go 同包、Python/Rust 通配导入、import 指到了文件但对方没有显式导出这个名字）；前后端 HTTP 连线 | 虚线 | 是 |
| `ambiguous` | 同名候选多个，全部记录在 `candidates` 里 | 点线 + 角标数字 | 否，需手动打开 |
| `external` | 解析到第三方依赖或语言内置 | 聚合进单个 external 节点 | 折叠 |

`ambiguous` 默认隐藏是刻意的：宁可少画一条边，也不画一条错边。

「全仓唯一同名」只在没有模块解析器的语言里兜底。TS/JS、Python、Rust 的跨文件调用
必须经过 import——没有 import 证据的同名命中几乎全是巧合，局部变量 `run()` 会被连到
另一个包里恰好导出的 `run`，而且跨越了架构边界。Go 的无 import 调用只在同包目录内找。

## 边的种类

| 层级 | 类型 | 含义 |
| --- | --- | --- |
| 符号 | `calls` + `call_kind = call / method / new` | 普通调用、方法调用、构造 |
| 符号 | `calls` + `call_kind = render` | JSX `<Comp/>`：前端组件树靠它连起来 |
| 符号 | `calls` + `call_kind = http` | 前端请求 → 后端路由 handler，按 URL 推断 |
| 文件 | `imports` | 运行时依赖 |
| 文件 | `references` | 只有 `import type`：共享类型不构成运行时耦合 |
| 文件 | `http` | 只有 HTTP 推断边、没有 import 的前后端文件对 |

目录级、包级的汇总边（`rollup_edges`）按同样三类分开聚合，且**只统计源码到源码**：
测试反向引用被测模块是常态，算进来会在架构图上凭空多出依赖和环。模块环检测只看
`imports` 汇总边，类型引用和 HTTP 推断都不构成环。

### 解析器补出来的符号

AI 写的代码里大量逻辑不在「具名函数声明」里，不补这些，图上就是空白：

- **内联 handler**：`app.get("/x", (c) => …)` 的匿名函数合成为 `GET /x`，
  commander 的 `.command("scan").action(() => …)` 合成为 `CLI scan`，成为可追踪的入口
- **对象方法**：顶层常量对象里直接写的函数成为方法符号，`export const api = { load: () => … }`
  → `api.load`；`() => import(...)` 这类懒加载器和非标识符的键（翻译表）不算
- **包装函数**：顶层 `const X = memo(function X() {…})`、`forwardRef(…)`、`lazy(…)`、
  zustand 的 `create(…)` 成为函数符号；`map` / `then` 这类数据回调不算

复杂度只算函数自身的分支，嵌套函数各算各的（与 ESLint `complexity` 同口径），
否则外层函数会因为里面写了几个回调就被判成巨石。

## 包结构

```
repolens/
├── packages/
│   ├── core/      @repolens/core     领域类型、解析、解析器、索引管线、SQLite 持久层、LLM 客户端
│   ├── server/    @repolens/server   本地 HTTP API（读 SQLite，按需拉子图）
│   ├── cli/       @repolens/cli      repolens 命令入口
│   └── web/       @repolens/web      React + React Flow 前端
└── docs/
```

依赖方向严格单向：`web → server → core`，`cli → server + core`。
`web` 只以 `import type` 方式从 `@repolens/core/types` 取类型，不引入任何运行时代码。

## core 内部分层

```
core/src/
├── types.ts              纯类型，零运行时依赖（web 也从这里取类型）
├── config.ts             RepolensConfig：全局 → .repolens.json（约定，提交）→ .repolens.local.json（个人）；依赖锁读写
├── json-file.ts          .repolens/ 下的本地 JSON 列表（笔记）与原子写
├── registry.ts           扫过的仓库清单（~/.repolens/repos.json）
├── check.ts              约定检查：规则 + 依赖锁 + 棘轮，CLI / CI / MCP 共用
├── lens.ts               图上的视角：热度、测试覆盖
├── lookup.ts             把随手写的引用（名字、路径、`文件#容器.名字`、id）换成节点，MCP 用
├── watch.ts              文件变化里哪些值得刷新索引
├── db/
│   ├── schema.ts         DDL
│   ├── database.ts       打开 / 迁移 / WAL / 事务
│   ├── writer.ts         批量写入；重新解析的文件沿用原有符号 id
│   ├── queries.ts        读查询（server 消费）
│   ├── walk.ts           入口列表与单步走读帧的读查询
│   ├── architecture.ts   架构的模块层、模块间依赖、依赖锁、包入口
│   ├── boundary.ts       边即契约（两个节点之间由什么连着）与模块名片
│   ├── spec.ts           测试即规格：走得到某处的用例
│   ├── skeleton.ts       类型流与仓库骨架（核心类型、数据表）
│   ├── scope.ts          节点 id → 它覆盖的文件和函数
│   ├── grounding.ts      AI 文字里的名字对上代码里的哪个节点
│   ├── file-history.ts   文件的 git 历史、按提交去重的模块提交数
│   ├── semantic.ts       AI 生成内容的存取（summaries 表、输出语言、AI 状态）
│   └── semantic-format.ts AI 内容的存储格式：写入和读出时共用的规整与解析
├── discovery/
│   ├── ignore.ts         .gitignore + 默认忽略规则
│   ├── language.ts       语言注册表：扩展名 / grammar / extractor / resolver
│   ├── roles.ts          source / test / config / generated / types / docs 分类
│   ├── workspace.ts      monorepo 包检测（pnpm / npm / go.mod / Cargo / pyproject）
│   └── walk.ts           目录遍历
├── parse/
│   ├── parser-pool.ts    web-tree-sitter 实例复用
│   ├── control-flow.ts   调用所在的控制结构（if / else / 循环 / try / 回调）与守卫分支
│   └── extractors/       每语言一个：符号 / import / 导出 / 调用点；测试回调合成为用例符号
├── resolve/              每语言一个模块解析器：import 说明符 → 文件 → 符号
├── pipeline/
│   ├── scan.ts           扫描编排：发现 → 内容指纹增量 → 解析 → 历史 → 链接 → 语义
│   ├── link.ts           链接阶段编排：import 边与目录/包汇总、类型关系，再依次调下面几步
│   ├── link-calls.ts     调用点 → 符号级调用边，打置信度；逐调用点的解析结果写回 call_sites
│   ├── entries.ts        入口识别、调用点 I/O 分类、每个函数到各类 I/O 的距离、入口可达规模
│   ├── http-links.ts     前端请求 URL ↔ 后端路由的推断边
│   ├── tests.ts          用例沿调用走得到哪些源码函数（静态覆盖）
│   ├── data-access.ts    SQL 字面量里读写的表
│   ├── history.ts        git 历史：文件热度、AI 参与、提交明细、协同变更
│   ├── diagnose.ts       体检编排：重复实现、模块环、巨石函数/文件、规则违规，再调下面两步
│   ├── conventions.ts    依赖锁之外的新依赖、分层倒置、绕过包入口
│   ├── drift.ts          隐性耦合（总是一起改却没有依赖）、指向已删除文件的文档
│   ├── rules.ts          .repolens.json 依赖规则的核对
│   └── metrics.ts        LOC / 圈复杂度
├── diff/
│   ├── baseline.ts       git 提交 → 基线索引（按 commit 缓存）
│   ├── compare.ts        两份索引的结构差异
│   └── report.ts         基线 + 当前索引 → 变更报告
└── llm/                  可插拔 OpenAI 兼容客户端、prompt 与生成编排、AI 状态
```

`db` 不依赖 `llm`：AI 内容的存取和格式属于持久层，`llm` 负责生成后经它写入，
`queries.ts` 读出时不必知道内容是怎么生成的。

## 解析流水线

```
1. discover    遍历文件系统，应用 ignore，分类 role，检测语言，识别 workspace 包
2. fingerprint 计算内容哈希，与上次扫描比对，得出 changed / unchanged / deleted
3. parse       对 changed 文件跑 tree-sitter，提取符号、import、导出、调用点
4. resolve     import 说明符 → 目标文件 id；导入名 → 目标符号 id（构建符号索引）
5. history     （完整扫描）git log 近一年：文件热度、AI 参与、提交明细、协同变更
6. link        整体重算派生数据，顺序固定：
                 import 边与目录/包汇总 → 调用边（打 confidence）→ 类型关系
                 → 入口与 I/O 标注 → HTTP 推断边 → 测试覆盖 → SQL 表 → 搜索索引 → 体检
7. rollup      目录级行数、复杂度等指标汇总
8. enrich      （M3）LLM 生成仓库总览、包摘要和架构分层；函数级摘要与伪代码按需生成
```

第 3-4、6 步是纯函数式的，输入相同必然输出相同，这是增量更新和结果可复现的基础。历史只在完整扫描里读：
基线快照不在 git 里，watch 的增量刷新也不该每次跑一遍 git log，跳过时保留上次读到的。

解析时每处调用还记下它所在的控制结构（`call_sites.blocks`，自外向内的 if / else / case / 循环 / try /
catch / 回调）和返回值有没有人用（`discarded`）。判断只依赖语法树的字段名（condition / consequence /
alternative / body），各家 tree-sitter 语法一致；`a && f()` 记成「a 成立时」、`a ?? f()` 记成「a 为空时」。
if 分支以 return / throw / break / continue 收尾、又没有 else 的，标成守卫分支——走读的「主路径」跳过它们。
认不出的结构不记，宁可少分一组，也不把调用塞进编出来的分支。

`describe` / `it` / `test` 的回调合成为用例符号（标题当名字，`test_kind` 记 case / suite），Python 的
`test_*`、Go 的 `TestXxx` 这类按约定命名的也算。链接期从每个用例沿确定 / 可能的调用往下最多走 4 层，
记下每个源码函数被几个用例走到、哪几个离得最近（`test_coverage`）。这是静态推算，不是运行时覆盖率，
界面上照实这么说。合成的用例符号不进调用候选：`describe("startServer")` 和被测的 `startServer` 同名，
同文件优先的规则会让它抢走调用。

重新解析一个文件时，还在的符号沿用原来的 id（按种类、容器、名字和出现顺序认）：界面上选中的函数、
走读到一半的调用栈在 watch 刷新之后照样指得到。沿用 id 的先插——表没有 AUTOINCREMENT，新符号自动
分到的 id 可能正好是刚腾出来、还没还回去的那个。

入口和 I/O 标注在 HTTP 连线之前算，所以可达规模和单步走读都不跨网络边界：前端的 `fetch`
停在「访问网络」，不会一步跳进后端路由。HTTP 边让两端在图上接得上，但不冒充一条连续的执行轨迹。

单步走读不预先算路径，每一帧现查：`call_sites` 按 `caller_symbol_id` 取出函数体内的调用，
按 `(line, end_byte, id)` 排序。`line` 是整个调用表达式的起始行，`end_byte` 让实参里的调用、
链式调用的前一段排在外层之前，这就是静态求值顺序。高亮用的是 `name_line` / `name_col`，即
方法名本身的位置——多行链式调用的每一段共享同一个起始行，只靠行号定位会全部挤到第一行。
列号按 UTF-16 计，和浏览器里 JS 字符串的下标一致。

方法调用落到哪个类，靠解析期给接收者记的一条类型线索（`call_sites.receiver_type`）。TS/JS
extractor 沿作用域找到接收者变量的声明，按来源写成几种前缀：`T:` 是写出来的类型（参数或变量
标注、`new X()`、`as` / `satisfies`），`R:` / `A:` 是某次调用的返回值（`A:` 带 `await`），`M:`
是属性链、后面跟根变量的线索，`C:` 是注册回调的参数（`app.get(path, (c) => …)` 里的 `c`）；
`P:`（没标类型的参数）和 `D:`（从调用返回值里解构出的名字）只用来向走读解释原因。Python / Go /
Rust 没有这层线索，链接期直接读函数签名里的参数类型和 Go 的方法接收者。

链接期先算类型关系（继承、实现），再按线索推类型：`T:` 在本文件、import、同目录（Go）和语言
内置类型里找名字，类型别名跟到底；`R:` / `A:` 先看同一文件里前面已解析的同名调用，再读被调函数
标注的返回类型，`Promise<T>` 在 `await` 时拆开。推到的是接口或 trait 时找实现者：只有一个算
`likely`，多个就列为候选。写出来的类型命中为 `exact`，靠返回值推出来的降为 `likely`。推不出来
就照旧走名字匹配，所以这层推导只会让调用落得更准，不会凭空多出一条确定的错边。链式调用在推不出
上一段返回值时，`then` / `catch` / `finally` 记为内置 `Promise`。

`external` 里再分语言内置和外部库：有文件 import 过的名字算外部库，否则是语言内置（`JSON`、
`Map`、`print`、`len`、`fmt` 等，按语言族列在 `pipeline/builtins.ts`）。I/O 标注按外部包名判定时
跳过「派生」调用：接收者本身是调用表达式，或线索是返回值 / 属性链的，只是借了上游包的名字，
例如 `readFileSync(p).split()` 的 `split` 不碰文件。

走读帧里每个未解析调用带一个原因，由线索和调用形状在查询时推出：参数传进来的函数、变量里存的
函数（附上产生它的调用，如 `useT()` / `useState()`）、接在推不出类型的返回值上、接收者推不出类型
（附来源调用或注明是没标类型的参数）、`this` 上的方法在类和父类里都没有。

AI 架构分层的输入不只是目录名：每个候选模块带上行数、对外导出（按被调用次数排）、
用到的外部库、入口，以及模块之间按 `import` / `type` / `http` 区分的依赖方向和次数，
已有的模块摘要一并给出。模型据此按依赖方向自上而下命名分层，只能用给定的模块 id，
编出来的 id 会被丢掉。

## 变更视角

```
git 提交 ──git archive──▶ 临时快照 ──scanRepo(仅结构)──▶ .repolens/baselines/<commit>.db
                                                              │
工作区（或另一个提交）的索引 ─────────────────────────────────┤
                                                              ▼
                                         diffIndexes：文件 / 符号 / 模块依赖 / 外部库
                                                      / 体检 / 入口与影响面
                                                              │
                                    ┌─────────────────────────┴───────────┐
                              repolens diff                       POST /changes
                              （终端报告 / --json）          → 左侧「变更」页 + 图节点角标
```

- 用 `git archive` 而不是 checkout / worktree：不碰用户的工作区和 git 元数据，
  未提交的改动也不会被卷进基线。提交内容不可变，基线按 commit 缓存，只有解析器升级时才重建。
- 基线用当前版本的解析器重扫，两边口径一致：差异里不会混进「解析器升级了」带来的假变化。
- 文件按路径配对，内容哈希相同的「删除 + 新增」认作移动；符号按「文件 + 容器.名字 + 类型」
  配对，同名的按出现顺序，再比内容哈希。
- 影响面：从每个入口沿调用边往下最多走几跳，碰到改过的符号就记下来，回答「哪些入口会走到这次改的代码」。
  入口往下能碰到的 I/O 两边各算一遍，新碰到的（`ioAdded`）是行为面和安全面的变化。
- 行为变化：配对上的函数比较前后的出边——新调了谁、不再调谁、开始碰哪类 I/O。语言内置和派生的
  链式调用（`readFileSync(p).split()` 的 `split`）不算，免得淹没真正的新依赖。
- 改动单元：从没被其他改动调用的上游函数出发，沿调用往下认领改过的函数（最多 3 层、20 个），被 4 个以上
  改动调用的工具函数自成一组，不当桥把不相干的事连起来；类型、常量按文件归组。每组的风险由导出接口、签名变化、
  新 I/O、新调用（每个函数封顶）、复杂度上升、没有测试和走到的入口数加起来，排在最前的最该先看。
- 体检差异里不含隐性耦合和文档过期：它们来自 git 历史，基线快照里没有，比出来全是「新增」。
- 全程不经过模型。审 AI 写的代码时最需要的是一份不会被「解释」掉的客观变化清单。

## 约定

约定写进仓库、随代码提交，CI、界面和 MCP 读的是同一份：

- `.repolens.json`：依赖规则 `rules`、确认过的分层 `layers`、棘轮 `ratchet`
- `.repolens.lock.json`：依赖锁，批准过的模块间依赖（多包仓库按包，单包按 `architectureModules` 认出的目录）
- `.repolens.local.json`：个人覆盖，不提交

规则：`rules` 声明哪些模块不许依赖哪些（仓库内路径 glob、外部包名都可以），`diagnose` 阶段逐条核对已解析到
确定目标的 import，违规作为 `violation` 体检落库，和其他体检一样挂在节点上。

- 只约束源码文件，测试跨层引用被测对象是常态
- `import type` 默认不算违规（共享 DTO 类型不构成运行时耦合），`includeTypeOnly: true` 可以打开
- 报告里给出每条规则命中的文件数：为 0 多半是 glob 写错了，规则等于没生效

另外三类约定体检（`pipeline/conventions.ts`），确认、批准之后只需重算这几类，不必重扫（`refreshConventions`）：

- `unapproved`：模块间依赖不在锁里。AI 顺手加的新依赖要被人看一眼——要么批准（重写锁、进代码评审），要么改掉
- `layering`：确认过的分层里下层依赖上层。分层由 AI 提议、人在界面里确认后才生效，之前只是建议
- `bypass`：绕过对方包在 package.json 里声明的入口，直接引了内部文件。只认 pnpm / npm / yarn 的 JS/TS 包，
  Python、Rust 里直接引子模块是惯用写法；相对路径跨包引用定为高危

`repolens check` 依次跑规则、依赖锁，给了 `--baseline` 时再对基线做一次变更对比，新增的体检问题按 `ratchet`
分成拦下的和只提示的。只拦新长出来的问题，已有的债可以慢慢还。

## 实时刷新

`serve --watch` 或界面里打开「实时」后，服务端用 `fs.watch`（递归）盯着仓库，忽略规则和扫描一致，约定文件
就算被 gitignore 也算。改动停 700ms 后做一次只建结构的增量扫描（在 worker 里，同一仓库串行，扫描中再有改动就
跑完补一次），然后通过 `GET /api/repos/:id/events`（SSE）告诉界面。界面收到后递增 `indexRevision`：
已取过的子图、详情、走读帧、源码、体检原地重取，展开、选中和走读位置都保留；开着的变更报告跟着重算。

## MCP

`repolens mcp` 是一个 stdio 上按行分隔的 JSON-RPC 服务（没有额外依赖），给 AI 编程助手十个只读工具：
`overview`、`conventions`、`module`、`find`、`symbol`、`boundary`、`spec`、`findings`、`changes`、`check`。
输出是给模型读的紧凑文本，每个对象都带节点 id，方便接着查；同名符号不替调用方猜，列出候选。
助手两次调用之间多半改过代码：服务同样盯着文件，有改动就先增量扫描再回答，扫描和读索引排成一队，
不会两次扫描同时写库，也不会读到扫了一半的图。

### 语言能力分层

- **专用分析**：TypeScript / JavaScript、Python、Go、Rust，有语言专属 extractor 和 resolver。
- **复合组件**：Vue、Svelte 的 `<script>` 与 Astro frontmatter 会转成等字节、等换行的虚拟
  JS/TS 源码，因此符号、调用和错误行号仍可直接映射回原文件。
- **通用结构分析**：Java、C/C++、C#、PHP、Ruby、Shell、PowerShell 复用已分发的
  tree-sitter grammar，保守提取声明、调用和 import；没有证据时不猜模块目标。
- **文本源码兜底**：其余已知语言和未知文本仍进入文件图、LOC 统计与文件级 AI 理解；
  只有检测到 NUL 或异常控制字符比例时才按二进制资源隐藏。

`discovery/language.ts` 是唯一语言能力注册表。外部扩展可在扫描前调用
`registerLanguagePlugin({ definition, extractor, resolver })` 一次注册 grammar、专用抽取器和
模块解析器；只需通用抽取时也可调用较低层的 `registerLanguage(...)`。插件 ID 必须使用
`custom:*` 命名空间，且不能覆盖内置 ID 或扩展名。

## 存储

SQLite（`better-sqlite3`），默认落在 `<repo>/.repolens/index.db`。

选 SQLite 而不是单个 JSON 的原因：目标规模是 40 万行 / 1400 文件量级的 monorepo，
全量图 JSON 会到几十 MB，前端一次性加载必然卡。SQLite + HTTP API 让前端**按需拉子图**，
同时天然支持增量写入和后续的 chat 检索。

索引跟着仓库走（而不是集中存在某个全局目录）也是刻意的：它是可重建的派生数据，
跟着仓库才能随仓库一起删掉。代价是没有任何地方知道「这台机器上扫过哪些仓库」，
所以另有一份清单 `~/.repolens/repos.json` 补这个缺口，界面的仓库选择器读它。
清单是便利缓存而非事实来源——状态一律现场探测，解析失败就当空清单。

### 多仓库寻址

API 用 `?repo=<id>` 指定仓库，缺省落到启动时那个。`id` 是绝对路径的短哈希，
定长且 URL 安全。服务端按仓库各持一份只读连接和一个 `createApi` 子应用，
外层中间件按请求分发，所以 `api.ts` 完全不需要知道多仓库的存在；连接数有上限，
超出按最久未用关闭，启动时那个固定驻留。

**可达范围就是安全边界**：只能打开清单里已有的仓库或启动时指定的那个，
API 不接受任意路径。`/source` 会按仓库根读源码，如果允许现场指定路径，
任何能连上这个端口的东西就都能读机器上的任意文件。`/readme` 同理，只按节点 id
在索引里查 README，读到的路径都来自索引。

结构树的 `/files` 和 `/raw` 是例外：它们要列出、读取没进索引的文件，只能收仓库相对路径。
边界收在仓库根以内：拒绝 `..` 和 `.git`、`.repolens` 这类元数据目录，不跟随软链接，
实际路径（realpath）必须仍在仓库根下，防止经由软链接目录绕出去；原文只给 2 MB 以内的文本文件。
代价是被 `.gitignore` 排除的文件（包括 `.env`）也能在界面里打开，和在本机编辑器里打开同一个仓库的可见范围一致。新仓库必须先在本地
`repolens scan` 一次，那是一次显式的本地操作。

追问 AI 的查阅工具（`llm/chat-tools.ts`）由模型发起，而模型读过的文件和网页里可能藏着指令，
所以按「参数不可信」来收：

- **读文件、列目录、全文搜索**走和 `/files`、`/raw` 同一套路径规则，只在仓库根以内；
  搜索跳过依赖目录和被忽略的路径（除非明确指定到那个目录下）、二进制和超过 1 MB 的文件，限时 4 秒。
- **凭据文件不发给模型**：`.env`、私钥、`.npmrc`、`credentials` 这类文件不读、不搜，
  提交差异里只留文件名。界面里照常能打开，挡的只是发往模型服务这一路。
- **git** 只跑 log / show / blame / diff / status 这几条只读命令。提交写法按白名单校验、
  不能以 `-` 开头，路径放在 `--` 之后且不允许 pathspec 魔法；仓库自己的 `.git/config`
  能给 fsmonitor、外部 diff、textconv 配任意命令，调用时一律关掉。输出、耗时都有上限。
- **抓网页**只认 http(s)、不带账号密码的地址。地址校验放在建立连接时的 DNS 解析里做，
  任何一条记录指向本机、内网、链路本地或保留地址就拒绝，避免先查后连之间被 DNS 重绑定换成内网；
  重定向每一跳重新校验，正文解压后最多读 2 MB，15 秒超时。这一项可以单独关掉。
- **预算**：每次回答最多 8 轮查阅、每轮 8 次调用、工具结果累计 12 万字符，单次结果 1.6 万字符，
  到了上限就不再提供工具，让模型用已查到的信息作答。

`chatTools`、`webFetch` 两个开关和服务地址一样只认用户级配置，仓库级配置只能关、不能开。

## 模块解析器要点

### TypeScript / JavaScript
- 说明符候选扩展：`.ts .tsx .d.ts .js .jsx .mjs .cjs` + `/index.*`
- `tsconfig.json` 的 `baseUrl` / `paths`（含 `extends` 链）
- workspace 包名 → 包目录（`package.json` 的 `exports` / `main` / `module` / `types`）
- `import` / `export from` / `require()` / 动态 `import()`
- 符号级：命名导入直接对应导出名；`export *` 需要传递闭包

### Python
- `from .x import y` / `from ..x import y` 相对导入按包层级回溯
- 绝对导入按 source roots（仓库根、`src/`、含 `pyproject.toml` 的目录）尝试
- `__init__.py` 包目录解析；`from pkg import mod` 的模块/符号二义性两边都试

### Go
- `go.mod` 的 `module` 前缀 → 目录映射
- Go 的 import 是**包级**的：`pkg.Func` 先定位包目录，再在该目录所有文件里找导出符号
- 同包内跨文件调用无需 import，判定为 `likely`（候选唯一时）

### Rust
- `mod` 声明构建模块树（`foo.rs` / `foo/mod.rs`）
- `use crate::a::b` / `super::` / `self::` 路径解析
- Cargo workspace members → crate 名映射

## 前端渲染策略

- 图库：`@xyflow/react` v12
- 布局：`elkjs`（分层布局）跑在 Web Worker 里，避免主线程阻塞
- 默认视图节点数控制在 30 以内；超过阈值自动聚合为「其他 N 项」节点
- 所有下钻请求走 API，前端不持有全图

详细交互规范见 [INTERACTION.md](./INTERACTION.md)。
