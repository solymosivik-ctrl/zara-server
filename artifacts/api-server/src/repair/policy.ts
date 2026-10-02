import { createHash } from "node:crypto";

/**
 * V1 only permits changes to the non-audio health route. The Zara voice path,
 * Android sources, repair engine, policy, schemas, tests, and build files are
 * intentionally not patchable by an incoming repair candidate.
 */
export const REPAIR_ALLOWED_PATHS = [
  "artifacts/api-server/src/routes/health.ts",
] as const;

const MAX_PATCH_BYTES = 64 * 1024;
const POLICY_REVISION = "zara-repair-v1";

export type PatchPolicyResult =
  | { allowed: true; paths: string[]; policyHash: string }
  | { allowed: false; reason: string };

function normalizePatchPath(rawPath: string): string | null {
  if (
    rawPath === "/dev/null" ||
    rawPath.includes("\0") ||
    rawPath.startsWith("/") ||
    rawPath.includes("\\")
  ) {
    return null;
  }
  const parts = rawPath.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) {
    return null;
  }
  return rawPath;
}

export function validateRepairPatch(patch: string): PatchPolicyResult {
  if (Buffer.byteLength(patch, "utf8") === 0) {
    return { allowed: false, reason: "A javítási diff üres." };
  }
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    return { allowed: false, reason: "A javítási diff nagyobb a megengedettnél." };
  }
  if (
    patch.includes("\0") ||
    /^(?:GIT binary patch|literal \d+|rename from |rename to |copy from |copy to |new file mode |deleted file mode |old mode |new mode )/m.test(
      patch,
    )
  ) {
    return { allowed: false, reason: "Bináris, átnevezési vagy fájlmódosítási diff nem engedélyezett." };
  }

  const changedPaths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) continue;
    const rawPath = line.slice(4).split("\t", 1)[0]?.trim();
    if (!rawPath || rawPath === "/dev/null") {
      return { allowed: false, reason: "Új vagy törölt fájl nem engedélyezett." };
    }
    const normalized = normalizePatchPath(rawPath.replace(/^[ab]\//, ""));
    if (!normalized) {
      return { allowed: false, reason: "A diff nem biztonságos fájlútvonalat tartalmaz." };
    }
    changedPaths.add(normalized);
  }

  const allowedSet = new Set<string>(REPAIR_ALLOWED_PATHS);
  const paths = [...changedPaths];
  if (
    paths.length !== 1 ||
    paths.some((path) => !allowedSet.has(path))
  ) {
    return {
      allowed: false,
      reason: "A diff csak az engedélyezett health útvonalat módosíthatja.",
    };
  }

  const policyHash = createHash("sha256")
    .update(`${POLICY_REVISION}\n${REPAIR_ALLOWED_PATHS.join("\n")}`)
    .digest("hex");
  return { allowed: true, paths, policyHash };
}