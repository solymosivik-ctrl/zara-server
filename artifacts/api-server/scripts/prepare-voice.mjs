import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Install the same pinned CPU Python dependencies for production.
// Private samples and model weights are never embedded in the repository/image.
const result = spawnSync("uv", [
  "sync", "--frozen", "--no-dev", "--python", "3.13", "--project", root,
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(root, ".pythonlibs") },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
