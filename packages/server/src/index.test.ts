import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "@repolens/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER, startServer, type RunningServer } from "./index.js";

let home: string;
let server: RunningServer | null = null;
/** Simulated OpenAI-compatible model service */
let llm: Server | null = null;

// The repository list is in ~/.repolens/repos.json, os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "repolens-server-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(async () => {
  await server?.close();
  server = null;
  await new Promise<void>((resolve) => (llm ? llm.close(() => resolve()) : resolve()));
  llm = null;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("startServer", () => {
  it("不指定仓库也能启动，缺省请求提示先打开仓库", async () => {
    server = await startServer({ repoRoot: null, port: 0 });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

    expect(await (await fetch(`${server.url}/api/repos`)).json()).toEqual({ current: null, repos: [] });
    const overview = await fetch(`${server.url}/api/overview`);
    expect(overview.status).toBe(404);
    expect(await overview.json()).toEqual({ error: "还没有打开任何仓库" });
  });

  it("设置访问令牌后接口只接受带令牌的请求，静态页面不受影响", async () => {
    const webRoot = join(home, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>RepoLens</title>");
    server = await startServer({ repoRoot: null, port: 0, webRoot, accessToken: "secret-token" });
    const status = async (headers: Record<string, string> = {}) =>
      (await fetch(`${server!.url}/api/repos`, { headers })).status;

    expect(await status()).toBe(401);
    expect(await status({ [ACCESS_TOKEN_HEADER]: "secret-tokeX" })).toBe(401);
    expect(await status({ [ACCESS_TOKEN_HEADER]: "secret-token" })).toBe(200);
    expect(await status({ cookie: `${ACCESS_TOKEN_COOKIE}=secret-token` })).toBe(200);
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/some/spa/route`)).text()).toContain("<title>RepoLens</title>");
  });

  it("目录选择器可以由调用方替换", async () => {
    const pickDirectory = vi.fn(async () => null);
    server = await startServer({ repoRoot: null, port: 0, pickDirectory });
    const response = await fetch(`${server.url}/api/repos/pick-and-scan`, {
      method: "POST",
      headers: { "x-repolens-intent": "scan-repository" },
    });
    expect(await response.json()).toEqual({ cancelled: true });
    expect(pickDirectory).toHaveBeenCalledOnce();
  });

  it("笔记写请求必须带意图标记，保存后按路径读回；仓库挪过位置也写在新位置", async () => {
    const scanned = join(home, "scanned");
    mkdirSync(join(scanned, "src"), { recursive: true });
    writeFileSync(join(scanned, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
    await scanRepo({ root: scanned });
    const repo = join(home, "repo");
    renameSync(scanned, repo);
    server = await startServer({ repoRoot: repo, port: 0 });
    const hit = (await (await fetch(`${server.url}/api/search?q=a.ts`)).json()) as Array<{ id: string }>;
    const fileId = hit.find((item) => item.id.startsWith("file:"))!.id;
    const save = (headers: Record<string, string>) =>
      fetch(`${server!.url}/api/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ nodeId: fileId, lines: [2, 2], text: "返回 1" }),
      });

    expect((await save({})).status).toBe(403);
    const saved = (await (await save({ "x-repolens-intent": "save-note" })).json()) as { id: string };
    const listed = await (await fetch(`${server.url}/api/notes`)).json();
    expect(listed).toMatchObject({
      notes: [{ id: saved.id, nodeId: fileId, target: { kind: "file", path: "src/a.ts", lines: [2, 2] } }],
    });
    expect(existsSync(join(repo, ".repolens", "notes.json"))).toBe(true);
    expect(existsSync(scanned)).toBe(false);

    const remove = (headers: Record<string, string>) =>
      fetch(`${server!.url}/api/notes/${saved.id}`, { method: "DELETE", headers });
    expect((await remove({})).status).toBe(403);
    expect((await remove({ "x-repolens-intent": "save-note" })).status).toBe(200);
    expect(await (await fetch(`${server.url}/api/notes`)).json()).toEqual({ notes: [] });
  });

  it("变更对比要求意图标记；非 git 仓库和可疑的提交写法返回 400", async () => {
    const repo = join(home, "plain");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const compare = (base: string, headers: Record<string, string> = { "x-repolens-intent": "compare-changes" }) =>
      fetch(`${server!.url}/api/changes?base=${encodeURIComponent(base)}`, { method: "POST", headers });

    expect((await compare("HEAD", {})).status).toBe(403);
    const plain = await compare("HEAD");
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({ error: "不是 git 仓库，没法按提交对比" });
    const injected = await compare("--output=/tmp/x");
    expect(injected.status).toBe(400);
    expect(((await injected.json()) as { error: string }).error).toMatch(/^不支持的提交写法/);
  });

  it("README 跟着扫描入索引，按包或目录读回；没有时返回 null", async () => {
    const repo = join(home, "readme");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "# Demo\n\nWhy this repo exists.\n");
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const readme = (node: string) =>
      fetch(`${server!.url}/api/readme?node=${encodeURIComponent(node)}`).then((response) => response.json());

    expect(await readme("dir:.")).toMatchObject({
      path: "README.md", format: "markdown", content: "# Demo\n\nWhy this repo exists.\n", truncated: false,
    });
    expect(await readme("dir:src")).toBeNull();
  });

  it("结构树按磁盘列出没进索引的文件，原文可读；越界路径返回 400", async () => {
    const repo = join(home, "files");
    mkdirSync(join(repo, "dist"), { recursive: true });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeFileSync(join(repo, "dist/out.js"), "console.log(1);\n");
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const get = (path: string) => fetch(`${server!.url}/api${path}`);

    const tree = (await (await get("/files?path=.")).json()) as { children: Array<Record<string, unknown>> };
    expect(tree.children.find((node) => node.name === "src")).toMatchObject({ status: "analyzed" });
    expect(tree.children.find((node) => node.name === "dist")).toMatchObject({
      id: "raw:dist", status: "excluded", excludedBy: "ignored",
    });
    expect(await (await get("/raw?path=dist/out.js")).json()).toMatchObject({ code: "console.log(1);\n" });
    const escaped = await get(`/raw?path=${encodeURIComponent("../files/src/a.ts")}`);
    expect(escaped.status).toBe(400);
    expect(await escaped.json()).toEqual({ error: "非法的路径" });
  });

  it("追问时把模型查阅的每一步作为 tool 事件流给页面", async () => {
    const repo = join(home, "chat");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    writeFileSync(join(repo, "NOTES.txt"), "release on fridays\n");
    await scanRepo({ root: repo });

    let requests = 0;
    llm = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        requests++;
        const events = requests === 1
          ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"NOTES.txt"}' } }] } }] }]
          : [{ choices: [{ delta: { content: "周五发布。" } }] }];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => llm!.listen(0, "127.0.0.1", resolve));
    const configDir = join(home, ".config", "repolens");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({
      llm: { baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, apiKeyEnv: "", model: "mock", maxRetries: 0 },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));

    server = await startServer({ repoRoot: repo, port: 0 });
    const response = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-repolens-intent": "chat" },
      body: JSON.stringify({ messages: [{ role: "user", content: "什么时候发布？" }] }),
    });
    const events = (await response.text()).split("\n\n").filter(Boolean).map((block) => ({
      event: /^event: (.+)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") as Record<string, unknown>,
    }));
    expect(events.map((item) => item.event)).toEqual(["context", "tool", "tool", "delta", "done"]);
    expect(events[1]?.data).toMatchObject({ id: "t1", tool: "read_file", target: "NOTES.txt", status: "running" });
    expect(events[2]?.data).toMatchObject({ id: "t1", status: "done", nodeId: expect.stringMatching(/^file:\d+$/), lines: [1, 1] });
    expect(events[3]?.data).toEqual({ text: "周五发布。" });
    expect(events[4]?.data).toMatchObject({ model: "mock", usage: { requests: 2 } });
  });

  it("确认分层、批准依赖都要带意图标记；确认分层写进约定并就地重算倒置", async () => {
    const repo = join(home, "mono");
    const files: Record<string, string> = {
      ".repolens.json": JSON.stringify({ llm: { enabled: false } }),
      "package.json": JSON.stringify({ name: "mono", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/a/package.json": JSON.stringify({ name: "a", main: "src/index.ts" }),
      "packages/a/src/index.ts": "import { b } from 'b';\nexport function a() { return b(); }\n",
      "packages/b/package.json": JSON.stringify({ name: "b", main: "src/index.ts" }),
      "packages/b/src/index.ts": "export function b() { return 1; }\n",
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const post = (path: string, intent: string | null, body: unknown) => fetch(`${server!.url}/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(intent ? { "x-repolens-intent": intent } : {}) },
      body: JSON.stringify(body),
    });

    // b is on the upper layer, a is on the lower layer: a → b is an inversion
    const layers = [{ name: "上", members: ["pkg:b"] }, { name: "下", members: ["pkg:a"] }];
    expect((await post("/layers/confirm", null, { layers })).status).toBe(403);
    expect((await post("/layers/confirm", "confirm-layers", { layers })).status).toBe(200);
    expect(existsSync(join(repo, ".repolens.json"))).toBe(true);
    const findings = await (await fetch(`${server.url}/api/findings?kind=layering`)).json() as { items: Array<{ title: string }> };
    expect(findings.items.map((f) => f.title)).toEqual(["分层倒置：「下」的 a 依赖了上层「上」的 b"]);

    expect(await (await post("/lock", "write-lock", {})).json()).toEqual({ level: "package", dependencies: 1 });
    expect(existsSync(join(repo, ".repolens.lock.json"))).toBe(true);
    const card = await (await fetch(`${server.url}/api/module?node=pkg:a`)).json() as { dependsOn: Array<{ id: string }> };
    expect(card.dependsOn.map((d) => d.id)).toEqual(["pkg:b"]);
    const boundary = await (await fetch(`${server.url}/api/boundary?from=pkg:a&to=pkg:b`)).json() as { symbols: Array<{ name: string }> };
    expect(boundary.symbols.map((s) => s.name)).toEqual(["b"]);
  });

  it("盯着文件变化：改动后自动刷新结构索引，并通过事件告诉界面", async () => {
    const repo = join(home, "watched");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const { current } = await (await fetch(`${server.url}/api/repos`)).json() as { current: string };
    const toggle = await fetch(`${server.url}/api/repos/${current}/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-repolens-intent": "watch-repository" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(await toggle.json()).toMatchObject({ enabled: true });

    const events = await fetch(`${server.url}/api/repos/${current}/events`);
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    writeFileSync(join(repo, "src/b.ts"), "export function b() { return 2; }\n");
    let seen = "";
    const deadline = Date.now() + 20_000;
    while (!seen.includes("event: index") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    await reader.cancel();
    expect(seen).toContain("event: index");
    const hits = await (await fetch(`${server.url}/api/search?q=b.ts`)).json() as Array<{ id: string }>;
    expect(hits.some((item) => item.id.startsWith("file:"))).toBe(true);
  }, 30_000);
});
