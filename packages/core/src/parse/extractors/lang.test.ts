import { afterAll, describe, expect, it } from "vitest";
import type { AnalyzableLanguage, ParsedCall, ParsedFile, ParsedSymbol } from "../../types.js";
import { ParserPool } from "../parser-pool.js";
import { goExtractor } from "./go.js";
import { pythonExtractor } from "./python.js";
import { rustExtractor } from "./rust.js";
import type { LanguageExtractor } from "./types.js";

const pool = new ParserPool();

afterAll(() => {
  pool.dispose();
});

async function run(
  extractor: LanguageExtractor,
  language: AnalyzableLanguage,
  path: string,
  source: string,
): Promise<ParsedFile> {
  const parser = await pool.parserFor(language);
  expect(parser, `${language} 语法未能加载`).not.toBeNull();
  const tree = parser?.parse(source) ?? null;
  expect(tree, `${language} 解析失败`).not.toBeNull();
  try {
    return extractor.extract({ root: tree!.rootNode, source, language, path });
  } finally {
    tree?.delete();
  }
}

function byName(symbols: readonly ParsedSymbol[], name: string, container?: string): ParsedSymbol {
  const hit = symbols.find((s) => s.name === name && s.container === container);
  expect(hit, `找不到符号 ${container ? `${container}.${name}` : name}`).toBeDefined();
  return hit as ParsedSymbol;
}

