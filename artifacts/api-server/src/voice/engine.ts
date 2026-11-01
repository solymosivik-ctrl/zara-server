import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";

export type VoiceAudio = { audioBase64: string; mimeType: string };
export interface VoiceEngine {
  warmup?(): Promise<void>;
  synthesize(text: string, jobId?: string): Promise<VoiceAudio>;
  close(): void;
}

const engineError = () => new Error(
  "Zara saját hangja most nem érhető el. A szöveges válasz megmaradt.",
);

function diagnosticError(value: unknown): Error | null {
  if (!value || typeof value !== "object") return null;
  const detail = value as { type?: unknown; message?: unknown };
  if (typeof detail.message !== "string") return null;
  const error = new Error(detail.message.slice(0, 180));
  if (typeof detail.type === "string" && /^[a-zA-Z0-9_.-]{1,60}$/.test(detail.type)) {
    error.name = detail.type;
  }
  return error;
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error")
    .replace(/(?:https?|file|content):\/\/\S+/gi, "[uri omitted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, "[data omitted]")
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, "[path omitted]")
    .slice(0, 180);
}

function workspaceRoot(): string {
  let directory = process.cwd();
  while (!existsSync(path.join(directory, "artifacts/api-server/voice/runtime.py"))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw engineError();
    directory = parent;
  }
  return directory;
}

/** One inference subprocess, owned by the existing API. No extra HTTP server. */
export class LocalVoiceEngine implements VoiceEngine {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private current: {
    id: string;
    resolve: (audio: VoiceAudio) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const ready = this.ready;
    try {
      const root = workspaceRoot();
      const python = path.join(root, ".pythonlibs/bin/python");
      if (!existsSync(python)) throw engineError();
      const child = spawn(python, ["-u", "artifacts/api-server/voice/runtime.py"], {
        cwd: root, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      const timer = setTimeout(() => this.fail(), 180_000);
      timer.unref();
      void ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (line.length > 12_000_000) { this.fail(); return; }
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.event === "ready") {
            this.readyResolve?.();
            this.readyResolve = null;
            this.readyReject = null;
            logger.info("Zara approved reference voice engine ready");
          } else if (message.event === "fatal") {
            this.fail(diagnosticError(message.diagnosticError) ?? engineError());
          } else if (this.current && message.id === this.current.id) {
            const current = this.current;
            this.current = null;
            clearTimeout(current.timer);
            if (message.ok === true &&
                typeof message.audioBase64 === "string" &&
                message.audioBase64.length >= 256 &&
                message.mimeType === "audio/mpeg") {
              current.resolve({ audioBase64: message.audioBase64, mimeType: message.mimeType });
            } else {
              current.reject(diagnosticError(message.diagnosticError) ?? engineError());
            }
          }
        } catch { this.fail(); }
      });
      // Libraries may write progress/reference text to stderr: do NOT log it.
      child.stderr.resume();
      child.stdin.on("error", () => this.fail());
      child.on("error", () => this.fail());
      child.on("exit", () => {
        if (this.child === child) this.fail();
      });
    } catch { this.fail(); }
    return ready;
  }

  /** Load the existing approved model without synthesizing or changing audio settings. */
  warmup(): Promise<void> {
    return this.start();
  }

  async synthesize(text: string, jobId = "unknown"): Promise<VoiceAudio> {
    const startedAt = Date.now();
    logger.info({ jobId }, "Approved Zara speech synthesis started");
    try {
      await this.start();
      if (!this.child || this.current) throw engineError();
      const audio = await new Promise<VoiceAudio>((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => this.fail(), 12 * 60_000);
        timer.unref();
        this.current = { id, resolve, reject, timer };
        this.child!.stdin.write(`${JSON.stringify({ id, text })}\n`);
      });
      logger.info({
        jobId,
        durationMs: Date.now() - startedAt,
        mimeType: audio.mimeType,
        audioBase64Chars: audio.audioBase64.length,
        audioBytes: Buffer.byteLength(audio.audioBase64, "base64"),
      }, "Approved Zara speech synthesis completed");
      return audio;
    } catch (error) {
      logger.error({
        jobId,
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: safeErrorMessage(error),
      }, "Approved Zara speech synthesis failed");
      throw error;
    }
  }

  private fail(error = engineError()): void {
    const child = this.child;
    this.child = null;
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.ready = null;
    if (this.current) {
      clearTimeout(this.current.timer);
      this.current.reject(error);
      this.current = null;
    }
    child?.kill("SIGTERM");
  }

  close(): void { this.fail(); }
}
