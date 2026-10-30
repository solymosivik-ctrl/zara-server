import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBase64Audio,
  isSpeakJobPending,
  parseSpeakAudioResponse,
} from "./speak-response.ts";

test("accepts direct MP3 audio without job metadata", () => {
  const audioBase64 = Buffer.alloc(25_344, 7).toString("base64");
  assert.equal(audioBase64.length, 33_792);
  const result = parseSpeakAudioResponse({ audioBase64, mimeType: "audio/mpeg" });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.audioBytes.byteLength, 25_344);
});

test("retains queued and processing job flow", () => {
  assert.equal(isSpeakJobPending({ status: "queued", jobId: "job-1" }), true);
  assert.equal(isSpeakJobPending({ status: "processing", jobId: "job-1" }), true);
  assert.equal(parseSpeakAudioResponse({
    status: "processing",
    audioBase64: Buffer.from([1]).toString("base64"),
    mimeType: "audio/mpeg",
  }).ok, false);
});

test("accepts completed async jobs", () => {
  const result = parseSpeakAudioResponse({
    status: "completed",
    jobId: "job-1",
    audioBase64: Buffer.from([7, 8, 9]).toString("base64"),
    mimeType: "audio/mpeg",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(Array.from(result.audioBytes), [7, 8, 9]);
});

test("rejects failures, unexpected MIME, and malformed base64", () => {
  const audioBase64 = Buffer.from([1, 2]).toString("base64");
  assert.equal(parseSpeakAudioResponse({
    status: "failed", audioBase64, mimeType: "audio/mpeg",
  }).ok, false);
  assert.equal(parseSpeakAudioResponse({
    audioBase64, mimeType: "audio/wav",
  }).ok, false);
  assert.equal(parseSpeakAudioResponse({
    audioBase64: "not base64!", mimeType: "audio/mpeg",
  }).ok, false);
});

test("decodes unpadded base64 and rejects bad padding", () => {
  assert.deepEqual(Array.from(decodeBase64Audio("AQI")), [1, 2]);
  assert.throws(() => decodeBase64Audio("A==="));
});
