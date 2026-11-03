import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, globalConfigPath, loadConfig, loadLock, updateRepoConfig, writeLock } from "./config.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

describe("loadConfig", () => {
  it("按默认值、全局配置、仓库配置的顺序继承", () => {
    const configHome = tempDir("repolens-global-config-");
    const repo = tempDir("repolens-config-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      maxNodesPerView: 44,
      roleOverrides: { "legacy/**": "generated", "bad/**": "unknown" },
      llm: {
        baseUrl: "http://127.0.0.1:8317/v1/",
        model: "global-model",
        apiKeyEnv: "SHARED_KEY",
        maxConcurrency: 7,
      },
    }));
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({
      exclude: ["fixtures/**"],
      roleOverrides: { "runtime/**/*.json": "source" },
      llm: { model: "repo-model", enabled: false },
    }));

    const config = loadConfig(repo);
    expect(globalConfigPath()).toBe(join(configHome, "repolens/config.json"));
    expect(config.exclude).toEqual(["fixtures/**"]);
    expect(config.maxNodesPerView).toBe(44);
    expect(config.roleOverrides).toEqual({
      "legacy/**": "generated",
      "runtime/**/*.json": "source",
    });
    expect(config.llm).toMatchObject({
      baseUrl: "http://127.0.0.1:8317/v1",
      model: "repo-model",
      apiKeyEnv: "SHARED_KEY",
      maxConcurrency: 7,
      enabled: false,
    });
    expect(config.llm.requestTimeoutMs).toBe(DEFAULT_CONFIG.llm.requestTimeoutMs);
  });

  it("仓库级配置不能改服务地址和 key 变量名", () => {
    const configHome = tempDir("repolens-global-config-");
    const repo = tempDir("repolens-config-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: { baseUrl: "https://llm.example.com/v1", apiKeyEnv: "SHARED_KEY" },
    }));
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({
      llm: { baseUrl: "https://attacker.example/v1", apiKeyEnv: "AWS_SECRET_ACCESS_KEY", model: "repo-model" },
    }));

    expect(loadConfig(repo).llm).toMatchObject({
      baseUrl: "https://llm.example.com/v1",
      apiKeyEnv: "SHARED_KEY",
      model: "repo-model",
    });
  });

  it("没有任何配置时使用独立的默认值副本", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempDir("repolens-empty-config-"));
    const first = loadConfig(tempDir("repolens-empty-repo-"));
    first.exclude.push("changed");
    const second = loadConfig(tempDir("repolens-empty-repo-"));
    expect(second).toEqual(DEFAULT_CONFIG);
  });

  it("解析失败时报告具体配置路径", () => {
    const configHome = tempDir("repolens-bad-config-");
    const repo = tempDir("repolens-bad-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    const path = join(configHome, "repolens/config.json");
    writeFileSync(path, "{ bad json");
    expect(() => loadConfig(repo)).toThrow(path);
  });

  it("仓库里的约定在下、个人覆盖在上；个人覆盖同样不能改服务地址", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempDir("repolens-local-config-"));
    const repo = tempDir("repolens-local-repo-");
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({
      rules: [{ from: "web/**", disallow: ["server/**"] }],
      layers: [{ name: "界面", members: ["dir:web"] }, { name: "服务", members: ["dir:server"], description: "后端" }],
      ratchet: { fail: ["cycle", "nonsense"], warn: ["cycle", "oversized"] },
      llm: { model: "repo-model" },
    }));
    writeFileSync(join(repo, ".repolens.local.json"), JSON.stringify({
      history: false,
      llm: { enabled: false, baseUrl: "https://attacker.example/v1" },
    }));
    const config = loadConfig(repo);
    expect(config.rules).toHaveLength(1);
    expect(config.layers).toEqual([
      { name: "界面", description: null, members: ["dir:web"] },
      { name: "服务", description: "后端", members: ["dir:server"] },
    ]);
    expect(config.ratchet).toEqual({ fail: ["cycle"], warn: ["oversized"] });
    expect(config.history).toBe(false);
    expect(config.llm).toMatchObject({ model: "repo-model", enabled: false, baseUrl: DEFAULT_CONFIG.llm.baseUrl });
  });

  it("分层写错直接报错，不悄悄少查一层", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempDir("repolens-layer-config-"));
    const repo = tempDir("repolens-layer-repo-");
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({ layers: [{ name: "界面", members: ["web"] }] }));
    expect(() => loadConfig(repo)).toThrow("第 1 个分层缺少 name 或 members");
  });

  it("改约定只动给出的键；依赖锁按顺序写、读回来一样", () => {
    const repo = tempDir("repolens-repo-config-");
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({ exclude: ["fixtures/**"], layers: [{ name: "旧", members: ["pkg:web"] }] }));
    updateRepoConfig(repo, { layers: [{ name: "核心", description: null, members: ["pkg:core"] }] });
    expect(JSON.parse(readFileSync(join(repo, ".repolens.json"), "utf8"))).toEqual({
      exclude: ["fixtures/**"],
      layers: [{ name: "核心", description: null, members: ["pkg:core"] }],
    });
    updateRepoConfig(repo, { layers: [] });
    expect(JSON.parse(readFileSync(join(repo, ".repolens.json"), "utf8"))).toEqual({ exclude: ["fixtures/**"] });

    expect(loadLock(repo)).toBeNull();
    writeLock(repo, {
      version: 1,
      level: "package",
      modules: [],
      dependencies: [{ from: "web", to: "core", type: "imports" }, { from: "app", to: "web", type: "http" }],
    });
    expect(loadLock(repo)?.dependencies.map((d) => `${d.from}>${d.to}`)).toEqual(["app>web", "web>core"]);
    writeFileSync(join(repo, ".repolens.lock.json"), "{ broken");
    expect(() => loadLock(repo)).toThrow("依赖锁解析失败");
  });
});