function callsOf(calls: readonly ParsedCall[], callerName: string | null): ParsedCall[] {
  return calls.filter((c) => c.callerName === callerName);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_SOURCE = `"""Repository service layer."""

import os
import os.path as osp
from dataclasses import dataclass
from . import errors
from ..util.text import slugify
from .models import User, Team as Crew

__all__ = ["UserService", "DEFAULT_PAGE_SIZE"]

DEFAULT_PAGE_SIZE: int = 20
_CACHE_TTL = 300


@dataclass
class Page:
    """A page of results."""

    items: list
    total: int


class BaseService:
    def __init__(self, repo):
        self.repo = repo


class UserService(BaseService, errors.Reporting):
    """Serve user records."""

    def __init__(self, repo, cache=None):
        super().__init__(repo)
        self.cache = cache

    async def find(self, uid: int, *extras, **opts) -> User:
        """Look up one user."""
        row = await self.repo.fetch(uid)
        if row is None:
            raise errors.Missing(uid)
        return User(slugify(row), *extras)

    @staticmethod
    def build(repo) -> "UserService":
        return UserService(repo)


def make_crew(name: str) -> Crew:
    service = UserService(None)
    return Crew(slugify(name), service.build(None))
`;

describe("pythonExtractor", () => {
  it("识别 FastAPI 装饰器路由且不把装饰器当调用边", async () => {
    const parsed = await run(pythonExtractor, "python", "app/api.py", `
from fastapi import FastAPI
app = FastAPI()

@app.get("/users/{user_id}")
async def get_user(user_id: str) -> User:
    return load_user(user_id)
`);
    expect(parsed.entryHints).toEqual([{
      kind: "http", framework: "FastAPI", handlerName: "get_user", line: 5,
      label: "GET /users/{user_id}", method: "GET", route: "/users/{user_id}",
      confidence: "exact", evidence: "app.get decorator",
    }]);
    expect(parsed.calls.some((call) => call.callee === "get")).toBe(false);
  });

  it("抽取符号、可见性、参数与调用归属", async () => {
    const parsed = await run(pythonExtractor, "python", "src/app/services/user.py", PYTHON_SOURCE);

    expect(parsed.hasError).toBe(false);
    expect(parsed.symbols.map((s) => s.name)).toEqual([
      "DEFAULT_PAGE_SIZE",
      "_CACHE_TTL",
      "Page",
      "BaseService",
      "__init__",
      "UserService",
      "__init__",
      "find",
      "build",
      "make_crew",
    ]);

    // When __all__ exists, the top-level visibility is based on it, and the underscore convention only applies to class members.
    expect(byName(parsed.symbols, "UserService").exported).toBe(true);
    expect(byName(parsed.symbols, "DEFAULT_PAGE_SIZE").exported).toBe(true);
    expect(byName(parsed.symbols, "Page").exported).toBe(false);
    expect(byName(parsed.symbols, "make_crew").exported).toBe(false);
    expect(byName(parsed.symbols, "_CACHE_TTL").exported).toBe(false);
    expect(byName(parsed.symbols, "find", "UserService").exported).toBe(true);
    expect(byName(parsed.symbols, "__init__", "UserService").exported).toBe(false);

    expect(byName(parsed.symbols, "Page").kind).toBe("class");
    expect(byName(parsed.symbols, "DEFAULT_PAGE_SIZE").kind).toBe("constant");
    expect(byName(parsed.symbols, "make_crew").kind).toBe("function");
    expect(byName(parsed.symbols, "build", "UserService").kind).toBe("method");
    expect(byName(parsed.symbols, "build", "UserService").isStatic).toBe(true);

    const find = byName(parsed.symbols, "find", "UserService");
    expect(find.isAsync).toBe(true);
    expect(find.returnType).toBe("User");
    expect(find.doc).toBe("Look up one user.");
    expect(find.complexity).toBeGreaterThan(1);
    // Keep self as is, mark *args / **kwargs as variadic
    expect(find.params).toEqual([
      { name: "self", optional: false, variadic: false },
      { name: "uid", type: "int", optional: false, variadic: false },
      { name: "extras", optional: true, variadic: true },
      { name: "opts", optional: true, variadic: true },
    ]);

    expect(byName(parsed.symbols, "__init__", "UserService").params).toEqual([
      { name: "self", optional: false, variadic: false },
      { name: "repo", optional: false, variadic: false },
      { name: "cache", type: undefined, defaultValue: "None", optional: true, variadic: false },
    ]);

    expect(byName(parsed.symbols, "Page").doc).toBe("A page of results.");
    expect(byName(parsed.symbols, "UserService").signature).toBe(
      "class UserService(BaseService, errors.Reporting):",
    );
  });

  it("保留相对导入的点号并展开 specifier", async () => {
    const parsed = await run(pythonExtractor, "python", "src/app/services/user.py", PYTHON_SOURCE);

    expect(parsed.imports.map((i) => i.source)).toEqual([
      "os",
      "os.path",
      "dataclasses",
      ".",
      "..util.text",
      ".models",
    ]);

    const osPath = parsed.imports.find((i) => i.source === "os.path");
    expect(osPath?.specifiers).toEqual([{ imported: "*", local: "osp", isNamespace: true }]);

    const models = parsed.imports.find((i) => i.source === ".models");
    expect(models?.specifiers).toEqual([
      { imported: "User", local: "User" },
      { imported: "Team", local: "Crew" },
    ]);

    const dot = parsed.imports.find((i) => i.source === ".");
    expect(dot?.specifiers).toEqual([{ imported: "errors", local: "errors" }]);

    expect(parsed.exports.map((e) => e.name)).toEqual(["UserService", "DEFAULT_PAGE_SIZE"]);
  });

  it("按类继承产出 extends，并把调用归属到最内层函数", async () => {
    const parsed = await run(pythonExtractor, "python", "src/app/services/user.py", PYTHON_SOURCE);

    expect(parsed.typeRelations).toEqual([
      {
        subject: "UserService",
        subjectKind: "class",
        relation: "extends",
        target: "BaseService",
        targetPath: undefined,
        line: 29,
      },
      {
        subject: "UserService",
        subjectKind: "class",
        relation: "extends",
        target: "Reporting",
        targetPath: ["errors", "Reporting"],
        line: 29,
      },
    ]);

    const inFind = callsOf(parsed.calls, "find");
    expect(inFind.every((c) => c.callerContainer === "UserService")).toBe(true);
    expect(inFind.map((c) => c.callee)).toEqual(["fetch", "Missing", "User", "slugify"]);
    expect(inFind.find((c) => c.callee === "fetch")).toMatchObject({
      receiver: "self.repo",
      calleePath: ["self", "repo", "fetch"],
      kind: "method",
      argCount: 1,
    });

    const inMakeCrew = callsOf(parsed.calls, "make_crew");
    expect(inMakeCrew.map((c) => c.callee)).toEqual(["UserService", "Crew", "slugify", "build"]);
    expect(inMakeCrew.every((c) => c.callerContainer === undefined)).toBe(true);
    expect(inMakeCrew.find((c) => c.callee === "build")).toMatchObject({
      receiver: "service",
      kind: "method",
    });

    // @dataclass is metadata and should not be an invocation edge
    expect(parsed.calls.some((c) => c.callee === "dataclass")).toBe(false);
    expect(callsOf(parsed.calls, null)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_SOURCE = `// Package store persists users.
package store

import (
	"context"
	"fmt"

	"example.com/app/internal/db"
	uuid "github.com/google/uuid"
	_ "github.com/lib/pq"
)

// MaxBatch caps one write batch.
const MaxBatch = 100

var defaultCtx = context.Background()

// Reader reads users.
type Reader interface {
	fmt.Stringer
	Read(ctx context.Context, id string) (*User, error)
}

type base struct {
	conn *db.Conn
}

// Store is the primary entry point.
type Store struct {
	base
	*db.Pool
	name             string
	retries, backoff int
}

// NewStore builds a Store.
func NewStore(name string, conn *db.Conn, opts ...Option) (*Store, error) {
	fmt.Println(name)
	return &Store{name: name}, nil
}

// Read implements Reader.
func (s *Store) Read(ctx context.Context, id string) (*User, error) {
	s.warm(ctx)
	row, err := s.Pool.Query(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", id, err)
	}
	return newUser(row, uuid.New()), nil
}

func (s Store) warm(ctx context.Context) {
	_ = defaultCtx
}
`;

describe("goExtractor", () => {
  it("按首字母大小写判定可见性，方法归属到接收者类型", async () => {
    const parsed = await run(goExtractor, "go", "internal/store/store.go", GO_SOURCE);

    expect(parsed.hasError).toBe(false);
    expect(parsed.symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      "constant:MaxBatch",
      "variable:defaultCtx",
      "interface:Reader",
      "struct:base",
      "struct:Store",
      "function:NewStore",
      "method:Read",
      "method:warm",
    ]);

    expect(byName(parsed.symbols, "MaxBatch").exported).toBe(true);
    expect(byName(parsed.symbols, "MaxBatch").doc).toBe("MaxBatch caps one write batch.");
    expect(byName(parsed.symbols, "defaultCtx").exported).toBe(false);
    expect(byName(parsed.symbols, "base").exported).toBe(false);
    expect(byName(parsed.symbols, "Store").doc).toBe("Store is the primary entry point.");

    const read = byName(parsed.symbols, "Read", "Store");
    expect(read.receiverType).toBe("*Store");
    expect(read.exported).toBe(true);
    expect(read.returnType).toBe("(*User, error)");
    expect(read.complexity).toBe(2);

    const warm = byName(parsed.symbols, "warm", "Store");
    expect(warm.receiverType).toBe("Store");
    expect(warm.exported).toBe(false);

    // `a, b int` are two parameters in a declaration and must be expanded into two separate lines
    expect(byName(parsed.symbols, "NewStore").params).toEqual([
      { name: "name", type: "string", optional: false, variadic: false },
      { name: "conn", type: "*db.Conn", optional: false, variadic: false },
      { name: "opts", type: "Option", optional: false, variadic: true },
    ]);

    expect(parsed.exports.map((e) => e.name)).toEqual(["MaxBatch", "Reader", "Store", "NewStore"]);
  });

  it("抽取 import 别名与空导入，记录 struct / interface 的嵌入", async () => {
    const parsed = await run(goExtractor, "go", "internal/store/store.go", GO_SOURCE);

    expect(parsed.imports).toEqual([
      { source: "context", kind: "static", specifiers: [{ imported: "*", local: "context", isNamespace: true }], line: 5 },
      { source: "fmt", kind: "static", specifiers: [{ imported: "*", local: "fmt", isNamespace: true }], line: 6 },
      {
        source: "example.com/app/internal/db",
        kind: "static",
        specifiers: [{ imported: "*", local: "db", isNamespace: true }],
        line: 8,
      },
      {
        source: "github.com/google/uuid",
        kind: "static",
        specifiers: [{ imported: "*", local: "uuid", isNamespace: true }],
        line: 9,
      },
      {
        source: "github.com/lib/pq",
        kind: "side-effect",
        specifiers: [{ imported: "*", local: "_", isNamespace: true }],
        line: 10,
      },
    ]);

    expect(parsed.typeRelations).toEqual([
      {
        subject: "Reader",
        subjectKind: "interface",
        relation: "embeds",
        target: "Stringer",
        targetPath: ["fmt", "Stringer"],
        line: 20,
      },
      { subject: "Store", subjectKind: "struct", relation: "embeds", target: "base", targetPath: undefined, line: 30 },
      {
        subject: "Store",
        subjectKind: "struct",
        relation: "embeds",
        target: "Pool",
        targetPath: ["db", "Pool"],
        line: 31,
      },
    ]);
  });

  it("selector 调用如实记录 receiver，顶层初始化归属为 null", async () => {
    const parsed = await run(goExtractor, "go", "internal/store/store.go", GO_SOURCE);

    // `context.Background()` in var initialization is not part of any function
    expect(callsOf(parsed.calls, null)).toMatchObject([{ callee: "Background", receiver: "context" }]);

    const inRead = callsOf(parsed.calls, "Read");
    expect(inRead.every((c) => c.callerContainer === "Store")).toBe(true);
    expect(inRead.map((c) => c.callee)).toEqual(["warm", "Query", "Errorf", "newUser", "New"]);
    expect(inRead.find((c) => c.callee === "Query")).toMatchObject({
      receiver: "s.Pool",
      calleePath: ["s", "Pool", "Query"],
      kind: "method",
      argCount: 2,
    });
    // Package function calls and instance method calls have the same form, and during the extraction phase, they are all recorded as method.
    expect(inRead.find((c) => c.callee === "Errorf")).toMatchObject({ receiver: "fmt", kind: "method" });
    expect(inRead.find((c) => c.callee === "newUser")).toMatchObject({ kind: "call", argCount: 2 });
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RUST_SOURCE = `//! Storage layer.

use std::collections::HashMap;
use crate::config::Config;
use crate::store::{Record, models::User};
use super::errors::StoreError;
use serde::Serialize;

mod cache;
mod index;

/// Maximum retained entries.
pub const MAX_ENTRIES: usize = 512;

/// A keyed store.
#[derive(Debug)]
pub struct Store {
    entries: HashMap<String, Record>,
    config: Config,
}

pub enum Mode {
    Eager,
    Lazy(u8),
}

/// Anything that can load users.
pub trait Loader: Serialize + Send {
    fn load(&self, id: &str) -> Result<User, StoreError>;
}

impl Store {
    /// Build an empty store.
    pub fn new(config: Config) -> Self {
        let entries = HashMap::new();
        Store { entries, config }
    }

    fn touch(&mut self, key: &str) -> usize {
        self.entries.len()
    }
}

impl Loader for Store {
    fn load(&self, id: &str) -> Result<User, StoreError> {
        self.touch(id);
        let raw = cache::lookup(id);
        println!("loaded {}", id);
        User::parse(raw).map_err(StoreError::from)
    }
}
`;

describe("rustExtractor", () => {
  it("按 visibility_modifier 判定可见性，impl / trait 成员归属到容器", async () => {
    const parsed = await run(rustExtractor, "rust", "crates/store/src/handlers/http.rs", RUST_SOURCE);

    expect(parsed.hasError).toBe(false);
    expect(parsed.symbols.map((s) => `${s.kind}:${s.container ?? "-"}.${s.name}`)).toEqual([
      "constant:-.MAX_ENTRIES",
      "struct:-.Store",
      "enum:-.Mode",
      "trait:-.Loader",
      "method:Loader.load",
      "impl:-.Store",
      "method:Store.new",
      "method:Store.touch",
      "impl:-.Loader for Store",
      "method:Store.load",
    ]);

    expect(byName(parsed.symbols, "MAX_ENTRIES").exported).toBe(true);
    expect(byName(parsed.symbols, "Store", undefined).exported).toBe(true);
    expect(byName(parsed.symbols, "new", "Store").exported).toBe(true);
    expect(byName(parsed.symbols, "touch", "Store").exported).toBe(false);
    expect(byName(parsed.symbols, "load", "Store").exported).toBe(false);

    // `///` documentation comments, and must be able to pass over #[derive(..)] attributes
    expect(byName(parsed.symbols, "MAX_ENTRIES").doc).toBe("Maximum retained entries.");
    expect(byName(parsed.symbols, "Store", undefined).doc).toBe("A keyed store.");
    expect(byName(parsed.symbols, "Loader").doc).toBe("Anything that can load users.");
    expect(byName(parsed.symbols, "new", "Store").doc).toBe("Build an empty store.");

    const touch = byName(parsed.symbols, "touch", "Store");
    expect(touch.returnType).toBe("usize");
    expect(touch.params).toEqual([
      { name: "self", type: "&mut self", optional: false, variadic: false },
      { name: "key", type: "&str", optional: false, variadic: false },
    ]);

    expect(byName(parsed.symbols, "Loader").signature).toBe("pub trait Loader: Serialize + Send");
    expect(parsed.exports.map((e) => e.name)).toEqual(["MAX_ENTRIES", "Store", "Mode", "Loader"]);
  });

  it("展开 use_list 成叶子路径，mod 声明进 moduleDecls", async () => {
    const parsed = await run(rustExtractor, "rust", "crates/store/src/handlers/http.rs", RUST_SOURCE);

    expect(parsed.moduleDecls).toEqual(["cache", "index"]);
    expect(parsed.imports).toEqual([
      { source: "std::collections", kind: "static", specifiers: [{ imported: "HashMap", local: "HashMap" }], line: 3 },
      { source: "crate::config", kind: "static", specifiers: [{ imported: "Config", local: "Config" }], line: 4 },
      { source: "crate::store", kind: "static", specifiers: [{ imported: "Record", local: "Record" }], line: 5 },
      {
        source: "crate::store::models",
        kind: "static",
        specifiers: [{ imported: "User", local: "User" }],
        line: 5,
      },
      { source: "super::errors", kind: "static", specifiers: [{ imported: "StoreError", local: "StoreError" }], line: 6 },
      { source: "serde", kind: "static", specifiers: [{ imported: "Serialize", local: "Serialize" }], line: 7 },
      {
        source: "self::cache",
        kind: "module-decl",
        specifiers: [{ imported: "*", local: "cache", isNamespace: true }],
        line: 9,
      },
      {
        source: "self::index",
        kind: "module-decl",
        specifiers: [{ imported: "*", local: "index", isNamespace: true }],
        line: 10,
      },
    ]);
  });

  it("区分关联函数 / 方法 / 宏调用，记录 implements 与 supertrait", async () => {
    const parsed = await run(rustExtractor, "rust", "crates/store/src/handlers/http.rs", RUST_SOURCE);

    expect(parsed.typeRelations).toEqual([
      { subject: "Loader", subjectKind: "trait", relation: "extends", target: "Serialize", targetPath: undefined, line: 28 },
      { subject: "Loader", subjectKind: "trait", relation: "extends", target: "Send", targetPath: undefined, line: 28 },
      // subjectKind is retrieved from the declarations in the same file, not guessed
      { subject: "Store", subjectKind: "struct", relation: "implements", target: "Loader", targetPath: undefined, line: 44 },
    ]);

    expect(callsOf(parsed.calls, "new")).toMatchObject([
      { callee: "new", receiver: "HashMap", calleePath: ["HashMap", "new"], kind: "call" },
    ]);

    const inLoad = callsOf(parsed.calls, "load").filter((c) => c.callerContainer === "Store");
    expect(inLoad.map((c) => `${c.kind}:${c.callee}`)).toEqual([
      "method:touch",
      "call:lookup",
      "macro:println",
      "method:map_err",
      "call:parse",
    ]);
    expect(inLoad.find((c) => c.callee === "lookup")).toMatchObject({ receiver: "cache" });
    expect(inLoad.find((c) => c.callee === "println")).toMatchObject({ kind: "macro", argCount: 2 });
    expect(inLoad.find((c) => c.callee === "parse")).toMatchObject({ receiver: "User", argCount: 1 });
  });

  it("展平嵌套 use_list、别名、通配与 self", async () => {
    const parsed = await run(
      rustExtractor,
      "rust",
      "src/lib.rs",
      `use a::{b, c::{d, e}, f as g, h::*, self};\nuse solo;\nuse ::rooted::Thing;\n`,
    );

    expect(parsed.imports.map((i) => `${i.source} => ${i.specifiers.map((s) => `${s.imported}/${s.local}`).join(",")}`))
      .toEqual([
        "a => b/b",
        "a::c => d/d",
        "a::c => e/e",
        "a => f/g",
        "a::h => */*",
        "a => */a",
        "solo => */solo",
        "rooted => Thing/Thing",
      ]);
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("抽取器的兜底行为", () => {
  const cases: Array<[string, LanguageExtractor, AnalyzableLanguage, string, string]> = [
    ["python", pythonExtractor, "python", "a.py", "def broken(:\n    return"],
    ["go", goExtractor, "go", "a.go", "package a\nfunc ( {"],
    ["rust", rustExtractor, "rust", "a.rs", "fn broken( -> {"],
  ];

  it.each(cases)("%s 遇到语法错误时置 hasError 而不抛异常", async (_name, extractor, language, path, source) => {
    const parsed = await run(extractor, language, path, source);
    expect(parsed.hasError).toBe(true);
  });

  it.each([
    ["python", pythonExtractor, "python", "empty.py"] as const,
    ["go", goExtractor, "go", "empty.go"] as const,
    ["rust", rustExtractor, "rust", "empty.rs"] as const,
  ])("%s 空文件产出空结构", async (_name, extractor, language, path) => {
    const parsed = await run(extractor, language, path, "");
    expect(parsed.symbols).toEqual([]);
    expect(parsed.imports).toEqual([]);
    expect(parsed.calls).toEqual([]);
    expect(parsed.typeRelations).toEqual([]);
    expect(parsed.hasError).toBe(false);
  });

  it("Python 没有 __all__ 时退回下划线约定", async () => {
    const parsed = await run(
      pythonExtractor,
      "python",
      "a.py",
      "def public():\n    pass\n\ndef _private():\n    pass\n\nCONST = 1\n",
    );
    expect(byName(parsed.symbols, "public").exported).toBe(true);
    expect(byName(parsed.symbols, "_private").exported).toBe(false);
    expect(parsed.exports.map((e) => e.name)).toEqual(["public", "CONST"]);
  });

  it("Python 通配导入标成 namespace specifier", async () => {
    const parsed = await run(pythonExtractor, "python", "a.py", "from .base import *\nimport a.b.c\n");
    expect(parsed.imports).toEqual([
      {
        source: ".base",
        kind: "static",
        specifiers: [{ imported: "*", local: "*", isNamespace: true }],
        line: 1,
      },
      {
        source: "a.b.c",
        kind: "static",
        specifiers: [{ imported: "*", local: "a.b.c", isNamespace: true }],
        line: 2,
      },
    ]);
  });
});
