import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIgnoreMatcher } from "./ignore.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildIgnoreMatcher", () => {
  it("支持相对各子目录生效的嵌套 .gitignore", () => {
    const root = tempDir();
    mkdirSync(join(root, "packages/app"), { recursive: true });
    writeFileSync(join(root, "packages/.gitignore"), "generated/\n*.tmp\n");
    const ignore = buildIgnoreMatcher(root, [], []);

    expect(ignore.ignores("packages/generated/")).toBe(true);
    expect(ignore.ignores("packages/app/cache.tmp")).toBe(true);
    expect(ignore.ignores("generated/")).toBe(false);
    expect(ignore.ignores("other/cache.tmp")).toBe(false);
  });

  it("子目录规则可重新纳入父规则忽略的文件", () => {
    const root = tempDir();
    mkdirSync(join(root, "packages/app"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), "*.ts\n");
    writeFileSync(join(root, "packages/app/.gitignore"), "!keep.ts\n");
    const ignore = buildIgnoreMatcher(root, [], []);

    expect(ignore.ignores("packages/app/drop.ts")).toBe(true);
    expect(ignore.ignores("packages/app/keep.ts")).toBe(false);
  });

  it("显式 include 最后覆盖 Git 和 RepoLens 忽略规则", () => {
    const root = tempDir();
    writeFileSync(join(root, ".gitignore"), "fixtures/**\n");
    writeFileSync(join(root, ".repolensignore"), "fixtures/**\n");
    const ignore = buildIgnoreMatcher(root, [], ["fixtures/keep.ts"]);
    expect(ignore.ignores("fixtures/keep.ts")).toBe(false);
  });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "repolens-ignore-"));
  roots.push(root);
  return root;
}
