import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceJobs } from "./jobs";
import type { VoiceAudio, VoiceEngine } from "./engine";

const audio: VoiceAudio = {
  audioBase64: Buffer.alloc(256, 1).toString("base64"),
  mimeType: "audio/mpeg",
};
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeEngine implements VoiceEngine {
  calls: string[] = [];
  pending: { resolve: (value: VoiceAudio) => void; reject: (error: Error) => void }[] = [];
  closed = false;
  warmups = 0;
  async warmup() { this.warmups += 1; }
  synthesize(text: string): Promise<VoiceAudio> {
    this.calls.push(text);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  close() { this.closed = true; }
}

test("warmup loads the approved engine without synthesizing speech", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  await jobs.warmup();
  assert.equal(engine.warmups, 1);
  assert.deepEqual(engine.calls, []);
});

test("jobs complete, cache exact repeats, and synthesize different text", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  const first = jobs.submit("Első válasz.", "hu");
  assert.equal(first.status, "processing");
  assert.deepEqual(engine.calls, ["Első válasz."]);
  engine.pending.shift()!.resolve(audio); await tick();
  assert.equal(jobs.poll(first.jobId, "Első válasz.", "hu")?.audioBase64, audio.audioBase64);
  assert.equal(jobs.submit("Első válasz.", "hu").status, "completed");
  assert.equal(engine.calls.length, 1);
  jobs.submit("Második válasz.", "hu");
  assert.equal(engine.calls[1], "Második válasz.");
  engine.pending.shift()!.resolve(audio); await tick();
});

test("cancelled active speech cannot return late audio", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  const job = jobs.submit("Ne játszd le.", "hu");
  assert.equal(jobs.poll(job.jobId, "Ne játszd le.", "hu", true)?.status, "cancelled");
  engine.pending.shift()!.resolve(audio); await tick();
  const result = jobs.poll(job.jobId, "Ne játszd le.", "hu");
  assert.equal(result?.status, "cancelled");
  assert.equal(result?.audioBase64, undefined);
});

test("cancelled queued speech is never synthesized", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  jobs.submit("Aktív.", "hu"); const queued = jobs.submit("Várakozó.", "hu");
  assert.equal(queued.status, "queued");
  jobs.poll(queued.jobId, "Várakozó.", "hu", true);
  engine.pending.shift()!.resolve(audio); await tick();
  assert.deepEqual(engine.calls, ["Aktív."]);
});

test("engine errors fail explicitly without a substitute voice", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  const job = jobs.submit("Saját hang.", "hu");
  engine.pending.shift()!.reject(new Error("unavailable")); await tick();
  assert.equal(jobs.poll(job.jobId, "Saját hang.", "hu")?.status, "failed");
  assert.equal(jobs.poll(job.jobId, "Saját hang.", "hu")?.audioBase64, undefined);
  assert.equal(engine.calls.length, 1);
});

test("failed synthesis logs a sanitized reason without speech text or credentials", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  const originalInfo = console.info;
  const logLines: string[] = [];
  console.info = (...args: unknown[]) => logLines.push(args.join(" "));
  try {
    const spokenText = "Titkos felolvasandó mondat.";
    const job = jobs.submit(spokenText, "hu");
    engine.pending.shift()!.reject(
      new Error(`codec failed for ${spokenText}; Bearer secret-token at /private/model.bin`),
    );
    await tick();
    const failure = logLines.find((line) => line.includes("approved-zara-voice-job-failed"));
    assert.ok(failure);
    assert.match(failure, /errorMessage/);
    assert.match(failure, /codec failed/);
    assert.match(failure, /speech text omitted/);
    assert.match(failure, /Bearer \[redacted\]/);
    assert.match(failure, /\[path omitted\]/);
    assert.doesNotMatch(failure, /Titkos felolvasandó mondat|secret-token|model\.bin/);
    assert.equal(jobs.poll(job.jobId, spokenText, "hu")?.status, "failed");
  } finally {
    console.info = originalInfo;
  }
});

test("job IDs are bound to text and queue size is bounded", async () => {
  const engine = new FakeEngine(); const jobs = new VoiceJobs(engine);
  const job = jobs.submit("A válasz.", "hu");
  assert.equal(jobs.poll(job.jobId, "Más válasz.", "hu"), undefined);
  assert.equal(jobs.poll("unknown", "A válasz.", "hu"), undefined);
  for (let i = 0; i < 3; i++) jobs.submit(`Várakozó ${i}`, "hu");
  assert.throws(() => jobs.submit("Túl sok.", "hu"));
  jobs.close(); assert.equal(engine.closed, true);
  engine.pending.shift()!.resolve(audio); await tick();
});

test("unsupported languages fail explicitly and completed jobs expire", async () => {
  let now = 0; const engine = new FakeEngine(); const jobs = new VoiceJobs(engine, () => now);
  assert.throws(() => jobs.submit("Hello", "en"));
  const job = jobs.submit("Szia.", "hu");
  engine.pending.shift()!.resolve(audio); await tick();
  now = 16 * 60_000;
  assert.equal(jobs.poll(job.jobId, "Szia.", "hu"), undefined);
});
