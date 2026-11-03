import picomatch from "picomatch";
import type { FileRole, Language } from "../types.js";

/**
 * Character determination rules. The order corresponds to priority, and the first rule that is met determines the character.
 *
 * These rules directly determine what appears in the default view and belong to docs/INTERACTION.md
 * The implementation details of the 'delete' policy, the cost of false positives is that users cannot see the code they want to see,
 * So it's better to miss a judgment (treat it as a source) than to make a wrong judgment.
 */
interface RoleRule {
  role: FileRole;
  patterns: string[];
}

const RULES: RoleRule[] = [
  {
    role: "vendor",
    patterns: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/third_party/**",
      "**/third-party/**",
      "**/thirdparty/**",
      "**/3rd_party/**",
      "**/3rd-party/**",
      "**/bower_components/**",
      "**/jspm_packages/**",
      "**/web_modules/**",
      "**/.yarn/cache/**",
      "**/.yarn/unplugged/**",
      "**/.yarn/sdks/**",
      "**/Godeps/_workspace/**",
      "**/Pods/**",
      "**/Carthage/Build/**",
      "**/.venv/**",
      "**/site-packages/**",
    ],
  },
  {
    role: "test",
    patterns: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.go",
      "**/*_test.py",
      "**/test_*.py",
      "**/__tests__/**",
      "**/__mocks__/**",
      "**/tests/**",
      "**/test/**",
      "**/e2e/**",
      "**/conftest.py",
      "**/*.bench.*",
      "**/benches/**",
      "**/__fixtures__/**",
      "**/__snapshots__/**",
      "**/*.snap",
      "**/testdata/**",
      "**/test-data/**",
      "**/{test,tests,spec,specs}/fixtures/**",
      "**/*.stories.*",
      "**/*.story.*",
      "**/integration-tests/**",
      "**/integration_test/**",
    ],
  },
  {
    role: "generated",
    patterns: [
      "**/*.pb.go",
      "**/*_pb2.py",
      "**/*_pb2_grpc.py",
      "**/*.pb.ts",
      "**/*.pb.js",
      "**/*_pb.js",
      "**/*.pb.rs",
      "**/*_grpc.pb.go",
      "**/*.generated.*",
      "**/*.gen.*",
      "**/*.gen.go",
      "**/*_generated.py",
      "**/*.designer.*",
      "**/*.feature.cs",
      "**/generated/**",
      "**/__generated__/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/debug/**",
      "**/target/release/**",
      "**/*.min.js",
      "**/*.min.css",
      "**/*.js.map",
      "**/*.css.map",
      "**/htmlcov/**",
      "**/storybook-static/**",
      "**/.docusaurus/**",
      "**/.vitepress/cache/**",
      "**/.vitepress/dist/**",
    ],
  },
  {
    role: "config",
    patterns: [
      "**/*.config.*",
      "**/*.conf.*",
      // JSON usually carries configuration, lists, or static data and does not contain callable program logic.
      // Even if the file is very large, turning it into a source code node will only push out the actual implementation file.
      "**/*.json",
      "**/*.jsonc",
      "**/tsconfig*.json",
      "**/jsconfig*.json",
      "**/package.json",
      "**/pnpm-workspace.yaml",
      "**/go.mod",
      "**/go.sum",
      "**/Cargo.toml",
      "**/Cargo.lock",
      "**/pyproject.toml",
      "**/setup.py",
      "**/setup.cfg",
      "**/requirements*.txt",
      "**/Makefile",
      "**/Dockerfile*",
      "**/docker-compose*.y*ml",
      "**/*.lock",
      "**/.eslintrc*",
      "**/.prettierrc*",
      "**/prettierrc.*",
      "**/.babelrc*",
      "**/.stylelintrc*",
      "**/.commitlintrc*",
      "**/.lintstagedrc*",
      "**/.editorconfig",
      "**/.gitignore",
      "**/.gitattributes",
      "**/.gitmodules",
      "**/.ignore",
      "**/.repolensignore",
      "**/.dockerignore",
      "**/.npmignore",
      "**/.prettierignore",
      "**/.eslintignore",
      "**/.stylelintignore",
      "**/.npmrc",
      "**/.yarnrc*",
      "**/.nvmrc",
      "**/.tool-versions",
      "**/biome.json",
      "**/.cursor/**",
      "**/.vscode/**",
      "**/.devcontainer/**",
      "**/.fleet/**",
      "**/.zed/**",
      "**/.obsidian/**",
      "**/.teamcity/**",
      "**/.circleci/**",
      "**/.husky/**",
      "**/.changeset/**",
      "**/.storybook/**",
      "**/.env",
      "**/.env.*",
      // Only hide explicit build entry points; ordinary shell scripts may still be the core logic of the repository.
      "**/build.sh",
      "**/.github/**",
      "**/*.yaml",
      "**/*.yml",
      "**/*.toml",
      "**/*.ini",
      "**/go.work",
      "**/go.work.sum",
      "**/Pipfile*",
      "**/Gemfile*",
      "**/pom.xml",
      "**/build.gradle*",
      "**/settings.gradle*",
      "**/gradle.properties",
      "**/WORKSPACE*",
      "**/BUILD",
      "**/BUILD.bazel",
      "**/*.csproj",
      "**/*.fsproj",
      "**/*.vbproj",
      "**/*.sln",
      "**/Taskfile*",
      "**/Justfile",
      "**/Procfile",
      "**/Vagrantfile",
      "**/Jenkinsfile",
    ],
  },
  {
    role: "docs",
    patterns: [
      "**/*.md",
      "**/*.mdx",
      "**/*.rst",
      "**/*.txt",
      "**/docs/**",
      "**/documentation/**",
      "**/javadoc/**",
      "**/README*",
      "**/CHANGELOG*",
      "**/CHANGES*",
      "**/CONTRIBUTING*",
      "**/CODE_OF_CONDUCT*",
      "**/SECURITY*",
      "**/AUTHORS*",
      "**/NOTICE*",
      "**/COPYING*",
      "**/LICENSE*",
    ],
  },
  {
    role: "asset",
    patterns: [
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.svg",
      "**/*.ico",
      "**/*.webp",
      "**/*.woff*",
      "**/*.ttf",
      "**/*.wasm",
      "**/*.node",
      "**/*.pdf",
      "**/*.{zip,gz,tgz,bz2,xz,7z,rar,tar}",
      "**/*.{mp3,mp4,m4a,mov,avi,webm,wav,flac,ogg}",
      "**/*.{eot,otf,doc,docx,xls,xlsx,ppt,pptx}",
      "**/*.{exe,dll,dylib,so,a,o,obj,class,jar}",
      "**/public/**",
      "**/assets/**",
    ],
  },
];

