import { z } from "zod";

const allowedEndpoints = [
  "/api/healthz",
  "/api/zara/chat",
  "/api/zara/weather",
  "/api/zara/transcribe",
  "/api/zara/speak",
] as const;

const RepairEventSchema = z
  .object({
    phase: z.enum(["before", "after", "error"]),
    endpoint: z.enum(allowedEndpoints),
    method: z.enum(["GET", "POST"]),
    status: z.number().int().min(100).max(599).nullable().optional(),
    durationMs: z.number().int().min(0).max(300_000).optional(),
  })
  .strict();

/**
 * The report intentionally has no free-text field. That prevents transcripts,
 * conversation content, credentials, and raw provider errors entering storage.
 */
export const RepairIncidentInputSchema = z
  .object({
    source: z.enum(["mobile", "api"]).default("mobile"),
    errorCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_.:-]+$/i)
      .transform((value) => value.toUpperCase()),
    endpoint: z.enum(allowedEndpoints).optional(),
    method: z.enum(["GET", "POST"]).optional(),
    status: z.number().int().min(100).max(599).optional(),
    durationMs: z.number().int().min(0).max(300_000).optional(),
    appVersion: z.string().trim().max(40).regex(/^[a-z0-9.+_-]*$/i).optional(),
    requestId: z.string().trim().max(80).regex(/^[a-z0-9_-]*$/i).optional(),
    events: z.array(RepairEventSchema).max(20).default([]),
  })
  .strict();

export type RepairIncidentInput = z.infer<typeof RepairIncidentInputSchema>;

export type RepairComponent =
  | "microphone"
  | "speech-recognition"
  | "text-to-speech"
  | "wake-word"
  | "audio-signal"
  | "api-connection"
  | "server-health"
  | "unknown";

export type RepairClassification = {
  component: RepairComponent;
  confidence: number;
  severity: "low" | "medium" | "high";
  summaryHu: string;
  nextStepHu: string;
};

const classifications: Record<RepairComponent, Omit<RepairClassification, "severity">> = {
  microphone: {
    component: "microphone",
    confidence: 0.96,
    summaryHu: "Mikrofon-hozzáférési vagy felvételindítási hiba.",
    nextStepHu: "Ellenőrizd a mikrofonengedélyt és a felvétel állapotát.",
  },
  "speech-recognition": {
    component: "speech-recognition",
    confidence: 0.95,
    summaryHu: "A beszédfelismerési kérés hibázott vagy nem kapott választ.",
    nextStepHu: "Ellenőrizd a felvétel formátumát, az API-választ és a felismerő elérhetőségét.",
  },
  "text-to-speech": {
    component: "text-to-speech",
    confidence: 0.95,
    summaryHu: "A beszédgenerálás vagy a lejátszás hibázott.",
    nextStepHu: "Ellenőrizd a TTS-szolgáltató válaszát és a lejátszási állapotot.",
  },
  "wake-word": {
    component: "wake-word",
    confidence: 0.92,
    summaryHu: "A wake-word felismerési útvonal adott hibát.",
    nextStepHu: "Ellenőrizd az ébresztőszó állapotát és a felismerési eseményeket.",
  },
  "audio-signal": {
    component: "audio-signal",
    confidence: 0.78,
    summaryHu: "A hangjel vagy a beszéd/szünet észlelése gyanús.",
    nextStepHu: "Vizsgáld meg a hangszint-jelöléseket; ez a jelentés nem módosítja a hangot.",
  },
  "api-connection": {
    component: "api-connection",
    confidence: 0.9,
    summaryHu: "A Zara API-kapcsolata hibázott.",
    nextStepHu: "Ellenőrizd az API-domain beállítását, az HTTP-státuszt és a kérés időtartamát.",
  },
  "server-health": {
    component: "server-health",
    confidence: 0.9,
    summaryHu: "A szerver egészségellenőrzése hibázott.",
    nextStepHu: "Ellenőrizd a szerverfolyamatot és a health végpontot.",
  },
  unknown: {
    component: "unknown",
    confidence: 0.2,
    summaryHu: "A hiba komponense nem azonosítható biztosan.",
    nextStepHu: "A rendszer csak diagnosztikai jelentést készít; automatikus javítás nem indul.",
  },
};

export function classifyRepairIncident(
  incident: RepairIncidentInput,
): RepairClassification {
  const endpoint =
    incident.endpoint ?? incident.events.at(-1)?.endpoint ?? "";
  const code = incident.errorCode;
  let component: RepairComponent = "unknown";

  if (/^(MIC|MICROPHONE|RECORDING)_/.test(code)) {
    component = "microphone";
  } else if (/^(WAKE|WAKEWORD)_/.test(code)) {
    component = "wake-word";
  } else if (/^(TTS|SPEAK|PLAYBACK)_/.test(code) || endpoint.endsWith("/speak")) {
    component = "text-to-speech";
  } else if (
    /^(STT|TRANSCRIBE|TRANSCRIPTION)_/.test(code) ||
    endpoint.endsWith("/transcribe")
  ) {
    component = "speech-recognition";
  } else if (/^(BEEP|TONE|AUDIO_SIGNAL)_/.test(code)) {
    component = "audio-signal";
  } else if (endpoint.endsWith("/healthz") || code.startsWith("HEALTH_")) {
    component = "server-health";
  } else if (
    code.startsWith("API_") ||
    code.startsWith("NETWORK_") ||
    code.startsWith("HTTP_") ||
    endpoint.startsWith("/api/")
  ) {
    component = "api-connection";
  }

  const base = classifications[component];
  const status = incident.status ?? incident.events.at(-1)?.status ?? undefined;
  const severity =
    (status !== undefined && status >= 500) ||
    /(_FATAL|_CRASH|_TIMEOUT)$/.test(code)
      ? "high"
      : status !== undefined && status >= 400
        ? "medium"
        : component === "unknown"
          ? "low"
          : "medium";

  return { ...base, severity };
}

export type RepairIncidentRecord = {
  id: string;
  createdAt: string;
  input: RepairIncidentInput;
  classification: RepairClassification;
  state: "diagnosed" | "candidate-running" | "candidate-ready" | "candidate-failed";
  checkpointRef?: string;
  candidateRef?: string;
  tests?: Array<{ name: string; passed: boolean; detail?: string }>;
};

export function repairResultMessageHu(
  incident: RepairIncidentRecord,
): string {
  if (incident.state === "candidate-ready") {
    return `${incident.classification.summaryHu} Elkülönített javításjelölt készült, az ellenőrzések sikerültek. A változtatás nincs élesítve.`;
  }
  if (incident.state === "candidate-failed") {
    return `${incident.classification.summaryHu} A javításjelölt ellenőrzése nem sikerült; a jelöltet eltávolítottam, az eredeti Git-visszaállítási pont megmaradt.`;
  }
  if (incident.state === "candidate-running") {
    return `${incident.classification.summaryHu} A javításjelölt ellenőrzése folyamatban van.`;
  }
  return `${incident.classification.summaryHu} ${incident.classification.nextStepHu}`;
}