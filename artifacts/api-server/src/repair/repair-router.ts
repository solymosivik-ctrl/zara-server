import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { RepairIncidentInputSchema, repairResultMessageHu, type RepairIncidentRecord } from "./incident-model";
import { createRepairCandidate, type RepairCandidateResult } from "./orchestrator";
import type { RepairIncidentStore } from "./store";

const RepairCandidateInputSchema = (await import("zod")).z
  .object({
    incidentId: (await import("zod")).z.string().uuid(),
    patch: (await import("zod")).z.string().min(1).max(64 * 1024),
  })
  .strict();

const requestCounts = new Map<string, { count: number; resetAt: number }>();
const MAX_REPORTS_PER_MINUTE = 12;

export type RepairRouterOptions = {
  store: RepairIncidentStore;
  workerToken?: () => string | undefined;
  repoRoot: string;
  candidateRunner?: (options: {
    repoRoot: string;
    incidentId: string;
    patch: string;
  }) => Promise<RepairCandidateResult>;
};

function sendLog(
  req: Request,
  level: "info" | "warn",
  fields: Record<string, unknown>,
  message: string,
): void {
  const log = (req as Request & {
    log?: { info: (data: object, msg: string) => void; warn: (data: object, msg: string) => void };
  }).log;
  log?.[level](fields, message);
}

function equalToken(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

function requireWorkerToken(
  req: Request,
  res: Response,
  getToken: () => string | undefined,
): boolean {
  const expected = getToken();
  if (!expected) {
    res.status(503).json({
      code: "REPAIR_WORKER_DISABLED",
      messageHu: "A javítási munkafolyamat nincs biztonságosan engedélyezve.",
    });
    return false;
  }
  const authorization = req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match || !equalToken(match[1] ?? "", expected)) {
    res.status(401).json({
      code: "REPAIR_WORKER_UNAUTHORIZED",
      messageHu: "A javítási munkafolyamat hitelesítése sikertelen.",
    });
    return false;
  }
  return true;
}

function allowIncidentReport(req: Request, res: Response): boolean {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const current = requestCounts.get(key);
  if (!current || now >= current.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  if (current.count <= MAX_REPORTS_PER_MINUTE) return true;
  res.status(429).json({
    code: "REPAIR_REPORT_RATE_LIMITED",
    messageHu: "Túl sok diagnosztikai jelentés érkezett. Próbáld meg később.",
  });
  return false;
}

function publicIncident(record: RepairIncidentRecord) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    component: record.classification.component,
    confidence: record.classification.confidence,
    severity: record.classification.severity,
    summaryHu: record.classification.summaryHu,
    nextStepHu: record.classification.nextStepHu,
    state: record.state,
    candidateRef: record.candidateRef,
    checkpointRef: record.checkpointRef,
    tests: record.tests,
    messageHu: repairResultMessageHu(record),
  };
}

