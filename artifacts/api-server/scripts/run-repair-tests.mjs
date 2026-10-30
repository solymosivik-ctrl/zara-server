import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "zara-repair-tests-"));
const testBundle = path.join(temporaryDirectory, "repair.test.cjs");

try {
  await build({
    entryPoints: [path.join(packageRoot, "src/repair/repair.test.ts")],
    outfile: testBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node:*"],
    logLevel: "silent",
  });
  const result = spawnSync(process.execPath, ["--test", testBundle], {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: os.tmpdir(),
      CI: "1",
      NO_COLOR: "1",
    },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}