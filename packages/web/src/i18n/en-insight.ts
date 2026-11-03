import type { Translation } from "./index";
import { count, counted, plural } from "./plural";

/**
 * Clearly understand, thoroughly grasp, and maintain the English for this set of functions: edge as contract, module business card, test as specification, change history,
 * Perspective, walkthrough skeleton, change review, and agreement. The key is the Chinese original text on the interface.
 */
export const EN_INSIGHT: Record<string, Translation> = {
  // Canvas and Perspective
  "依赖方向：使用方 ↓ 被依赖方 · 点边看由什么构成": "Dependency direction: user ↓ dependency · click an edge to see what it's made of",
  "有测试走到的函数": "Functions reached by tests",
  "近 90 天改得越勤越长": "Longer = changed more in the last 90 days",
  "近 90 天 {recent} 次提交 · 近一年 {commits} 次 · AI 参与 {ai} 次": (params) =>
    `${count(params, "recent")} ${plural(params, "commit", "commits", "recent")} in 90 days · ${count(params, "commits")} in a year · ${count(params, "ai")} AI-assisted`,
  "测试走到 {covered}/{total} 个函数": "Tests reach {covered}/{total} functions",
  "改动热度": "Change heat",
  "视角": "Lens",
  "在节点底边叠一条细条：改得勤不勤、测到了几成": "Adds a thin bar under each node: how often it changes, how much is tested",
  "给图上每个节点的底边叠一条细条": "Draws a thin bar along the bottom of every node",
  "近 90 天改得越勤，条越长越红": "The busier in the last 90 days, the longer and redder the bar",
  "有测试走到的函数占几成": "Share of functions reached by tests",
  "不叠加": "Off",

  // Top bar
  "只算参与分析的源码；连同测试、文档、配置共 {loc} 行": "Source code only; {loc} lines including tests, docs and config",
  "源码 {loc} 行": counted("source line", "source lines", "loc"),
  "文件监视出错：{error}": "File watching failed: {error}",
  "盯着文件变化：改动后自动刷新结构索引": "Watching files: the structure index refreshes after every change",
  "跳过提前 return / throw 的守卫分支和 catch，先把正常流程读通": "Skip guard branches that return or throw early and catch blocks; read the normal flow first",
  "主路径": "Main path",
  "实时": "Live",
  "刷新中…": "Refreshing…",

  // Physical examination
  "当前检查项：跨文件的重复实现、循环依赖、读不动的过大函数和文件、.repolens.json 里的依赖规则和分层、依赖锁之外的新依赖、绕过包入口的引用、总是一起改却没有依赖的文件、指向已删除文件的文档。":
    "Checks: duplicate implementations across files, dependency cycles, oversized functions and files, the rules and layers in .repolens.json, new dependencies outside the lock, imports that bypass a package entry, files that always change together without a dependency, and docs pointing to deleted files.",
  "所在文件近 90 天改过 {count} 次：改得勤的地方先修": (params) =>
    `Its file changed ${count(params)} ${plural(params, "time", "times")} in the last 90 days; fix busy places first`,
  "近 90 天 {count} 次": (params) => `${count(params)}× in 90 days`,
  "分层倒置 {count}": "Layering {count}",
  "未批准依赖 {count}": "Unapproved {count}",
  "绕过入口 {count}": "Bypass {count}",
  "隐性耦合 {count}": "Hidden coupling {count}",
  "文档过期 {count}": "Stale docs {count}",

  // Edge is contract
  "看反方向的依赖": "See the dependency in the other direction",
  "这条依赖由什么构成。左边用到的名字就是两边之间的契约：改它们的签名，右边要跟着改。":
    "What this dependency is made of. The names used are the contract between the two sides: change their signatures and the other side has to follow.",
  "绕过入口": "Bypasses entry",
  "没有直接依赖": "No direct dependency",
  "最短的一条间接 import 链：": "Shortest indirect import chain:",
  "直接的、间接的都没有：两边在代码里互不相关": "Neither direct nor indirect: the two sides are unrelated in code",
  "用到的名字 ({count})": "Names used ({count})",
  "只 import": "import only",
  "{calls} 次 · {callers} 处": (params) =>
    `${count(params, "calls")} ${plural(params, "call", "calls", "calls")} · ${count(params, "callers")} ${plural(params, "caller", "callers", "callers")}`,
  "绕过了对方包的入口，直接引了内部文件": "Bypasses the package entry and imports an internal file",
  "HTTP 请求 ({count})": "HTTP requests ({count})",

  // AI text implementation
  "在代码里对上了，点击查看": "Found in the code; click to open",
  "代码里找不到这个名字，可能是模型编的": "This name isn't in the code; the model may have made it up",
  "有 {count} 个名字在代码里找不到，可能是模型编的，以代码为准": (params) =>
    `${count(params)} ${plural(params, "name isn't", "names aren't")} in the code and may be made up; trust the code`,

  // Change History
  "改动历史（近一年）": "History (last 12 months)",
  "最近 {date}": "Last {date}",
  "提交": "Commits",
  "近 90 天": "90 days",
  "作者": "Authors",
  "AI 参与": "AI-assisted",
  "常和它一起改的文件": "Files that often change with it",
  "{count} 次": (params) => `${count(params)}×`,
  "两者在代码里没有直接依赖，却总是一起改：可能藏着隐性约定": "No direct dependency in code, yet they always change together: there may be a hidden contract",
  "无依赖": "no link",

  // Module Business Card
  "确认过的分层": "Confirmed layer",
  "AI 提议的分层，还没有人确认": "Layer proposed by AI, not yet confirmed",
  "{count} 个函数直接做这类 I/O": (params) => `${count(params)} ${plural(params, "function does", "functions do")} this I/O directly`,
  "它依赖 ({count})": "Depends on ({count})",
  "依赖它的 ({count})": "Used by ({count})",
  "外部库 ({count})": "External libraries ({count})",
  "{count} 个文件引用": counted("file uses it", "files use it"),
  "对外接口 ({count})": "Public interface ({count})",
  "全部": "All",
  "模块外没有用到它的任何符号": "Nothing outside the module uses any of its symbols",
  "{count} 处调用方": counted("caller", "callers"),
  "按模块外的调用方数排。接口没变，内部怎么改都不影响用它的人。":
    "Sorted by callers outside the module. As long as the interface holds, internal changes don't affect its users.",
  "看这条依赖由什么构成": "See what this dependency is made of",
  "{count} 条 import": counted("import", "imports"),
  "入口 ({count})": "Entry points ({count})",
  "从这里开始单步走读": "Start stepping through from here",
  "改动热点": "Hotspots",
  "近一年 {commits} 次提交，近 90 天 {recent} 次，{ai} 次标明有 AI 参与": (params) =>
    `${count(params, "commits")} ${plural(params, "commit", "commits", "commits")} in a year, ${count(params, "recent")} in 90 days, ${count(params, "ai")} marked AI-assisted`,
  "改得勤又复杂的地方最容易出问题，也最值得先看懂": "Busy, complex code breaks most often and is the most worth understanding first",
  "复杂度 {count}": "Complexity {count}",

  // Skeleton
  "核心数据结构": "Core data structures",
  "{count} 个函数用到": (params) => `used by ${count(params)} ${plural(params, "function", "functions")}`,
  "按在函数签名里出现的次数排：参数和返回值里总是它，它就是系统在搬运的东西":
    "Sorted by how often they appear in function signatures: what keeps showing up in parameters and return values is what the system moves around",
  "数据表 ({count})": "Tables ({count})",
  "读 {reads} · 写 {writes}": "read {reads} · write {writes}",
  "写": "write",
  "读": "read",

  // Testing is specification
  "描述它的测试": "Tests that describe it",
  "没有测试用例沿调用关系走得到它。改它时没有测试会替你发现回归。": "No test case reaches it through calls. If you change it, no test will catch a regression.",
  "描述它的测试 ({count})": "Tests that describe it ({count})",
  "全部用例": "All cases",
  "直接调用": "direct call",
  "隔 {count} 层": (params) => `${count(params)} ${plural(params, "level", "levels")} away`,
  "其中 {direct} 个直接调用它。用例标题就是人写下的预期行为。": (params) =>
    `${count(params, "direct")} of them call it directly. Test titles are the behavior people wrote down as expected.`,
  "测试覆盖": "Test coverage",
  "看规格": "View spec",
  "{covered}/{total} 个函数 · {share}": "{covered}/{total} functions · {share}",
  "{count} 个测试用例沿调用走得到这里（静态推算，不是运行时覆盖率）": (params) =>
    `${count(params)} test ${plural(params, "case reaches", "cases reach")} this through calls (static estimate, not runtime coverage)`,
  "没有测试用例沿调用走得到这里": "No test case reaches this through calls",
  "正在整理用例…": "Collecting test cases…",
  "走到 {names}": "Reaches {names}",
  "直接": "direct",
  "测试用例": "Test case",
  "测试用例组": "Test suite",
  "标题是人写下的预期行为；单步走读能看到它实际调了什么": "The title is the expected behavior written by a person; step through it to see what it actually calls",

  // Type stream
  "它在代码里怎么流动": "How it flows through the code",
  "{count} 个文件 import 它": (params) => `${count(params)} ${plural(params, "file imports", "files import")} it`,
  "没有函数在签名里用到它，也没有地方创建它": "No function uses it in a signature and nothing creates it",
  "创建它": "Created by",
  "返回它": "Returned by",
  "接收它": "Accepted by",
  "实现或继承它": "Implemented or extended by",

  // Agreement
  "约定": "Conventions",
  "分层": "Layers",
  "还没有": "none yet",
  "已确认": "confirmed",
  "AI 提议，未确认": "AI proposal, unconfirmed",
  "{count} 处倒置": (params) => `${count(params)} ${plural(params, "inversion", "inversions")}`,
  "调整": "Adjust",
  "确认…": "Confirm…",
  "确认后写进 .repolens.json：自上而下排好，下层依赖上层就算分层倒置，CI 里的 repolens check 也会拦。":
    "Once confirmed it's written to .repolens.json, top to bottom. A lower layer depending on a higher one is a layering inversion, and repolens check in CI will block it.",
  "依赖锁": "Dependency lock",
  "{count} 条批准过的依赖": counted("approved dependency", "approved dependencies"),
  "{count} 条未批准": counted("unapproved", "unapproved"),
  "写入中…": "Writing…",
  "批准现在的依赖": "Approve current dependencies",
  "锁定现在的依赖": "Lock current dependencies",
  "锁里没有的模块间依赖会出现在体检里。确认合理再批准：会重写 .repolens.lock.json，批准本身出现在代码评审里。":
    "Module dependencies missing from the lock show up as findings. Approve only after checking: this rewrites .repolens.lock.json, so the approval shows up in code review.",
  "把现在的模块间依赖写进 .repolens.lock.json 并提交。之后 AI 顺手加出来的新依赖都会被体检和 repolens check 拦下。":
    "Write the current module dependencies into .repolens.lock.json and commit it. New dependencies an AI adds along the way will then be flagged and blocked by repolens check.",
  "{count} 处违反依赖规则": (params) => `${count(params)} dependency rule ${plural(params, "violation", "violations")}`,
  "自上而下：上层可以依赖下层，反过来算分层倒置": "Top to bottom: upper layers may depend on lower ones; the reverse is an inversion",
  "分层名": "Layer name",
  "上移": "Move up",
  "下移": "Move down",
  "从这一层移除": "Remove from this layer",
  "没有成员的层不会保存": "Layers without members aren't saved",
  "确认，写进 .repolens.json": "Confirm and write to .repolens.json",

  // Change Review
  "没测试": "untested",
  "对外接口": "public API",
  "签名变化": "signature",
  "新 I/O": "new I/O",
  "新调用": "new calls",
  "复杂度上升": "more complex",
  "走到入口": "reaches entry points",
  "改动单元": "Change groups",
  "沿调用关系把改动归成组：一组就是一件事。风险高的在前": "Changes grouped along calls: one group is one piece of work. Riskiest first",
  "风险 {risk}：{count} 处改动": (params) => `Risk ${String(params["risk"] ?? "")}: ${count(params)} ${plural(params, "change", "changes")}`,
  "行为变化": "Behavior changes",
  "新调了谁、开始碰哪类 I/O：比行数更能说明这次改动做了什么": "What it now calls and what I/O it now touches: says more about a change than line counts",
  "新调 {names}": "Now calls {names}",
  "不再调 {names}": "No longer calls {names}",
  "新调": "now calls",
  "不再调": "no longer calls",
  "新碰 {io}": "+{io}",
  "不再碰 {io}": "−{io}",
  "改了但没有测试走到": "Changed but not reached by tests",
  "沿调用关系静态推算：没有任何测试用例走得到这些函数": "Static estimate along calls: no test case reaches these functions",
  "把工作区此刻的改动收进索引再对比（只刷新结构，不调用模型）": "Index the working tree as it is now, then compare (structure only, no model calls)",
  "正在收进改动…": "Indexing changes…",
  "正在对比…": "Comparing…",
  "重新扫描并对比": "Rescan and compare",
  "盯着文件变化：AI 改一处，结构索引和这份报告跟着更新": "Watch files: when an AI edits something, the index and this report update",

  // Details
  "源码行": "Source lines",
  "源码文件": "Source files",
  "连同测试、文档、配置共 {loc} 行、{files} 个文件": (params) =>
    `${count(params, "loc")} ${plural(params, "line", "lines", "loc")} and ${count(params, "files")} ${plural(params, "file", "files", "files")} including tests, docs and config`,
  "近一年 {commits} 次提交，{ai} 次标明有 AI 参与": (params) =>
    `${count(params, "commits")} ${plural(params, "commit", "commits", "commits")} in a year, ${count(params, "ai")} marked AI-assisted`,
  "还没有笔记。直接在上面写，或在追问 AI 的回答里划选文字、点「记笔记」。":
    "No notes yet. Write one above, or select text in an AI answer and click “Save note”.",

  // Casual Notes
  "随手记一笔：这段在干什么、为什么这么写、要小心什么": "Jot a note: what this does, why it's written this way, what to watch out for",
  "记下": "Save",
  "保存中…": "Saving…",
  "{shortcut} 保存 · 在哪都能按 N 记一笔": "{shortcut} to save · press N anywhere to jot a note",

  // Gesture instructions
  "单击边": "Click an edge",
  "看这条依赖由什么构成：引了哪些文件、用了哪些名字、有没有绕过包入口": "See what the dependency is made of: which files, which names, and whether it bypasses a package entry",
  "随手记一笔：记在选中的节点上，没选中就记在整个仓库上": "Jot a note on the selected node, or on the whole repository when nothing is selected",
  "顶栏的「视角」在节点底边叠一条细条：近 90 天改得勤不勤、测试走到了几成。":
    "The Lens menu in the top bar adds a thin bar under each node: how busy it was in the last 90 days and how much tests reach.",

  // Walk-in skeleton
  "同一块里还在第 {lines} 行调了它": "Also called in this block on line(s) {lines}",
  "旁路": "side",
  "写 {table}": "write {table}",
  "读 {table}": "read {table}",
  "折叠了 {count} 处计时、日志类的旁路调用": (params) =>
    `${count(params)} timing or logging ${plural(params, "call", "calls")} folded`,
  "收起计时、日志类的旁路调用": "Fold timing and logging calls",
  "只看主路径：另有 {count} 处在守卫分支或 catch 里": (params) =>
    `Main path only: ${count(params)} more ${plural(params, "call", "calls")} in guard branches or catch blocks`,
  "这个分支以 return / throw 收尾：主路径不会走进来": "This branch ends in return or throw: the main path never enters it",
  "守卫": "guard",
  "传给 {name} 的回调": "callback passed to {name}",
  "回调": "callback",
  "SQL 里的表：": "Tables in SQL:",
  "{name} 只是把调用转给 {target}，直接进去看真正干活的那个": "{name} only forwards to {target}; go straight to the function doing the work",
  "直接进 {name}": "Go to {name}",
  "{count} 个测试走得到": (params) => `${count(params)} ${plural(params, "test reaches", "tests reach")} it`,
  "没有测试走到": "No test reaches it",

  // Server-side error
  "认不出这两个节点": "Couldn't recognize these two nodes",
  "只有包和目录有模块名片": "Only packages and folders have module cards",
  "不是类型": "Not a type",
  "未知的视角": "Unknown lens",
  "分层格式不正确：每层要有名字和至少一个 pkg: / dir: 成员": "Invalid layers: each layer needs a name and at least one pkg: or dir: member",
  "缺少本地写操作标记": "Missing the local write marker",
};

/** Error with embedded path */
export const EN_INSIGHT_PATTERNS: Array<[RegExp, (...groups: string[]) => string]> = [
  [/^依赖锁解析失败：(.+)$/s, (detail) => `Couldn't parse the dependency lock: ${detail}`],
  [/^依赖锁格式不对：(.+)$/s, (path) => `The dependency lock has an invalid format: ${path}`],
  [/^RepoLens 配置里的 layers 必须是数组：(.+)$/s, (path) => `"layers" in the RepoLens config must be an array: ${path}`],
  [/^RepoLens 配置里第 (\d+) 个分层缺少 name 或 members.*：(.+)$/s, (n, path) => `Layer ${n} in the RepoLens config is missing "name" or "members": ${path}`],
];
