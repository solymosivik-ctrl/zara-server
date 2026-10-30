import assert from "node:assert/strict";
import { test } from "node:test";
import { toLegacySpeakResponse } from "./legacy-speak-response";

test("legacy response returns the expected MP3 fields and completed status", () => {
  const response = toLegacySpeakResponse({
    jobId: "internal-job-id",
    status: "completed",
    audioBase64: Buffer.alloc(256, 1).toString("base64"),
    mimeType: "audio/mpeg",
  });
  assert.deepEqual(Object.keys(response ?? {}), ["audioBase64", "mimeType", "status"]);
  assert.equal(response?.mimeType, "audio/mpeg");
  assert.equal(response?.status, "completed");
});

test("legacy response rejects incomplete and non-MP3 results", () => {
  assert.equal(toLegacySpeakResponse({ jobId: "x", status: "processing" }), undefined);
  assert.equal(toLegacySpeakResponse({
    jobId: "x", status: "completed", audioBase64: "encoded", mimeType: "audio/wav",
  }), undefined);
});
