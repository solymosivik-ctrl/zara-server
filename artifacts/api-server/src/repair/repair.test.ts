import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import express from "express";
import {
  classifyRepairIncident,
  RepairIncidentInputSchema,
  repairResultMessageHu,
  type RepairIncidentRecord,
} from "./incident-model";
import { createRepairCandidate } from "./orchestrator";
import { validateRepairPatch } from "./policy";
import { createRepairRouter } from "./repair-router";
import { MemoryRepairIncidentStore } from "./store";

const healthPath = "artifacts/api-server/src/routes/health.ts";

async function startRateLimitTestServer(trustRenderProxy: boolean) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(
    "/api",
    createRepairRouter({
      store: new MemoryRepairIncidentStore(),
      repoRoot: process.cwd(),
      trustRenderProxy,
    }),
  );
  const server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function diffFor(pathName: string, oldText: string, newText: string): string {
  return [
    `diff --git a/${pathName} b/${pathName}`,
    `index ${"a".repeat(7)}..${"b".repeat(7)} 100644`,
    `--- a/${pathName}`,
    `+++ b/${pathName}`,
    "@@ -1 +1 @@",
    `-${oldText}`,
    `+${newText}`,
    "",
  ].join("\n");
}

async function makeGitFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zara-repair-test-"));
  const healthFile = path.join(root, healthPath);
  await mkdir(path.dirname(healthFile), { recursive: true });
  await writeFile(healthFile, "export const healthStatus = 'ok';\n");
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Repair Tests"]);
  execFileSync("git", ["-C", root, "config", "user.email", "tests@localhost"]);
  execFileSync("git", ["-C", root, "add", "--", healthPath]);
  execFileSync("git", ["-C", root, "commit", "-m", "fixture"]);
  return root;
}

describe("incident validation and classification", () => {
  it("accepts only allowlisted, bounded diagnostic metadata", () => {
    const parsed = RepairIncidentInputSchema.safeParse({
      errorCode: "STT_HTTP_502",
      endpoint: "/api/zara/transcribe",
      method: "POST",
      status: 502,
      durationMs: 1500,
      appVersion: "1.2.3",
    });
    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.equal(
      classifyRepairIncident(parsed.data).component,
      "speech-recognition",
    );
  });

  it("rejects transcript/audio and arbitrary message fields", () => {
    const parsed = RepairIncidentInputSchema.safeParse({
      errorCode: "API_FAILURE",
      audioBase64: "not-accepted",
      transcript: "not-accepted",
      message: "not-accepted",
    });
    assert.equal(parsed.success, false);
  });

  it("rejects sensitive fields inside event metadata", () => {
    const parsed = RepairIncidentInputSchema.safeParse({
      errorCode: "API_FAILURE",
      events: [
        {
          phase: "error",
          endpoint: "/api/zara/chat",
          method: "POST",
          transcript: "must not be accepted",
        },
      ],
    });
    assert.equal(parsed.success, false);
  });

  it("classifies a beep hint without changing audio behavior", () => {
    const parsed = RepairIncidentInputSchema.parse({
      errorCode: "BEEP_SUSPECTED",
    });
    const classified = classifyRepairIncident(parsed);
    assert.equal(classified.component, "audio-signal");
    assert.equal(classified.severity, "low");
  });

  it("reports accurately whether a restore point exists after candidate failure", () => {
    const input = RepairIncidentInputSchema.parse({ errorCode: "HEALTH_POLICY_REJECTED" });
    const base: RepairIncidentRecord = {
      id: "test-incident",
      createdAt: new Date(0).toISOString(),
      input,
      classification: classifyRepairIncident(input),
      state: "candidate-failed",
    };
    assert.match(repairResultMessageHu(base), /visszaállítási pont nem készült/);
    assert.match(
      repairResultMessageHu({ ...base, checkpointRef: "zara-repair-before-test" }),
      /visszaállítási pont megmaradt/,
    );
  });
});

