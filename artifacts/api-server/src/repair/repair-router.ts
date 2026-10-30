import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Router, type IRouter, type Request, type Response } from "express";
import { CreateRepairCandidateBody } from "@workspace/api-zod";
import {
  classifyRepairIncident,
  RepairIncidentInputSchema,
  repairResultMessageHu,
  type RepairIncidentRecord,
} from "./incident-model";
import { createRepairCandidate, type RepairCandidateResult } from "./orchestrator";
import type { RepairIncidentStore } from "./store";

const RepairCandidateInputSchema = CreateRepairCandidateBody.strict();

const MAX_REPORTS_PER_MINUTE = 12;
const REPORT_WINDOW_MS = 60_000;

export type RepairRouterOptions = {
  store: RepairIncidentStore;
  workerToken?: () => string | undefined;
  repoRoot: string;
  trustRenderProxy?: boolean;
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

function normalizeIpAddress(value: string | undefined): string | undefined {
  const address = value?.trim();
  if (!address) return undefined;

  const version = isIP(address);
  if (version === 4) return address;
  if (version !== 6) return undefined;

  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
}

function incidentRateLimitKey(req: Request, trustRenderProxy: boolean): string | undefined {
  if (trustRenderProxy) {
    // Render's Cloudflare edge overwrites CF-Connecting-IP. Do not trust
    // X-Forwarded-For here: it can contain values supplied by the caller.
    const clientIp = normalizeIpAddress(req.get("cf-connecting-ip"));
    return clientIp ? `ip:${clientIp}` : undefined;
  }

  const socketIp = normalizeIpAddress(req.socket.remoteAddress);
  return socketIp ? `ip:${socketIp}` : undefined;
}

function allowIncidentReport(
  req: Request,
  res: Response,
  requestCounts: Map<string, { count: number; resetAt: number }>,
  trustRenderProxy: boolean,
): boolean {
  const key = incidentRateLimitKey(req, trustRenderProxy);
  if (!key) {
    res.status(503).json({
      code: "REPAIR_CLIENT_IP_UNAVAILABLE",
      messageHu: "A biztonságos jelentésküldéshez nem állapítható meg a kliens címe.",
    });
    return false;
  }

  const now = Date.now();
  for (const [address, count] of requestCounts) {
    if (now >= count.resetAt) requestCounts.delete(address);
  }
  if (requestCounts.size >= 1024 && !requestCounts.has(key)) {
    const oldest = requestCounts.keys().next().value;
    if (oldest) requestCounts.delete(oldest);
  }
  const current = requestCounts.get(key);
  if (!current || now >= current.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + REPORT_WINDOW_MS });
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
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  let candidateJobActive = false;
  const getWorkerToken = options.workerToken ?? (() => undefined);
  const runner = options.candidateRunner ?? createRepairCandidate;

  router.post("/repair/incidents", async (req, res) => {
    if (
      !allowIncidentReport(
        req,
        res,
        requestCounts,
        options.trustRenderProxy ?? false,
      )
    ) {
      return;
    }
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
        endpoint:
          record.input.endpoint ?? record.input.events?.at(-1)?.endpoint ?? null,
        status: record.input.status ?? record.input.events?.at(-1)?.status ?? null,
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
    if (incident.classification.component !== "server-health") {
      res.status(403).json({
        code: "REPAIR_COMPONENT_OUT_OF_SCOPE",
        messageHu:
          "Az első javítási verzió kizárólag a szerver health útvonalára készíthet jelöltet.",
      });
      return;
    }
    if (candidateJobActive) {
      res.status(409).json({
        code: "REPAIR_JOB_BUSY",
        messageHu: "Már fut egy javításjelölt-ellenőrzés.",
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
      .catch(() => {
        const failed: RepairIncidentRecord = {
          ...running,
          state: "candidate-failed",
          tests: [],
        };
        void options.store
          .update(failed)
          .then(() =>
            sendLog(
              req,
              "warn",
              {
                event: "zara.repair.candidate",
                incidentId: incident.id,
                state: "candidate-failed",
              },
              "Zara repair candidate orchestration failed",
            ),
          )
          .catch(() => undefined);
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