const MATCHERS = RULES.map((rule) => ({
  role: rule.role,
  match: picomatch(rule.patterns, { dot: true }),
}));

const D_TS = picomatch("**/*.d.ts", { dot: true });
const PYI = picomatch("**/*.pyi", { dot: true });

export type RoleClassifier = (path: string, language: Language, source?: string) => FileRole;

/** Create a classifier with explicit overrides; later-written globs take priority, making it easier for repository configurations to override global settings. */
export function createRoleClassifier(overrides: Record<string, FileRole>): RoleClassifier {
  const explicit = Object.entries(overrides)
    .map(([pattern, role]) => ({ role, match: picomatch(pattern, { dot: true }) }))
    .reverse();
  return (path, language, source) => {
    for (const item of explicit) if (item.match(path)) return item.role;
    return classifyRole(path, language, source);
  };
}

/**
 * Determine the role of the document.
 *
 * `language` is involved in the judgment because pure type declaration files (`.d.ts`) have the same extension as TS source code,
 * But in the context of the dependency graph, the meaning is completely different—they do not contain runtime logic, and adding them to the call graph would only increase noise.
 */
export function classifyRole(path: string, language: Language, source?: string): FileRole {
  for (const { role, match } of MATCHERS) {
    if (match(path)) return role;
  }
  if (D_TS(path) || PYI(path)) return "types";
  if (source !== undefined && isGeneratedSource(source)) return "generated";
  // Unknown suffixes are no longer uniformly regarded as resources: many niche languages, suffixless scripts, and DSLs are readable source code.
  // Only content detected as binary will be hidden; text files can still be counted, viewed, and handed over for AI understanding.
  if (language === "other" && source !== undefined && !isProbablyText(source)) return "asset";
  return "source";
}

/** Conservative text detection similar to GitHub Linguist: NUL must be binary, and a high proportion of control characters is also hidden. */
function isProbablyText(source: string): boolean {
  if (source.includes("\0")) return false;
  const sample = source.slice(0, 8_000);
  if (sample.length === 0) return true;
  let controls = 0;
  let replacement = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (char === "�") replacement++;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) controls++;
  }
  return controls / sample.length < 0.01 && replacement / sample.length < 0.02;
}

/**
 * Only check the high-confidence generation markers at the beginning of the source code. Both GitHub Linguist and scc
 * "generated / do not edit" as a second piece of evidence outside the path rules; limited to the first 40 lines,
 * Avoid misjudgment when these words accidentally appear in business strings or generator template bodies.
 */
function isGeneratedSource(source: string): boolean {
  const lines = source.slice(0, 12_000).split(/\r?\n/, 40);
  const marker = /(?:code\s+generated[^\n]{0,160}do\s+not\s+edit|<auto-generated(?:\s|\/|>)|@generated\b|(?:this\s+file\s+(?:is|was)|file\s+was)\s+(?:automatically\s+|auto[- ]?)?generated|(?:auto[- ]?|automatically\s+)generated[^\n]{0,160}do\s+not\s+edit|generated\s+file[^\n]{0,120}do\s+not\s+edit)/i;
  return lines.some((line) => {
    const comment = /^\s*(?:\/\/|#|\/\*+|\*|<!--)\s?(.*)$/.exec(line);
    return comment?.[1] !== undefined && marker.test(comment[1]);
  });
}

/** Pure type declaration file: does not produce runtime dependencies when imported */
export function isTypeDeclaration(path: string): boolean {
  return D_TS(path) || PYI(path);
}