describe("repair path policy", () => {
  it("allows only the health route in a single-file patch", () => {
    const result = validateRepairPatch(
      diffFor(healthPath, "export const healthStatus = 'ok';", "export const healthStatus = 'ready';"),
    );
    assert.equal(result.allowed, true);
  });

  it("blocks voice, Android, policy, package, test, traversal, and multi-file patches", () => {
    const blockedPaths = [
      "artifacts/api-server/src/routes/zara.ts",
      "artifacts/zara-assistant/services/speech.ts",
      "artifacts/zara-assistant/android/app/src/main/AndroidManifest.xml",
      "artifacts/api-server/src/repair/policy.ts",
      "artifacts/api-server/package.json",
      "../outside.ts",
    ];
    for (const blockedPath of blockedPaths) {
      assert.equal(
        validateRepairPatch(diffFor(blockedPath, "old", "new")).allowed,
        false,
        blockedPath,
      );
    }
    const multiFile = `${diffFor(healthPath, "old", "new")}${diffFor(
      "artifacts/api-server/src/routes/zara.ts",
      "old",
      "new",
    )}`;
    assert.equal(validateRepairPatch(multiFile).allowed, false);
  });

  it("rejects additions, deletions, binary diffs, and oversized patches", () => {
    assert.equal(
      validateRepairPatch(
        [
          `diff --git a/${healthPath} b/${healthPath}`,
          `--- a/${healthPath}`,
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-old",
        ].join("\n"),
      ).allowed,
      false,
    );
    assert.equal(
      validateRepairPatch(`GIT binary patch\n${"x".repeat(100)}`).allowed,
      false,
    );
    assert.equal(validateRepairPatch("x".repeat(65 * 1024)).allowed, false);
  });
});

describe("isolated candidate worktree", () => {
  const roots: string[] = [];
  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  it("keeps the main branch unchanged and retains a tested candidate ref", async () => {
    const root = await makeGitFixture();
    roots.push(root);
    const before = await readFile(path.join(root, healthPath), "utf8");
    const result = await createRepairCandidate({
      repoRoot: root,
      incidentId: "incident-success",
      patch: diffFor(healthPath, "export const healthStatus = 'ok';", "export const healthStatus = 'ready';"),
      runChecks: async () => [{ name: "fixture-check", passed: true }],
    });
    assert.equal(result.state, "candidate-ready");
    if (result.state !== "candidate-ready") return;
    assert.equal(await readFile(path.join(root, healthPath), "utf8"), before);
    assert.match(
      execFileSync("git", ["-C", root, "show", `${result.candidateRef}:${healthPath}`], {
        encoding: "utf8",
      }),
      /ready/,
    );
    assert.equal(
      execFileSync("git", ["-C", root, "rev-parse", result.checkpointRef], {
        encoding: "utf8",
      }).trim().length > 0,
      true,
    );
  });

  it("deletes a failed candidate branch and preserves the restore tag", async () => {
    const root = await makeGitFixture();
    roots.push(root);
    const result = await createRepairCandidate({
      repoRoot: root,
      incidentId: "incident-failure",
      patch: diffFor(healthPath, "export const healthStatus = 'ok';", "export const healthStatus = 'broken';"),
      runChecks: async () => [{ name: "fixture-check", passed: false }],
    });
    assert.equal(result.state, "candidate-failed");
    assert.ok(result.checkpointRef);
    assert.match(
      execFileSync("git", ["-C", root, "tag", "--list", result.checkpointRef], {
        encoding: "utf8",
      }),
      new RegExp(result.checkpointRef ?? "never-match"),
    );
    assert.equal(
      execFileSync("git", ["-C", root, "branch", "--list", "zara-repair-candidate/*"], {
        encoding: "utf8",
      }).trim(),
      "",
    );
  });
});

