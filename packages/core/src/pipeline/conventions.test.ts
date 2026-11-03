import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeLock } from "../config.js";
import { buildLock } from "../db/architecture.js";
import { indexPath, openDb } from "../db/database.js";
import { getFindings } from "../db/queries.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-conventions-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** pnpm monorepo: app → core, ui only depends on core */
function monorepo(extra: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "repolens-conventions-"));
  roots.push(root);
  write(root, {
    ".repolens.json": JSON.stringify({ llm: { enabled: false }, ...extra }),
    "package.json": JSON.stringify({ name: "mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/core/package.json": JSON.stringify({ name: "@m/core", main: "src/index.ts" }),
    "packages/core/src/index.ts": "export { load } from './store';\n",
    "packages/core/src/store.ts": "export function load() { return 1; }\nexport function internal() { return 2; }\n",
    "packages/ui/package.json": JSON.stringify({ name: "@m/ui", main: "src/index.ts" }),
    "packages/ui/src/index.ts": "import { load } from '@m/core';\nexport function view() { return load(); }\n",
    "packages/app/package.json": JSON.stringify({ name: "@m/app", main: "src/main.ts" }),
    "packages/app/src/main.ts": "import { view } from '@m/ui';\nexport function main() { return view(); }\n",
  });
  return root;
}

describe("约定", () => {
  it("依赖锁：锁住现状之后，新长出来的模块间依赖进体检", async () => {
    const root = monorepo();
    await scanRepo({ root });
    const db = openDb(indexPath(root));
    const lock = buildLock(db);
    db.close();
    expect(lock).toMatchObject({ level: "package", modules: [] });
    expect(lock.dependencies).toEqual([
      { from: "@m/app", to: "@m/ui", type: "imports" },
      { from: "@m/ui", to: "@m/core", type: "imports" },
    ]);
    writeLock(root, lock);

    write(root, { "packages/core/src/store.ts": "import { view } from '@m/ui';\nexport function load() { return 1; }\nexport function internal() { return view(); }\n" });
    await scanRepo({ root });
    const after = openDb(indexPath(root), { readonly: true });
    try {
      const findings = getFindings(after, { kind: "unapproved" });
      expect(findings.map((f) => [f.title, f.scopeKey])).toEqual([["未批准的新依赖：@m/core → @m/ui", "pkg:@m/core"]]);
      expect(findings[0]?.detail).toContain("packages/core/src/store.ts:1");
    } finally {
      after.close();
    }
  });

  it("确认过的分层：下层 import 上层算分层倒置，上层依赖下层不报", async () => {
    const root = monorepo({
      layers: [
        { name: "应用", members: ["pkg:@m/app"] },
        { name: "界面", members: ["pkg:@m/ui"] },
        { name: "核心", members: ["pkg:@m/core"] },
      ],
    });
    write(root, { "packages/core/src/store.ts": "import { main } from '@m/app';\nexport function load() { return 1; }\nexport function internal() { return main(); }\n" });
    await scanRepo({ root });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      expect(getFindings(db, { kind: "layering" }).map((f) => f.title)).toEqual([
        "分层倒置：「核心」的 @m/core 依赖了上层「应用」的 @m/app",
      ]);
    } finally {
      db.close();
    }
  });

  it("绕过包入口直接引内部文件进体检；经入口引用、包内引用都不报", async () => {
    const root = monorepo();
    write(root, {
      "packages/ui/src/deep.ts": "import { internal } from '@m/core/src/store';\nexport function deep() { return internal(); }\n",
      "packages/app/src/relative.ts": "import { internal } from '../../core/src/store';\nexport function rel() { return internal(); }\n",
    });
    await scanRepo({ root });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      const findings = getFindings(db, { kind: "bypass" }).map((f) => [f.path, f.severity, f.title]).sort();
      expect(findings).toEqual([
        ["packages/app/src/relative.ts", "high", "用相对路径跨包引用了 @m/core 的内部文件 src/store.ts"],
        ["packages/ui/src/deep.ts", "medium", "绕过 @m/core 的入口，直接引用内部文件 src/store.ts"],
      ]);
    } finally {
      db.close();
    }
  });
});
