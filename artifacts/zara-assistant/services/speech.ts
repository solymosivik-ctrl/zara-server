import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import * as Speech from 'expo-speech';
import { File, Paths } from 'expo-file-system';
import { zaraSpeak, zaraTranscribe } from '@workspace/api-client-react';

export type SpeechProvider = 'device' | 'elevenlabs';

export type SpeechOptions = {
  language: 'en-US' | 'hu-HU';
  voiceId?: string;
  speed?: number;
  provider: SpeechProvider;
};

export type SpeechEndReason = 'silence' | 'timeout' | 'stopped';
export type VoiceFingerprint = number[];

export class VoiceInputError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'permission-denied'
      | 'permission-blocked'
      | 'recording-failed'
      | 'recognition-failed'
      | 'no-speech',
  ) {
    super(message);
    this.name = 'VoiceInputError';
  }
}

export async function startListening(recorder: AudioRecorder): Promise<void> {
  const permission = await requestRecordingPermissionsAsync();
  if (!permission.granted) {
    throw new VoiceInputError(
      permission.canAskAgain
        ? 'Microphone permission is required for voice input.'
        : 'Microphone access is blocked. Enable it in your phone settings.',
      permission.canAskAgain ? 'permission-denied' : 'permission-blocked',
    );
  }

  try {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
  } catch {
    throw new VoiceInputError(
      'Zara could not start the microphone. Please try again.',
      'recording-failed',
    );
  }
}