describe("repair API", () => {
  const store = new MemoryRepairIncidentStore();
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(
    "/api",
    createRepairRouter({
      store,
      workerToken: () => "unit-test-private-token",
      repoRoot: process.cwd(),
      candidateRunner: async () => ({
        state: "candidate-ready",
        candidateRef: "zara-repair-candidate/test",
        checkpointRef: "zara-repair-before/test",
        tests: [{ name: "fixture-check", passed: true }],
      }),
    }),
  );
  const server = app.listen(0);
  let baseUrl = "";
  const ready = new Promise<void>((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        baseUrl = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    });
  });
  after(async () => {
    await ready;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("creates a sanitized Hungarian incident report", async () => {
    await ready;
    const response = await fetch(`${baseUrl}/api/repair/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        errorCode: "STT_HTTP_502",
        endpoint: "/api/zara/transcribe",
        method: "POST",
        status: 502,
      }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      id: string;
      component: string;
      messageHu: string;
    };
    assert.equal(body.component, "speech-recognition");
    assert.match(body.messageHu, /beszédfelismerési/i);
    assert.ok(await store.get(body.id));
  });

  it("rejects raw audio fields and protects candidate operations", async () => {
    await ready;
    const rejected = await fetch(`${baseUrl}/api/repair/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorCode: "API_FAILURE", audioBase64: "secret" }),
    });
    assert.equal(rejected.status, 400);

    const oversized = await fetch(`${baseUrl}/api/repair/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorCode: "API_FAILURE", arbitrary: "x".repeat(17_000) }),
    });
    assert.equal(oversized.status, 413);

    const unauthorized = await fetch(`${baseUrl}/api/repair/candidates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId: "00000000-0000-4000-8000-000000000000", patch: "x" }),
    });
    assert.equal(unauthorized.status, 401);

    const voiceIncidentResponse = await fetch(`${baseUrl}/api/repair/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        errorCode: "STT_HTTP_502",
        endpoint: "/api/zara/transcribe",
        status: 502,
      }),
    });
    const voiceIncident = (await voiceIncidentResponse.json()) as { id: string };
    const outOfScope = await fetch(`${baseUrl}/api/repair/candidates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer unit-test-private-token",
      },
      body: JSON.stringify({
        incidentId: voiceIncident.id,
        patch: "must not reach worker",
      }),
    });
    assert.equal(outOfScope.status, 403);
  });

  it("accepts an authorized candidate request and exposes only its status", async () => {
    await ready;
    const incidentResponse = await fetch(`${baseUrl}/api/repair/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorCode: "HEALTH_CHECK_FAILED", endpoint: "/api/healthz" }),
    });
    const incident = (await incidentResponse.json()) as { id: string };
    const response = await fetch(`${baseUrl}/api/repair/candidates`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer unit-test-private-token",
      },
      body: JSON.stringify({ incidentId: incident.id, patch: "candidate patch omitted" }),
    });
    assert.equal(response.status, 202);
    const body = (await response.json()) as { state: string; messageHu: string };
    assert.equal(body.state, "candidate-running");
    assert.match(body.messageHu, /folyamatban/i);

    let status = body.state;
    for (let attempt = 0; attempt < 20 && status === "candidate-running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const statusResponse = await fetch(`${baseUrl}/api/repair/incidents/${incident.id}`, {
        headers: { authorization: "Bearer unit-test-private-token" },
      });
      const statusBody = (await statusResponse.json()) as { state: string };
      status = statusBody.state;
    }
    assert.equal(status, "candidate-ready");
  });

  it("rate-limits Render clients independently and ignores spoofed X-Forwarded-For", async () => {
    const testServer = await startRateLimitTestServer(true);
    try {
      for (let request = 0; request < 12; request += 1) {
        const response = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "2001:0db8:0:0:0:0:0:1",
            "x-forwarded-for": `198.51.100.${request + 1}`,
          },
          body: JSON.stringify({ errorCode: "API_FAILURE" }),
        });
        assert.equal(response.status, 201);
      }

      const limitedClient = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "2001:db8::1",
          "x-forwarded-for": "198.51.100.250",
        },
        body: JSON.stringify({ errorCode: "API_FAILURE" }),
      });
      assert.equal(limitedClient.status, 429);

      const separateClient = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.11",
          "x-forwarded-for": "198.51.100.250",
        },
        body: JSON.stringify({ errorCode: "API_FAILURE" }),
      });
      assert.equal(separateClient.status, 201);

      const missingProxyIp = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.12",
        },
        body: JSON.stringify({ errorCode: "API_FAILURE" }),
      });
      assert.equal(missingProxyIp.status, 503);

      const malformedProxyIp = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.12, 198.51.100.12",
        },
        body: JSON.stringify({ errorCode: "API_FAILURE" }),
      });
      assert.equal(malformedProxyIp.status, 503);
    } finally {
      await testServer.close();
    }
  });

  it("does not trust caller-supplied forwarding headers outside Render", async () => {
    const testServer = await startRateLimitTestServer(false);
    try {
      for (let request = 0; request < 12; request += 1) {
        const response = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": `203.0.113.${request + 1}`,
            "x-forwarded-for": `198.51.100.${request + 1}`,
          },
          body: JSON.stringify({ errorCode: "API_FAILURE" }),
        });
        assert.equal(response.status, 201);
      }

      const spoofedForwardedIp = await fetch(`${testServer.baseUrl}/api/repair/incidents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.250",
          "x-forwarded-for": "198.51.100.250",
        },
        body: JSON.stringify({ errorCode: "API_FAILURE" }),
      });
      assert.equal(spoofedForwardedIp.status, 429);
    } finally {
      await testServer.close();
    }
  });
});
