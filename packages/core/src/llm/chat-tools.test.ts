import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db/database.js";
import type { ChatToolStepDto } from "../types.js";
import { chatToolDefinitions, isSecretPath, runChatTool, type ChatToolContext } from "./chat-tools.js";

let db: Db | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  const identity = ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  return execFileSync("git", ["-C", repo, ...identity, ...args], {
    encoding: "utf8",
  });
}

function setup(options: { git?: boolean } = {}): ChatToolContext & { fileId: number } {
  const repo = mkdtempSync(join(tmpdir(), "repolens-tools-repo-"));
  const configHome = mkdtempSync(join(tmpdir(), "repolens-tools-config-"));
  temporaryDirectories.push(repo, configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);

  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "scripts"));
  mkdirSync(join(repo, "node_modules/dep"), { recursive: true });
  writeFileSync(join(repo, "src/run.ts"), "export function run(input: string) {\n  return input.trim();\n}\n");
  writeFileSync(join(repo, "scripts/deploy.sh"), "#!/bin/sh\necho DEPLOY_TARGET=prod\n");
  writeFileSync(join(repo, "node_modules/dep/index.js"), "DEPLOY_TARGET\n");
  writeFileSync(join(repo, ".env"), "DEPLOY_TARGET=secret-token\n");
  writeFileSync(join(repo, ".env.example"), "DEPLOY_TARGET=\n");
  writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\nindex.db*\n");
  if (options.git) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "initial import");
    writeFileSync(join(repo, "src/run.ts"), "export function run(input: string) {\n  return input.trim().toLowerCase();\n}\n");
    git(repo, "commit", "-q", "-am", "lowercase the input");
    writeFileSync(join(repo, "src/run.ts"), "export function run(input: string) {\n  return input.trim().toLowerCase() || null;\n}\n");
  }

  const opened = openDb(join(repo, "index.db"));
  opened.prepare("INSERT INTO directories (path, parent_path, name, depth) VALUES ('src', NULL, 'src', 1)").run();
  const fileId = Number(opened.prepare(
    `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
     VALUES ('src/run.ts', 'src', 'run.ts', 'typescript', 'source', 3, 60, 'h')`,
  ).run().lastInsertRowid);
  db = opened;
  return {
    db: opened, root: repo, webFetch: true, fileId,
    describeNode: (id) => (id === `file:${fileId}` ? { text: "## File src/run.ts", label: "run.ts" } : null),
  };
}

async function call(ctx: ChatToolContext, name: string, args: unknown) {
  const started: ChatToolStepDto[] = [];
  const outcome = await runChatTool(ctx, "t1", { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }, (step) => started.push(step));
  return { ...outcome, started };
}

