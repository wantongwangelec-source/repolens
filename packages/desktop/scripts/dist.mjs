// Generate the installation package: first prepare app/, then call electron-builder, passing all other parameters as they are.
//
//   node scripts/dist.mjs --dir              Only generate a runnable application directory, do not create an installer
//   node scripts/dist.mjs --publish always   Package and upload to GitHub Releases draft (requires GH_TOKEN)
//
// The signing certificate is provided through environment variables (CSC_LINK / CSC_KEY_PASSWORD, APPLE_ID for notarization, etc.). When all are left blank:
// macOS uses ad-hoc signing. Macs with Apple chips will report completely unsigned applications as 'damaged'.
// After ad-hoc signing, it only prompts 'Unable to verify developer.' The user can allow it in the system settings.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNING_ENV = [
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER",
];

// Secrets not configured in CI will be expanded into empty strings, and electron-builder will treat them as configured but invalid.
const env = { ...process.env };
for (const name of SIGNING_ENV) if (env[name]?.trim() === "") delete env[name];

const args = process.argv.slice(2);
if (process.platform === "darwin" && env.CSC_LINK === undefined && env.CSC_NAME === undefined) {
  args.push("-c.mac.identity=-");
}

run(["scripts/build.mjs", "--stage"]);
run([join(root, "node_modules/electron-builder/cli.js"), ...args]);

function run(argv) {
  const result = spawnSync(process.execPath, argv, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
