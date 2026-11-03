import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INDEX_DIR, INDEX_FILE } from "./db/database.js";
import { forgetRepo, gitBranch, listRepos, readRegistry, registryPath, rememberRepo, repoId } from "./registry.js";

// registryPath() uses os.homedir(): reads $HOME on POSIX, reads %USERPROFILE% on Windows.
// You can redirect the entire set of reads and writes to the temporary directory by changing the environment variables, without having to add an entry hook to the module.
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "repolens-registry-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Create a repository directory with an index */
function indexedRepo(name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, INDEX_DIR), { recursive: true });
  writeFileSync(join(root, INDEX_DIR, INDEX_FILE), "");
  return root;
}

describe("repoId", () => {
  it("由绝对路径决定，且对同一路径稳定", () => {
    expect(repoId("/repo/a")).toBe(repoId("/repo/a"));
    expect(repoId("/repo/a")).not.toBe(repoId("/repo/b"));
  });

  it("把相对路径归一化后再算，所以 . 和它的绝对形式同 id", () => {
    expect(repoId(process.cwd())).toBe(repoId("."));
  });

  it("是 URL 安全的定长短串", () => {
    expect(repoId("/repo/带空格 和中文/x")).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("readRegistry / rememberRepo", () => {
  it("没有清单文件时返回空数组", () => {
    expect(readRegistry()).toEqual([]);
  });

  it("记下的仓库能读回来", () => {
    const root = indexedRepo("alpha");
    const entry = rememberRepo(root);

    expect(entry.root).toBe(root);
    expect(entry.name).toBe("alpha");
    expect(readRegistry()).toHaveLength(1);
    expect(readRegistry()[0]?.id).toBe(repoId(root));
  });

  it("重复记同一个仓库只刷新时间，不产生第二条", () => {
    const root = indexedRepo("alpha");
    const first = rememberRepo(root);
    const second = rememberRepo(root);

    expect(readRegistry()).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it("最近记下的排在最前", () => {
    rememberRepo(indexedRepo("alpha"));
    const beta = rememberRepo(indexedRepo("beta"));

    expect(readRegistry()[0]?.id).toBe(beta.id);
  });

  it("清单坏掉时当作空，而不是抛异常", () => {
    const file = registryPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ 这不是 JSON");

    expect(() => readRegistry()).not.toThrow();
    expect(readRegistry()).toEqual([]);
  });

  it("版本不认识时也当作空", () => {
    const file = registryPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 999, repos: [{ id: "x" }] }));

    expect(readRegistry()).toEqual([]);
  });

  it("过滤掉字段缺失的条目，不让它们污染整份清单", () => {
    const file = registryPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        repos: [
          { id: "good", root: "/r", name: "r", lastOpenedAt: "2026-01-01T00:00:00.000Z" },
          { id: "bad-no-root" },
        ],
      }),
    );

    expect(readRegistry().map((r) => r.id)).toEqual(["good"]);
  });

  it("有上限，不会无限增长", () => {
    for (let i = 0; i < 60; i++) rememberRepo(join(home, `r${i}`));
    expect(readRegistry().length).toBeLessThanOrEqual(50);
    // The ones being eliminated are the earliest batch, the most recently recorded must still remain.
    expect(readRegistry()[0]?.id).toBe(repoId(join(home, "r59")));
  });
});

describe("forgetRepo", () => {
  it("移除存在的条目并返回 true", () => {
    const entry = rememberRepo(indexedRepo("alpha"));
    expect(forgetRepo(entry.id)).toBe(true);
    expect(readRegistry()).toEqual([]);
  });

  it("移除不存在的条目返回 false", () => {
    expect(forgetRepo("nope")).toBe(false);
  });
});

describe("listRepos 的状态探测", () => {
  it("索引在就是 ok", () => {
    rememberRepo(indexedRepo("alpha"));
    expect(listRepos()[0]?.status).toBe("ok");
  });

  it("目录在但索引没了，报 index-missing", () => {
    const root = join(home, "beta");
    mkdirSync(root, { recursive: true });
    rememberRepo(root);

    expect(listRepos()[0]?.status).toBe("index-missing");
  });

  it("目录整个没了，报 root-missing", () => {
    const root = indexedRepo("gamma");
    rememberRepo(root);
    rmSync(root, { recursive: true, force: true });

    expect(listRepos()[0]?.status).toBe("root-missing");
  });

  it("状态是每次现场探测的，不是记下来的那一刻的快照", () => {
    const root = indexedRepo("delta");
    rememberRepo(root);
    expect(listRepos()[0]?.status).toBe("ok");

    rmSync(join(root, INDEX_DIR), { recursive: true, force: true });
    expect(listRepos()[0]?.status).toBe("index-missing");
  });
});

describe("gitBranch", () => {
  it("读取普通仓库分支与 detached HEAD", () => {
    const root = join(home, "branch-repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/feature/repo-list\n");
    expect(gitBranch(root)).toBe("feature/repo-list");

    writeFileSync(join(root, ".git/HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    expect(gitBranch(root)).toBe("detached@0123456");
  });

  it("支持 .git 文件指向的 worktree，并对非 Git 仓库返回 null", () => {
    const root = join(home, "worktree");
    const gitDir = join(home, "main/.git/worktrees/feature");
    mkdirSync(root, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/worktree-branch\n");
    expect(gitBranch(root)).toBe("worktree-branch");
    expect(gitBranch(join(home, "not-a-repo"))).toBeNull();
  });

  it("扫描 Git 仓库的子目录时仍能显示所在分支", () => {
    const root = join(home, "monorepo");
    const packageRoot = join(root, "packages/web");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(root, ".git/HEAD"), "ref: refs/heads/main\n");
    expect(gitBranch(packageRoot)).toBe("main");
  });
});
