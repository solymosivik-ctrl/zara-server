import { createHash, randomUUID } from "node:crypto";
import type { VoiceAudio, VoiceEngine } from "./engine";

type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
type Job = {
  id: string; key: string; text: string; status: JobStatus; expires: number;
  audio?: VoiceAudio; message?: string;
};
export type VoiceJobResult = {
  jobId: string; status: JobStatus; retryAfterMs?: number; message?: string;
  audioBase64?: string; mimeType?: string;
};

const keyFor = (text: string, language: string) =>
  createHash("sha256").update(`approved-v1|${language}|${text.normalize("NFC").trim()}`).digest("hex");

function logJobDiagnostic(event: string, fields: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...fields }));
}

export class VoiceJobs {
  private jobs = new Map<string, Job>();
  private queue: Job[] = [];
  private running = false;
  private cache = new Map<string, VoiceAudio>();
  private cacheBytes = 0;
  constructor(private engine: VoiceEngine, private now = Date.now) {}

  warmup(): Promise<void> {
    return this.engine.warmup?.() ?? Promise.resolve();
  }

  submit(text: string, language: string): VoiceJobResult {
    this.cleanup();
    if (language !== "hu") throw new Error("Az elfogadott Zara-hang jelenleg magyar szöveghez használható.");
    if (!text.trim() || text.length > 5000) throw new Error("A felolvasható szöveg legfeljebb 5000 karakter lehet.");
    const key = keyFor(text, language);
    const existing = [...this.jobs.values()].find(job =>
      job.key === key && (job.status === "queued" || job.status === "processing"));
    if (existing) return this.view(existing);
    if (this.jobs.size >= 128 || this.queue.filter(job => job.status === "queued").length >= 3) {
      throw new Error("Zara hangja foglalt. A szöveges válasz elérhető; próbáld újra később.");
    }
    const cached = this.cache.get(key);
    const job: Job = {
      id: randomUUID(), key, text: text.trim(),
      status: cached ? "completed" : "queued",
      expires: this.now() + 15 * 60_000,
      ...(cached ? { audio: cached } : {}),
    };
    this.jobs.set(job.id, job);
    if (!cached) { this.queue.push(job); void this.pump(); }
    return this.view(job);
  }

  poll(id: string, text: string, language: string, cancel = false): VoiceJobResult | undefined {
    this.cleanup();
    const job = this.jobs.get(id);
    if (!job || job.key !== keyFor(text, language)) return undefined;
    if (cancel && job.status !== "cancelled") {
      job.status = "cancelled";
      delete job.audio;
      job.text = "";
    }
    return this.view(job);
  }

  async wait(id: string): Promise<VoiceJobResult> {
    while (true) {
      const job = this.jobs.get(id);
      if (!job) throw new Error("A hangkérés lejárt.");
      if (job.status !== "queued" && job.status !== "processing") return this.view(job);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  private view(job: Job): VoiceJobResult {
    return {
      jobId: job.id, status: job.status,
      ...(job.audio && job.status === "completed" ? job.audio : {}),
      ...(job.message ? { message: job.message } : {}),
      ...(job.status === "queued" || job.status === "processing" ? { retryAfterMs: 1500 } : {}),
    };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        if (job.status !== "queued") continue;
        if (job.expires <= this.now()) {
          job.status = "failed"; job.text = ""; job.message = "A hangkérés várakozás közben lejárt.";
            logJobDiagnostic("approved-zara-voice-job-expired", {
              jobId: job.id,
              status: job.status,
            });
          continue;
        }
        job.status = "processing";
        try {
          const audio = await this.engine.synthesize(job.text, job.id);
          // Cancelling never resurrects a job or plays its late audio.
          if ((job.status as JobStatus) === "processing") {
            job.status = "completed";
            job.audio = audio;
            logJobDiagnostic("approved-zara-voice-job-completed", {
              jobId: job.id,
              status: job.status,
              audioBase64Present: job.audio.audioBase64.length > 0,
              audioBase64Chars: job.audio.audioBase64.length,
              mimeType: job.audio.mimeType,
              audioBytes: Buffer.byteLength(job.audio.audioBase64, "base64"),
            });
            this.remember(job.key, audio);
          }
        } catch (error) {
          if ((job.status as JobStatus) === "processing") {
            job.status = "failed";
            job.message = "Zara saját hangjának előállítása nem sikerült. A szöveges válasz megmaradt.";
            logJobDiagnostic("approved-zara-voice-job-failed", {
              jobId: job.id,
              status: job.status,
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          }
        } finally { job.text = ""; }
      }
    } finally { this.running = false; }
  }

  private remember(key: string, audio: VoiceAudio): void {
    const size = Buffer.byteLength(audio.audioBase64);
    if (size > 8_000_000) return;
    while (this.cache.size && (this.cacheBytes + size > 16_000_000 || this.cache.size >= 32)) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= Buffer.byteLength(this.cache.get(oldest)!.audioBase64);
      this.cache.delete(oldest);
    }
    this.cache.set(key, audio);
    this.cacheBytes += size;
  }

  private cleanup(): void {
    for (const [id, job] of this.jobs) {
      if (job.expires < this.now() && job.status !== "processing") this.jobs.delete(id);
    }
  }
  close(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "queued" || job.status === "processing") job.status = "cancelled";
    }
    this.engine.close();
  }
}
