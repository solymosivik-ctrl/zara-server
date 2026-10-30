import type { VoiceJobResult } from "./jobs";

export type LegacySpeakResponse = {
  audioBase64: string;
  mimeType: "audio/mpeg";
  status: "completed";
};

export function toLegacySpeakResponse(
  result: VoiceJobResult,
): LegacySpeakResponse | undefined {
  if (
    result.status !== "completed" ||
    !result.audioBase64 ||
    result.mimeType !== "audio/mpeg"
  ) {
    return undefined;
  }
  return {
    audioBase64: result.audioBase64,
    mimeType: "audio/mpeg",
    status: "completed",
  };
}
