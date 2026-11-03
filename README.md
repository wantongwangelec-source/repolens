# RepoLens

A local code-repository understanding tool. The CLI scans a repo into a deterministic code knowledge graph (SQLite). The local web UI lets you drill from architecture to directories and call relationships, and highlights structural problems.

Built for **reading large repos written by others (or by AI)**: a ~400k-line monorepo (~180k lines of source) fully scans in about 20 seconds; later updates are incremental by content fingerprint and usually finish in a few seconds after a few files change.

As more code is AI-written, human understanding often lags. RepoLens helps you take control back:

- **See**: what connects modules (edges as contracts, module cards), what a change does structurally (change units, behavior deltas), where churn is concentrated
- **Internalize**: which entry to start from, how to walk the runtime path, what behaviors tests encode, how core data structures flow
- **Guard**: layers, rules, and approved dependencies live in the repo; `check --baseline` only blocks newly introduced problems; AI coding agents can read the same conventions over MCP before editing

TypeScript / JavaScript, Python, Go, and Rust get dedicated structure and module analysis. Vue, Svelte, and Astro analyze JS/TS scripts inside components while preserving original line numbers. Java, C/C++, C#, PHP, Ruby, Shell, and PowerShell get generic structure analysis. Other common languages and unknown text sources still show up for browsing, stats, and file-level AI summaries, without inventing unreliable symbol dependencies or calls.

## Requirements

- Node.js >= 20.11
- pnpm 9.13.2 (pinned via `packageManager`; `corepack enable` aligns it)

## Install

```bash
pnpm install
pnpm build
```

`pnpm build` is required once: the CLI loads from `packages/*/dist`, and the web UI is served from `packages/web/dist`.

## Quick start

`open` scans when needed, starts the server, and opens a browser:

```bash
pnpm lens open /path/to/some-repo
```

It writes `.repolens/index.db` under the scanned repo and opens http://127.0.0.1:7173.

## Desktop app

Prefer not to install Node? Download platform installers from [GitHub Releases](https://github.com/wantongwangelec-source/repolens/releases) (macOS Apple silicon / Intel, Windows, Linux AppImage / deb). Open the app, choose **Add local repository**, and configure AI under the top-bar AI status or **Settings…**.

Builds are currently unsigned; see [docs/desktop.md](docs/desktop.md) for first-launch tips and release notes (that doc may still be in Chinese).

## Commands

| Command | Purpose |
| --- | --- |
| `scan [path]` | Scan a repo into `<repo>/.repolens/index.db` |
| `serve [path]` | Serve an existing index without scanning |
| `open [path]` | Scan if needed + serve + open browser |
| `info [path]` | Print an index summary in the terminal |
| `diff [path]` | Structural diff vs a git commit (review AI-sized changes) |
| `check [path]` | Convention checks: dependency rules, lockfile, optional ratchet; exit 1 on failure |
| `lock [path]` | Write current module dependencies into `.repolens.lock.json` |
| `mcp [path]` | Expose the index to AI coding agents over MCP (stdio) |

`path` defaults to the current directory.

Common flags:

| Flag | Commands | Notes |
| --- | --- | --- |
| `-f, --fresh` | `scan` `open` | Ignore existing index; full rebuild |
| `-s, --structure-only` | `scan` | Structure only; keep existing AI summaries |
| `-q, --quiet` | `scan` | Final result only |
| `-p, --port <port>` | `serve` `open` | Default 7173 |
| `--host <host>` | `serve` | Default `127.0.0.1` |
| `--open` | `serve` | Open browser after start |
| `-w, --watch` | `serve` `open` | Refresh structure on file changes |
| `-b, --base <ref>` | `diff` | Baseline commit (default `HEAD`) |
| `--head <ref>` | `diff` | Compare to another commit; default is the working tree |
| `-b, --baseline <ref>` | `check` | Ratchet baseline (e.g. `origin/main`) |
| `--json` | `diff` `check` | Full JSON output |

The repo `lens` script is the CLI entrypoint (`pnpm lens <command>`). `@repolens/cli` also exposes a `repolens` bin; `pnpm link --global` from `packages/cli` if you want that on your PATH.

Default port **7173** avoids Vite (5173), 3000/8080, and macOS AirPlay Receiver on 5000/7000.

## Reviewing AI-sized diffs

```bash
pnpm lens diff                     # working tree (including uncommitted) vs HEAD
pnpm lens diff -b main             # current branch vs main
pnpm lens diff -b v1.2 --head v1.3 # between two refs
```

The report is ordered for review: change units along call relationships, behavior deltas (new/removed calls and I/O), new or removed module/library dependencies, export/signature changes, entry impact, and changed functions with no covering tests. Baselines are indexed from `git archive` snapshots under `.repolens/baselines/` without touching the working tree. The UI **Changes** tab shows the same report; with watch mode, structure refreshes as files change.

## Conventions: guarding structure

Committed at the repo root:

| File | Contents | Commit? |
| --- | --- | --- |
| `.repolens.json` | Dependency `rules`, confirmed `layers`, `ratchet` | Yes |
| `.repolens.lock.json` | Approved inter-module deps (`repolens lock`) | Yes |
| `.repolens.local.json` | Personal overrides (e.g. disable LLM for this repo) | No |

```bash
pnpm lens lock
pnpm lens check
pnpm lens check --baseline origin/main
```

Default ratchet: new `cycle`, `violation`, `unapproved`, `layering`, `bypass` fail; new `duplicate`, `oversized` warn. Existing debt is not blocked—only newly introduced issues.

## MCP for AI coding agents

```json
{
  "mcpServers": {
    "repolens": { "command": "repolens", "args": ["mcp", "/path/to/repo"] }
  }
}
```

Tools include `overview`, `conventions`, `module`, `find` / `symbol`, `boundary`, `spec`, `findings`, `changes`, and `check`. Between tool calls the server watches files and runs a structure-only incremental scan before answering when needed.

## Multiple repositories

Scanned repos are remembered in `~/.repolens/repos.json`. The UI top-bar name is a dropdown to switch or add repos without restarting. Indexes live under each repo’s `.repolens/` (add that directory to the scanned repo’s `.gitignore`). To compare two windows, start another server on another port:

```bash
pnpm lens serve ~/Workspace/pi -p 7174
```

## LLM semantic layer

Graphs and call relationships always come from parsers. The LLM only fills content labeled **AI-generated** (repo/package/directory summaries, layering proposals, file summaries, function pseudocode). If the model is unavailable, RepoLens falls back to structure-only mode.

Shared model config lives in `~/.config/repolens/config.json` (or `$XDG_CONFIG_HOME/repolens/config.json`):

```json
{
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "outputLanguage": "en",
    "enabled": true
  }
}
```

Any OpenAI-compatible Chat Completions endpoint works. Keys are read only from environment variables—never put secrets in JSON. Desktop can store the key in the OS keychain via Settings.

Merge order (later wins):

```text
built-in defaults → ~/.config/repolens/config.json → <repo>/.repolens.json → <repo>/.repolens.local.json
```

Repo-level config cannot change `llm.baseUrl` or `llm.apiKeyEnv` (cloning a stranger’s repo must not redirect your env-backed key to another host).

## Monorepo layout

| Package | Role |
| --- | --- |
| `packages/core` | Scan pipeline, SQLite index, diff/check, LLM helpers |
| `packages/cli` | `lens` / `repolens` CLI, MCP entry |
| `packages/server` | Local HTTP API + watch |
| `packages/web` | Vite UI |
| `packages/desktop` | Electron shell |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lens open .
```

See `docs/` for architecture, interaction notes, roadmap, and desktop packaging details.
