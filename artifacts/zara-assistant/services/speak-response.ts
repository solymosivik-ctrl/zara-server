export type SpeakResponseLike = {
  audioBase64?: unknown;
  jobId?: unknown;
  message?: unknown;
  mimeType?: unknown;
  retryAfterMs?: unknown;
  status?: unknown;
};

export type ParsedSpeakAudio =
  | { ok: true; audioBase64: string; audioBytes: Uint8Array }
  | { ok: false; reason: string };

export function isSpeakJobPending(value: SpeakResponseLike): boolean {
  return value.status === "queued" || value.status === "processing";
}

export function decodeBase64Audio(base64: string): Uint8Array {
  const normalized = base64.replace(/\s/g, "");
  if (
    !normalized ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.length % 4 === 1 ||
    (normalized.includes("=") && normalized.length % 4 !== 0)
  ) {
    throw new Error("Invalid base64 audio data.");
  }

  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = globalThis.atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function parseSpeakAudioResponse(value: unknown): ParsedSpeakAudio {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "response=not-object" };
  }

  const response = value as SpeakResponseLike;
  if (response.status !== undefined && response.status !== "completed") {
    return {
      ok: false,
      reason: `status=${typeof response.status === "string" ? response.status : "invalid"}`,
    };
  }
  if (typeof response.audioBase64 !== "string" || response.audioBase64.length === 0) {
    return { ok: false, reason: "audioBase64=missing" };
  }
  if (response.mimeType !== "audio/mpeg") {
    return { ok: false, reason: "mimeType=missing-or-other" };
  }

  try {
    const audioBytes = decodeBase64Audio(response.audioBase64);
    if (audioBytes.byteLength === 0) {
      return { ok: false, reason: "audioBase64=empty-after-decode" };
    }
    return { ok: true, audioBase64: response.audioBase64, audioBytes };
  } catch {
    return { ok: false, reason: "audioBase64=invalid" };
  }
}