describe("isSecretPath", () => {
  it("挡住凭据文件，放行示例模板和普通文件", () => {
    for (const path of [".env", "app/.env.local", "id_rsa", "certs/server.pem", ".npmrc", "config/secrets.yml"]) {
      expect(isSecretPath(path), path).toBe(true);
    }
    for (const path of [".env.example", "id_rsa.pub", "src/env.ts", "README.md", "keyboard.ts"]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });
});

describe("chatToolDefinitions", () => {
  it("关掉网页抓取时不声明 fetch_url", () => {
    expect(chatToolDefinitions(true).map((tool) => tool.function.name)).toContain("fetch_url");
    expect(chatToolDefinitions(false).map((tool) => tool.function.name)).not.toContain("fetch_url");
  });
});

describe("runChatTool", () => {
  it("列目录时包括没进索引的文件，并标出凭据文件", async () => {
    const ctx = setup();
    const { content, step, started } = await call(ctx, "list_files", {});
    expect(started[0]).toMatchObject({ id: "t1", tool: "list_files", status: "running", target: "." });
    expect(step).toMatchObject({ status: "done", target: "." });
    expect(content).toContain("src/  (id=dir:src, 1 source files, 3 LOC)");
    expect(content).toContain("scripts/  (not indexed: added after the last scan)");
    expect(content).toContain("node_modules/  (not indexed: dependency or build directory)");
    expect(content).toMatch(/\.env {2}\(not indexed: ignored by \.gitignore or config\) \[credentials file, hidden from you\]/);
  });

  it("按行读文件，索引外的文件给出 raw 节点", async () => {
    const ctx = setup();
    const indexed = await call(ctx, "read_file", { path: `file:${ctx.fileId}`, start_line: 2, end_line: 2 });
    expect(indexed.content).toContain(`File src/run.ts (id=file:${ctx.fileId}) · 3 lines · L2–2`);
    expect(indexed.content).toContain("2|   return input.trim();");
    expect(indexed.content).toContain("continue with start_line=3");
    expect(indexed.step).toMatchObject({ nodeId: `file:${ctx.fileId}`, lines: [2, 2] });

    const raw = await call(ctx, "read_file", { path: "./scripts/deploy.sh" });
    expect(raw.content).toContain("2| echo DEPLOY_TARGET=prod");
    expect(raw.step).toMatchObject({ nodeId: "raw:scripts/deploy.sh", lines: [1, 2] });
  });

  it("不读凭据文件、仓库外和版本库元数据", async () => {
    const ctx = setup();
    for (const path of [".env", "../outside.txt", ".git/config", "/etc/passwd"]) {
      const { content, step } = await call(ctx, "read_file", { path });
      expect(content, path).toMatch(/^Error: /);
      expect(step?.status).toBe("error");
    }
    expect((await call(ctx, "read_file", { path: ".env" })).step?.error).toBe(".env 看起来是密钥或凭据文件，不发给模型");
  });

  it("全文搜索跳过依赖目录和凭据文件，可以按 glob 过滤", async () => {
    const ctx = setup();
    const all = await call(ctx, "search_code", { query: "DEPLOY_TARGET" });
    expect(all.content).toContain("scripts/deploy.sh\n  2: echo DEPLOY_TARGET=prod");
    expect(all.content).toContain(".env.example\n  1: DEPLOY_TARGET=");
    expect(all.content).not.toContain("secret-token");
    expect(all.content).not.toContain("node_modules");

    const scoped = await call(ctx, "search_code", { query: "deploy_target", glob: "*.sh" });
    expect(scoped.content).toMatch(/^1 matches in 1 files/);

    const regex = await call(ctx, "search_code", { query: "input\\.trim\\(\\)", regex: true });
    expect(regex.content).toContain(`src/run.ts (id=file:${ctx.fileId})`);

    const inDependency = await call(ctx, "search_code", { query: "DEPLOY_TARGET", path: "node_modules/dep" });
    expect(inDependency.content).toContain("node_modules/dep/index.js");
  });

  it("查节点时用对话模块给的描述", async () => {
    const ctx = setup();
    expect((await call(ctx, "get_node", { id: `file:${ctx.fileId}` })).step).toMatchObject({ target: "run.ts", nodeId: `file:${ctx.fileId}` });
    expect((await call(ctx, "get_node", { id: "../etc" })).content).toMatch(/^Error: 不认识的节点 id/);
  });

  it("读 git 历史、单次提交、逐行追溯和未提交的改动", async () => {
    const ctx = setup({ git: true });
    const log = await call(ctx, "git_log", { path: "src/run.ts", name_status: true });
    expect(log.content).toMatch(/^[0-9a-f]{7,} \d{4}-\d{2}-\d{2} Tester\tlowercase the input/);
    expect(log.content).toContain("M\tsrc/run.ts");
    expect((await call(ctx, "git_log", { query: "INITIAL" })).content).toContain("initial import");

    const show = await call(ctx, "git_show", { ref: "HEAD" });
    expect(show.content).toContain("+  return input.trim().toLowerCase();");
    const before = await call(ctx, "git_show", { ref: "HEAD~1", path: "src/run.ts", whole_file: true });
    expect(before.content).toContain("2|   return input.trim();");

    const blame = await call(ctx, "git_blame", { path: "src/run.ts", start_line: 1, end_line: 2 });
    expect(blame.content).toContain("Tester");
    expect(blame.step).toMatchObject({ nodeId: `file:${ctx.fileId}`, lines: [1, 2] });

    const diff = await call(ctx, "git_diff", {});
    expect(diff.content).toContain("## main");
    expect(diff.content).toContain("+  return input.trim().toLowerCase() || null;");
  });

  it("提交写法不能夹带选项，凭据文件的差异只留文件名", async () => {
    const ctx = setup({ git: true });
    for (const ref of ["--output=/tmp/pwned", "HEAD;rm -rf /", "a b"]) {
      expect((await call(ctx, "git_show", { ref })).content, ref).toMatch(/^Error: 不支持的提交写法/);
    }
    writeFileSync(join(ctx.root, ".gitignore"), "node_modules/\nindex.db*\n");
    git(ctx.root, "add", ".env", ".gitignore");
    git(ctx.root, "commit", "-q", "-m", "oops, committed env");
    const show = await call(ctx, "git_show", { ref: "HEAD" });
    expect(show.content).toContain("diff --git a/.env b/.env\n(changes hidden: credentials file)");
    expect(show.content).not.toContain("secret-token");
  });

  it("不在 git 里时给出可读的原因", async () => {
    const ctx = setup();
    vi.stubEnv("GIT_CEILING_DIRECTORIES", tmpdir());
    const { step } = await call(ctx, "git_log", {});
    expect(step).toMatchObject({ status: "error", error: "这个仓库没有用 git 管理" });
  });

  it("网页抓取关闭、工具不存在或参数不是 JSON 时如实回给模型", async () => {
    const ctx = { ...setup(), webFetch: false };
    expect((await call(ctx, "fetch_url", { url: "https://example.com" })).content).toBe("Error: 网页抓取已在设置里关闭");
    const unknown = await call(ctx, "rm_rf", {});
    expect(unknown.step).toBeNull();
    expect(unknown.content).toMatch(/^Error: unknown tool "rm_rf"/);
    const broken = await runChatTool(ctx, "t2", { id: "c2", type: "function", function: { name: "read_file", arguments: "{path:" } });
    expect(broken).toMatchObject({ content: "Error: 工具参数不是合法的 JSON", step: { status: "error", tool: "read_file" } });
  });
});