export async function cancelListening(recorder: AudioRecorder): Promise<void> {
  if (recorder.getStatus().isRecording) {
    await recorder.stop();
  }
  await setAudioModeAsync({ allowsRecording: false });
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

let elevenLabsRetryAt = 0;
let cachedHungarianVoiceId: string | undefined;

export async function waitForSpeechEnd(
  recorder: AudioRecorder,
  options: {
    silenceDurationMs?: number;
    maximumDurationMs?: number;
    speechThresholdDb?: number;
    silenceThresholdDb?: number;
    meteringFallbackDurationMs?: number;
  } = {},
): Promise<SpeechEndReason> {
  const silenceDurationMs = options.silenceDurationMs ?? 800;
  const maximumDurationMs = options.maximumDurationMs ?? 12_000;
  const speechThresholdDb = options.speechThresholdDb ?? -62;
  const silenceThresholdDb = options.silenceThresholdDb ?? -66;
  const meteringFallbackDurationMs = options.meteringFallbackDurationMs ?? 6_500;
  let heardSpeech = false;
  let receivedMetering = false;
  let peakLevelDb = -160;
  let lastSpeechAt = Date.now();

  while (true) {
    const status = recorder.getStatus();
    if (!status.isRecording) return 'stopped';
    if (status.durationMillis >= maximumDurationMs) return 'timeout';

    if (typeof status.metering === 'number') {
      receivedMetering = true;
      peakLevelDb = Math.max(peakLevelDb, status.metering);
      const activeSpeechThresholdDb = Math.max(
        silenceThresholdDb,
        peakLevelDb - 18,
      );
      if (status.metering >= activeSpeechThresholdDb) {
        if (peakLevelDb >= speechThresholdDb) {
          heardSpeech = true;
          lastSpeechAt = Date.now();
        }
      } else if (
        heardSpeech &&
        status.durationMillis >= 700 &&
        Date.now() - lastSpeechAt >= silenceDurationMs
      ) {
        return 'silence';
      }
      if (!heardSpeech && status.durationMillis >= 8_000) {
        return 'timeout';
      }
    } else if (!receivedMetering && status.durationMillis >= meteringFallbackDurationMs) {
      return 'timeout';
    }

    await wait(120);
  }
}

export async function waitForWakeWordCandidate(
  recorder: AudioRecorder,
  options: {
    silenceDurationMs?: number;
    maximumDurationMs?: number;
    speechThresholdDb?: number;
    silenceThresholdDb?: number;
  } = {},
): Promise<{ heardSpeech: boolean; fingerprint: VoiceFingerprint }> {
  const silenceDurationMs = options.silenceDurationMs ?? 1_000;
  const maximumDurationMs = options.maximumDurationMs ?? 6_000;
  const speechThresholdDb = options.speechThresholdDb ?? -62;
  const silenceThresholdDb = options.silenceThresholdDb ?? -66;
  let heardSpeech = false;
  let receivedMetering = false;
  let peakLevelDb = -160;
  let lastSpeechAt = Date.now();
  const meteringSamples: number[] = [];

  while (true) {
    const status = recorder.getStatus();
    if (!status.isRecording) return { heardSpeech: false, fingerprint: [] };
    if (typeof status.metering === 'number') meteringSamples.push(status.metering);
    if (status.durationMillis >= maximumDurationMs) {
      return { heardSpeech, fingerprint: makeFingerprint(meteringSamples) };
    }

    if (typeof status.metering === 'number') {
      receivedMetering = true;
      peakLevelDb = Math.max(peakLevelDb, status.metering);
      const activeSpeechThresholdDb = Math.max(silenceThresholdDb, peakLevelDb - 18);
      if (status.metering >= activeSpeechThresholdDb && peakLevelDb >= speechThresholdDb) {
        heardSpeech = true;
        lastSpeechAt = Date.now();
      } else if (
        heardSpeech &&
        status.durationMillis >= 600 &&
        Date.now() - lastSpeechAt >= silenceDurationMs
      ) {
        return { heardSpeech: true, fingerprint: makeFingerprint(meteringSamples) };
      }
    } else if (!receivedMetering && status.durationMillis >= maximumDurationMs) {
      return { heardSpeech: true, fingerprint: makeFingerprint(meteringSamples) };
    }

    await wait(120);
  }
}

function makeFingerprint(samples: number[]): VoiceFingerprint {
  if (samples.length === 0) return [];
  const bins = 24;
  return Array.from({ length: bins }, (_, index) => {
    const start = Math.floor((index * samples.length) / bins);
    const end = Math.max(start + 1, Math.floor(((index + 1) * samples.length) / bins));
    const section = samples.slice(start, end);
    const average = section.reduce((sum, value) => sum + value, 0) / section.length;
    return Math.round(Math.max(-1, Math.min(1, (average + 60) / 30)) * 100) / 100;
  });
}

export async function recordVoiceProfileSample(
  recorder: AudioRecorder,
  options: { maximumDurationMs?: number } = {},
): Promise<VoiceFingerprint> {
  await startListening(recorder);
  const samples: number[] = [];
  const maximumDurationMs = options.maximumDurationMs ?? 6_000;
  let heardSpeech = false;
  let peakLevelDb = -160;
  let lastSpeechAt = Date.now();

  try {
    while (true) {
      const status = recorder.getStatus();
      if (!status.isRecording || status.durationMillis >= maximumDurationMs) break;
      if (typeof status.metering === 'number') {
        samples.push(status.metering);
        peakLevelDb = Math.max(peakLevelDb, status.metering);
        if (status.metering >= Math.max(-60, peakLevelDb - 12)) {
          heardSpeech = true;
          lastSpeechAt = Date.now();
        } else if (heardSpeech && status.durationMillis >= 900 && Date.now() - lastSpeechAt >= 850) {
          break;
        }
      }
      await wait(120);
    }
  } finally {
    if (recorder.getStatus().isRecording) await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
  }

  if (!heardSpeech || samples.length < 5) {
    throw new VoiceInputError('A hangminta túl rövid vagy nem volt hallható.', 'no-speech');
  }
  return makeFingerprint(samples);
}

export function voiceFingerprintSimilarity(
  candidate: VoiceFingerprint,
  enrolledSamples: VoiceFingerprint[],
): number {
  if (candidate.length === 0 || enrolledSamples.length === 0) return 0;
  const scoreFor = (sample: VoiceFingerprint) => {
    const length = Math.min(candidate.length, sample.length);
    if (length === 0) return 0;
    const distance =
      Array.from({ length }, (_, index) => Math.abs((candidate[index] ?? 0) - (sample[index] ?? 0)))
        .reduce((sum, value) => sum + value, 0) / length;
    return Math.max(0, 1 - distance / 0.7);
  };
  const scores = enrolledSamples.map(scoreFor).sort((left, right) => right - left);
  const comparedSamples = scores.slice(0, Math.min(2, scores.length));
  return comparedSamples.reduce((sum, score) => sum + score, 0) / comparedSamples.length;
}

async function recordingToBase64(uri: string): Promise<{ audioBase64: string; mimeType: string }> {
  const file = new File(uri);
  if (!file.exists || file.size <= 0) {
    throw new Error('The microphone recording is empty.');
  }

  const extension = file.extension.toLowerCase();
  const mimeType =
    extension === '.webm'
      ? 'audio/webm'
      : extension === '.wav'
        ? 'audio/wav'
        : extension === '.3gp'
          ? 'audio/3gpp'
          : 'audio/mp4';

  return {
    audioBase64: await file.base64(),
    mimeType,
  };
}

export async function stopListeningAndTranscribe(
  recorder: AudioRecorder,
  language: 'en' | 'hu',
): Promise<string> {
  try {
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false });
    if (!recorder.uri) {
      throw new Error('No microphone recording was created.');
    }
    const recording = await recordingToBase64(recorder.uri);
    const response = await zaraTranscribe({ ...recording, language });
    return response.transcript.trim();
  } catch (error) {
    if (error instanceof VoiceInputError) throw error;
    const message =
      error instanceof Error ? error.message : 'Zara could not recognize your speech.';
    if (/(\b422\b|could not hear any speech|no speech)/i.test(message)) {
      throw new VoiceInputError('No speech was recognized.', 'no-speech');
    }
    throw new VoiceInputError(
      message,
      'recognition-failed',
    );
  }
}

