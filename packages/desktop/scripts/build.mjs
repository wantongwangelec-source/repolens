// Put everything needed for the desktop version into app/, electron-builder will only package this directory.
//
//   node scripts/build.mjs          For development: bundle JS, copy frontend artifacts, runtime dependencies are resolved from pnpm's node_modules
//   node scripts/build.mjs --stage  For release: then copy the runtime dependencies into a flat app/node_modules
//
// The main process, preload, and service process are all bundled into single CJS files using esbuild. Only three packages are left out:
// better-sqlite3 (native module, select precompiled binaries by platform) and two tree-sitter packages (at runtime according to
// Path reads .wasm files). None of them can be bundled.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const stage = process.argv.includes("--stage");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const RUNTIME_PACKAGES = Object.keys(pkg.dependencies);
/** It is only used when compiling native modules from source; we are using precompiled binaries. */
const BUILD_ONLY = new Set(["node-addon-api"]);
/** Source code, compiled intermediate products, debug versions, and type declarations are not included in the installation package */
const DROP_TOP_DIRS = new Set(["src", "deps", "build", "debug", "test", "docs"]);

const webDist = resolve(root, "../web/dist");
const scanWorker = resolve(root, "../server/dist/scan-worker.js");
for (const [path, hint] of [[webDist, "pnpm --filter @repolens/web build"], [scanWorker, "pnpm run build:node"]]) {
  if (!existsSync(path)) throw new Error(`缺少 ${relative(root, path)}，先运行 ${hint}`);
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: stage ? false : "linked",
  logLevel: "warning",
};

// The core and server are ESM, using import.meta.url to locate adjacent files (scanning worker and wasm syntax).
// After converting to CJS, replace it with the URL of the product file, and the relative position will be the same as in the source code.
const importMetaUrl = {
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__importMetaUrl" },
};

await Promise.all([
  build({ ...common, entryPoints: { main: "src/main.ts", preload: "src/preload.ts" }, outdir: appDir, external: ["electron"] }),
  build({
    ...common,
    ...importMetaUrl,
    // The file name must be scan-worker.js: ScanManager looks for it next to the service artifact by this name
    entryPoints: { server: "src/server-process.ts", "scan-worker": scanWorker },
    outdir: appDir,
    external: ["electron", ...RUNTIME_PACKAGES],
  }),
]);

cpSync(webDist, join(appDir, "web"), { recursive: true });
cpSync(join(root, "build/icon.png"), join(appDir, "icon.png"));

writeFileSync(join(appDir, "package.json"), `${JSON.stringify({
  name: "repolens",
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  homepage: pkg.homepage,
  main: "main.js",
  // During development, dependencies are resolved from the node_modules of the upper level; only the published package needs to declare them.
  ...(stage ? { dependencies: Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, pkg.dependencies[name]])) } : {}),
}, null, 2)}\n`);

if (stage) {
  const copied = new Set();
  for (const name of RUNTIME_PACKAGES) copyPackage(name, root, copied);
  console.log(`已复制运行时依赖：${[...copied].sort().join(", ")}`);
}

/** Find the package directory according to Node's lookup rules, and copy it along with its runtime dependencies into a flat structure */
function copyPackage(name, fromDir, copied) {
  if (copied.has(name) || BUILD_ONLY.has(name)) return;
  const source = findPackageDir(name, fromDir);
  const target = join(appDir, "node_modules", ...name.split("/"));
  cpSync(source, target, { recursive: true, filter: (path) => keep(relative(source, path)) });
  copied.add(name);
  const meta = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const dep of Object.keys(meta.dependencies ?? {})) copyPackage(dep, source, copied);
}

function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`找不到依赖 ${name}（从 ${fromDir} 查找）`);
  }
}

function keep(rel) {
  if (rel === "") return true;
  const parts = rel.split(sep);
  if (DROP_TOP_DIRS.has(parts[0]) || parts.includes("node_modules")) return false;
  return !/\.(map|d\.c?ts|d\.mts|gyp)$/i.test(parts.at(-1));
}
