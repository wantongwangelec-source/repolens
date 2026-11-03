import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { indexPath, openDb } from "../db/database.js";
import { getFindings } from "../db/queries.js";
import { evaluateRules } from "./rules.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-rules-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(config: unknown, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "repolens-rules-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify(config));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const RULES = [
  { name: "web ↛ server", from: "web/**", disallow: ["server/**", "electron"], reason: "前端只走 HTTP" },
  { from: "core/**", disallow: "node:*", allow: ["node:path"], severity: "medium" },
  { name: "类型也不行", from: "web/app.ts", disallow: "server/types.ts", includeTypeOnly: true },
  { name: "写错的规则", from: "lib/**", disallow: "server/**" },
];

const FILES = {
  "web/app.ts": [
    'import { query } from "../server/db";',
    'import type { Row } from "../server/types";',
    'import { ipcRenderer } from "electron";',
    "export function load(): Row { ipcRenderer.send('x'); return query(); }",
  ].join("\n"),
  "web/view.ts": 'import { load } from "./app";\nexport const view = () => load();\n',
  "web/app.test.ts": 'import { query } from "../server/db";\nquery();\n',
  "server/db.ts": "export function query() { return { id: '1' }; }\n",
  "server/types.ts": "export type Row = { id: string };\n",
  "core/fs.ts": [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "export function read(p: string) { return readFileSync(join(p, 'x')); }",
  ].join("\n"),
};

describe("依赖规则", () => {
  it("越界的 import 按文件进体检；纯类型默认放行，测试文件不受约束", async () => {
    const root = fixture({ llm: { enabled: false }, rules: RULES }, FILES);
    await scanRepo({ root, fresh: true });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      const findings = getFindings(db, { kind: "violation" })
        .map(({ title, path, severity, detail }) => ({ title, path, severity, detail }))
        .sort((a, b) => a.title.localeCompare(b.title));
      expect(findings).toEqual([
        {
          title: "违反「core/** ↛ node:*」：依赖 node:fs",
          path: "core/fs.ts",
          severity: "medium",
          detail: "core/fs.ts:1 → node:fs",
        },
        {
          title: "违反「web ↛ server」：依赖 server/db.ts 等 2 个目标",
          path: "web/app.ts",
          severity: "high",
          detail: "前端只走 HTTP\nweb/app.ts:1 → server/db.ts\nweb/app.ts:3 → electron",
        },
        {
          title: "违反「类型也不行」：依赖 server/types.ts",
          path: "web/app.ts",
          severity: "high",
          detail: "web/app.ts:2 → server/types.ts（仅类型）",
        },
      ]);

      const reports = evaluateRules(db, loadConfig(root).rules);
      expect(reports.map((r) => [r.label, r.checkedFiles, r.violations.length])).toEqual([
        ["web ↛ server", 2, 2],
        ["core/** ↛ node:*", 1, 1],
        ["类型也不行", 1, 1],
        ["写错的规则", 0, 0],
      ]);
    } finally {
      db.close();
    }
  });

  it("写错的规则直接报错，不会被静默忽略", () => {
    const missing = fixture({ rules: [{ from: "web/**" }] }, {});
    expect(() => loadConfig(missing)).toThrow(/第 1 条规则缺少 from 或 disallow/);
    const notArray = fixture({ rules: { from: "web/**", disallow: "server/**" } }, {});
    expect(() => loadConfig(notArray)).toThrow(/rules 必须是数组/);
    const normalized = loadConfig(fixture({ rules: [{ from: "./web/**", disallow: "server/**" }] }, {})).rules;
    expect(normalized).toEqual([{
      name: null,
      from: ["web/**"],
      disallow: ["server/**"],
      allow: [],
      includeTypeOnly: false,
      severity: "high",
      reason: null,
    }]);
  });
});
