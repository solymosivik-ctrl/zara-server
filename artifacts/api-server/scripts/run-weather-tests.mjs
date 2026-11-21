import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "zara-weather-tests-"),
);
const tests = [
  { name: "weather-place", entry: "src/routes/weather-place.test.ts" },
  { name: "weather-provider", entry: "src/routes/weather-provider.test.ts" },
];

try {
  await build({
    entryPoints: tests.map(({ name, entry }) => ({
      in: path.join(packageRoot, entry),
      out: path.join(temporaryDirectory, name),
    })),
    outdir: temporaryDirectory,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node:*"],
    logLevel: "silent",
  });
  const result = spawnSync(
    process.execPath,
    ["--test", ...tests.map(({ name }) => path.join(temporaryDirectory, `${name}.cjs`))],
    {
      cwd: packageRoot,
      stdio: "inherit",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: os.tmpdir(),
        CI: "1",
        NO_COLOR: "1",
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