export function createRepairRouter(options: RepairRouterOptions): IRouter {
  const router: IRouter = Router();
  let candidateJobActive = false;
  const getWorkerToken = options.workerToken ?? (() => undefined);
  const runner = options.candidateRunner ?? createRepairCandidate;

  router.post("/repair/incidents", async (req, res) => {
    if (!allowIncidentReport(req, res)) return;
    const declaredSize = Number(req.header("content-length") ?? "0");
    if (Number.isFinite(declaredSize) && declaredSize > 16_384) {
      res.status(413).json({
        code: "REPAIR_REPORT_TOO_LARGE",
        messageHu: "A diagnosztikai jelentés túl nagy.",
      });
      return;
    }

    const parsed = RepairIncidentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "REPAIR_REPORT_INVALID",
        messageHu: "A diagnosztikai jelentés formátuma hibás vagy nem biztonságos mezőt tartalmaz.",
      });
      return;
    }

    const { randomUUID } = await import("node:crypto");
    const { classifyRepairIncident } = await import("./incident-model");
    const record: RepairIncidentRecord = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      input: parsed.data,
      classification: classifyRepairIncident(parsed.data),
      state: "diagnosed",
    };
    await options.store.create(record);
    sendLog(
      req,
      "info",
      {
        event: "zara.repair.incident",
        incidentId: record.id,
        source: record.input.source,
        errorCode: record.input.errorCode,
        component: record.classification.component,
        confidence: record.classification.confidence,
        severity: record.classification.severity,
        endpoint: record.input.endpoint ?? record.input.events.at(-1)?.endpoint ?? null,
        status: record.input.status ?? record.input.events.at(-1)?.status ?? null,
      },
      "Sanitized Zara repair incident received",
    );
    res.status(201).json(publicIncident(record));
  });

  router.post("/repair/candidates", async (req, res) => {
    if (!requireWorkerToken(req, res, getWorkerToken)) return;
    if (candidateJobActive) {
      res.status(409).json({
        code: "REPAIR_JOB_BUSY",
        messageHu: "Már fut egy javításjelölt-ellenőrzés.",
      });
      return;
    }
    const parsed = RepairCandidateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "REPAIR_CANDIDATE_INVALID",
        messageHu: "A javításjelölt adatai hibásak.",
      });
      return;
    }

    const incident = await options.store.get(parsed.data.incidentId);
    if (!incident) {
      res.status(404).json({
        code: "REPAIR_INCIDENT_NOT_FOUND",
        messageHu: "A diagnosztikai jelentés nem található.",
      });
      return;
    }
    if (incident.state === "candidate-running") {
      res.status(409).json({
        code: "REPAIR_CANDIDATE_ALREADY_RUNNING",
        messageHu: "Ehhez a jelentéshez már fut javításjelölt-ellenőrzés.",
      });
      return;
    }

    candidateJobActive = true;
    const running: RepairIncidentRecord = { ...incident, state: "candidate-running" };
    await options.store.update(running);
    res.status(202).json(publicIncident(running));

    void runner({
      repoRoot: options.repoRoot,
      incidentId: incident.id,
      patch: parsed.data.patch,
    })
      .then(async (result) => {
        const updated: RepairIncidentRecord = {
          ...running,
          state: result.state,
          checkpointRef: result.checkpointRef,
          candidateRef:
            result.state === "candidate-ready" ? result.candidateRef : undefined,
          tests: result.tests.map((test) => ({
            name: test.name,
            passed: test.passed,
            detail: test.detail?.slice(0, 1200),
          })),
        };
        await options.store.update(updated);
        sendLog(
          req,
          result.state === "candidate-ready" ? "info" : "warn",
          {
            event: "zara.repair.candidate",
            incidentId: incident.id,
            state: result.state,
            checkpointRef: result.checkpointRef ?? null,
            candidateRef:
              result.state === "candidate-ready" ? result.candidateRef : null,
            tests: result.tests.map(({ name, passed }) => ({ name, passed })),
          },
          "Zara repair candidate check completed",
        );
      })
      .catch(async () => {
        const failed: RepairIncidentRecord = {
          ...running,
          state: "candidate-failed",
          tests: [],
        };
        await options.store.update(failed);
        sendLog(
          req,
          "warn",
          { event: "zara.repair.candidate", incidentId: incident.id, state: "candidate-failed" },
          "Zara repair candidate orchestration failed",
        );
      })
      .finally(() => {
        candidateJobActive = false;
      });
  });

  router.get("/repair/incidents/:id", async (req, res) => {
    if (!requireWorkerToken(req, res, getWorkerToken)) return;
    const id = req.params.id;
    const incident = await options.store.get(id);
    if (!incident) {
      res.status(404).json({
        code: "REPAIR_INCIDENT_NOT_FOUND",
        messageHu: "A diagnosztikai jelentés nem található.",
      });
      return;
    }
    res.json(publicIncident(incident));
  });

  return router;
}