function decodeBase64(base64: string): Uint8Array {
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function speak(
  text: string,
  options: SpeechOptions,
  player: AudioPlayer,
): Promise<'elevenlabs' | 'device'> {
  if (Date.now() >= elevenLabsRetryAt) {
    try {
      const response = await zaraSpeak({
        text,
        language: options.language === 'hu-HU' ? 'hu' : 'en',
      });
      const extension = response.mimeType === 'audio/mpeg' ? '.mp3' : '.audio';
      const audioFile = new File(Paths.cache, `zara-response${extension}`);
      if (audioFile.exists) audioFile.delete();
      audioFile.create({ overwrite: true });
      audioFile.write(decodeBase64(response.audioBase64));

      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      player.replace(audioFile.uri);
      player.setPlaybackRate(1.06);
      player.play();
      return 'elevenlabs';
    } catch {
      elevenLabsRetryAt = Date.now() + 10 * 60 * 1000;
    }
  }

  {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    await Speech.stop();
    if (!cachedHungarianVoiceId) {
      const voices = await Speech.getAvailableVoicesAsync();
      cachedHungarianVoiceId = voices
        .filter((voice) => voice.language.toLowerCase().startsWith('hu'))
        .sort((left, right) => {
          const score = (voice: (typeof voices)[number]) => {
            const metadata = voice as typeof voice & {
              quality?: string;
              networkConnectionRequired?: boolean;
            };
            const label = `${voice.identifier} ${voice.name}`.toLowerCase();
            return (
              (metadata.quality?.toLowerCase() === 'enhanced' ? 4 : 0) +
              (label.includes('google') ? 3 : 0) +
              (/\b(female|woman|női)\b/.test(label) ? 4 : 0) +
              (label.includes('soft') || label.includes('natural') ? 1 : 0) +
              (metadata.networkConnectionRequired ? 1 : 0)
            );
          };
          return score(right) - score(left);
        })[0]?.identifier;
    }
    await new Promise<void>((resolve, reject) => {
      Speech.speak(text, {
        language: options.language,
        voice: cachedHungarianVoiceId,
        rate: options.speed ? Math.min(1.08, Math.max(0.88, options.speed * 1.04)) : 1.02,
        pitch: 0.96,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => reject(new Error('A telefonos magyar felolvasás sem érhető el.')),
      });
    });
    return 'device';
  }
}