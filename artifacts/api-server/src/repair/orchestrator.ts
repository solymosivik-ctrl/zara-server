import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRepairPatch } from "./policy";

export type CandidateTestResult = {
  name: string;
  passed: boolean;
  detail?: string;
};

export type RepairCandidateResult =
  | {
      state: "candidate-ready";
      candidateRef: string;
      checkpointRef: string;
      tests: CandidateTestResult[];
    }
  | {
      state: "candidate-failed";
      checkpointRef?: string;
      tests: CandidateTestResult[];
      reason: string;
    };

type ProcessResult = { code: number; output: string };
export type CandidateCheckRunner = (
  worktreePath: string,
) => Promise<CandidateTestResult[]>;

const CHECK_COMMANDS = [
  {
    name: "api-server-typecheck",
    args: ["--filter", "@workspace/api-server", "run", "typecheck"],
  },
  {
    name: "repair-unit-and-api-tests",
    args: ["--filter", "@workspace/api-server", "run", "test:repair"],
  },
] as const;

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    input?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      finish(new Error(`${command} timed out`));
    }, options.timeoutMs ?? 120_000);

    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();

    function finish(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function git(
  root: string,
  args: string[],
  input?: string,
): Promise<ProcessResult> {
  return runProcess("git", ["-C", root, ...args], {
    cwd: root,
    input,
    timeoutMs: 20_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? os.tmpdir(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

async function mustGit(
  root: string,
  args: string[],
  input?: string,
): Promise<string> {
  const result = await git(root, args, input);
  if (result.code !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.output.slice(-1500)}`);
  }
  return result.output.trim();
}

async function createWorkspaceDependencyLinks(
  sourceRoot: string,
  worktreePath: string,
): Promise<void> {
  const candidates = [path.join(sourceRoot, "node_modules")];
  for (const packageRoot of ["artifacts", "lib", "scripts"]) {
    const parent = path.join(sourceRoot, packageRoot);
    let entries: string[] = [];
    try {
      entries = await readdir(parent);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nodeModulesPath = path.join(parent, entry, "node_modules");
      try {
        const stat = await lstat(nodeModulesPath);
        if (stat.isDirectory() || stat.isSymbolicLink()) candidates.push(nodeModulesPath);
      } catch {
        // A package does not have installed dependencies in this workspace.
      }
    }
  }

  for (const source of candidates) {
    const relative = path.relative(sourceRoot, source);
    const destination = path.join(worktreePath, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(source, destination, "dir");
  }
}

export const runCandidateChecks: CandidateCheckRunner = async (worktreePath) => {
  const results: CandidateTestResult[] = [];
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: worktreePath,
    TMPDIR: os.tmpdir(),
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  for (const check of CHECK_COMMANDS) {
    try {
      const result = await runProcess("pnpm", check.args, {
        cwd: worktreePath,
        env: safeEnv,
        timeoutMs: 180_000,
      });
      results.push({
        name: check.name,
        passed: result.code === 0,
        detail: result.code === 0 ? undefined : result.output.slice(-1200),
      });
      if (result.code !== 0) break;
    } catch (error) {
      results.push({
        name: check.name,
        passed: false,
        detail: error instanceof Error ? error.message : "Ellenőrzési hiba.",
      });
      break;
    }
  }
  return results;
};

export async function createRepairCandidate(options: {
  repoRoot: string;
  incidentId: string;
  patch: string;
  runChecks?: CandidateCheckRunner;
}): Promise<RepairCandidateResult> {
  const policy = validateRepairPatch(options.patch);
  if (!policy.allowed) {
    return {
      state: "candidate-failed",
      tests: [],
      reason: policy.reason,
    };
  }

  const id = randomUUID();
  const tagName = `zara-repair-before-${id}`;
  const branchName = `zara-repair-candidate/${id}`;
  let worktreePath: string | undefined;
  let tempRoot: string | undefined;
  let checkpointCreated = false;
  let branchCreated = false;
  let tests: CandidateTestResult[] = [];

  try {
    const root = await mustGit(options.repoRoot, ["rev-parse", "--show-toplevel"]);
    const status = await mustGit(root, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (status) {
      return {
        state: "candidate-failed",
        tests: [],
        reason: "A forrásmunkafa nem tiszta; a javítás biztonságosan nem indítható.",
      };
    }

    await mustGit(root, ["tag", tagName, "HEAD"]);
    checkpointCreated = true;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "zara-repair-"));
    worktreePath = path.join(tempRoot, "worktree");
    await mustGit(root, ["worktree", "add", "--detach", worktreePath, tagName]);
    await createWorkspaceDependencyLinks(root, worktreePath);

    const patchCheck = await git(worktreePath, ["apply", "--check", "-"], options.patch);
    if (patchCheck.code !== 0) {
      throw new Error(`A diff nem alkalmazható: ${patchCheck.output.slice(-1000)}`);
    }
    const applied = await git(worktreePath, ["apply", "--"], options.patch);
    if (applied.code !== 0) {
      throw new Error(`A diff alkalmazása sikertelen: ${applied.output.slice(-1000)}`);
    }

    const changedPaths = (await mustGit(root, [
      "-C",
      worktreePath,
      "diff",
      "--name-only",
    ]))
      .split("\n")
      .filter(Boolean);
    if (
      changedPaths.length !== 1 ||
      changedPaths[0] !== policy.paths[0]
    ) {
      throw new Error("A tényleges diff eltér az engedélyezett fájllistától.");
    }

    tests = await (options.runChecks ?? runCandidateChecks)(worktreePath);
    if (tests.length === 0 || tests.some((test) => !test.passed)) {
      throw new Error("A javításjelölt egyik automatikus ellenőrzése sikertelen.");
    }

    await mustGit(worktreePath, ["switch", "-c", branchName]);
    branchCreated = true;
    await mustGit(worktreePath, ["add", "--", ...policy.paths]);
    await mustGit(worktreePath, [
      "-c",
      "user.name=Zara Repair Candidate",
      "-c",
      "user.email=zara-repair@localhost",
      "commit",
      "-m",
      `Repair candidate ${options.incidentId}`,
    ]);
    await mustGit(root, ["worktree", "remove", "--force", worktreePath]);
    worktreePath = undefined;
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });

    return {
      state: "candidate-ready",
      candidateRef: branchName,
      checkpointRef: tagName,
      tests,
    };
  } catch (error) {
    if (worktreePath) {
      await git(options.repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(
        () => undefined,
      );
    }
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (branchCreated) {
      await git(options.repoRoot, ["branch", "-D", branchName]).catch(() => undefined);
    }
    return {
      state: "candidate-failed",
      checkpointRef: checkpointCreated ? tagName : undefined,
      tests,
      reason: error instanceof Error ? error.message : "Ismeretlen javítási hiba.",
    };
  }
}