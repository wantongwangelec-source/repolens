import { useEffect, useState } from "react";
import type { CodeToken, HighlightRequest, HighlightResponse } from "./highlight.worker";

export type { CodeToken };

/**
 * Beyond this scale, it will not be highlighted. The token sequence of the entire large file is serialized and sent back to the main thread, then processed one by one
 * Rendering as a span is more costly than highlighting itself; at this time, plain text is better than lag.
 */
const MAX_CHARS = 400_000;
const MAX_LINES = 8_000;
const CACHE_SIZE = 32;

const ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  golang: "go",
  kt: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  rb: "ruby",
  ps1: "powershell",
  shell: "shellscript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  console: "shellscript",
  yml: "yaml",
  md: "markdown",
  objc: "objective-c",
  proto: "protobuf",
  tf: "terraform",
  hcl: "terraform",
  docker: "dockerfile",
  make: "makefile",
  jsonc: "json",
  json5: "json",
};

const FILE_NAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
};

/** Language identifier of RepoLens → Shiki grammar name. Unknown languages are guessed again based on the file extension. */
export function shikiLanguage(language: string | null | undefined, path?: string | null): string | null {
  const normalized = language?.toLowerCase().trim() ?? "";
  if (normalized !== "" && normalized !== "other" && !normalized.startsWith("custom:")) {
    return ALIASES[normalized] ?? normalized;
  }
  if (!path) return null;
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (FILE_NAMES[name]) return FILE_NAMES[name];
  const ext = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return ext === "" ? null : (ALIASES[ext] ?? ext);
}

class HighlightClient {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, (lines: CodeToken[][] | null) => void>();
  private readonly cache = new Map<string, Promise<CodeToken[][] | null>>();

  highlight(code: string, lang: string): Promise<CodeToken[][] | null> {
    if (code.length > MAX_CHARS || countLines(code) > MAX_LINES) return Promise.resolve(null);
    const key = `${lang}\0${code}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const task = this.request(code, lang);
    this.cache.set(key, task);
    if (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return task;
  }

  private request(code: string, lang: string): Promise<CodeToken[][] | null> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const message: HighlightRequest = { id, code, lang };
      worker.postMessage(message);
    });
  }

  /** Highlighting is just icing on the cake: if the Worker can't start, it will keep returning plain text, without fallback on the main thread. */
  private ensureWorker(): Worker | null {
    if (this.worker || this.broken) return this.worker;
    try {
      const worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<HighlightResponse>) => {
        const resolve = this.pending.get(event.data.id);
        if (!resolve) return;
        this.pending.delete(event.data.id);
        resolve(event.data.lines ?? null);
      };
      worker.onerror = () => {
        this.broken = true;
        for (const resolve of this.pending.values()) resolve(null);
        this.pending.clear();
        this.cache.clear();
        this.worker?.terminate();
        this.worker = null;
      };
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }
}

const client = new HighlightClient();

export function highlightCode(code: string, lang: string | null): Promise<CodeToken[][] | null> {
  return lang === null ? Promise.resolve(null) : client.highlight(code, lang);
}

/** Return null first to let the caller render as plain text, then replace it when the highlighting result arrives, without blocking the first frame. */
export function useHighlightedLines(code: string | null, lang: string | null): CodeToken[][] | null {
  const [state, setState] = useState<{ key: string; lines: CodeToken[][] | null } | null>(null);
  const key = code === null ? null : `${lang ?? ""}\0${code}`;

  useEffect(() => {
    if (code === null || key === null) return;
    let cancelled = false;
    void highlightCode(code, lang).then((lines) => {
      if (!cancelled) setState({ key, lines });
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, key]);

  return state !== null && state.key === key ? state.lines : null;
}

function countLines(code: string): number {
  let count = 1;
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) count++;
  return count;
}
