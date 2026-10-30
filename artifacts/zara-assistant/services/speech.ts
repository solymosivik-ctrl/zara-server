import type { AudioPlayer, AudioRecorder } from 'expo-audio';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import * as Speech from 'expo-speech';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import { zaraSpeak, zaraTranscribe } from '@workspace/api-client-react';
import { recordDiagnostic } from './api-diagnostics';
import {
  isSpeakJobPending,
  parseSpeakAudioResponse,
  type SpeakResponseLike,
} from './speak-response';

export type SpeechProvider = 'device' | 'sample';

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

function safeVoiceDiagnosticError(error: unknown): string {
  const value = error && typeof error === 'object'
    ? error as { name?: unknown; status?: unknown }
    : {};
  const name = typeof value.name === 'string' && /^[a-zA-Z0-9_.-]{1,50}$/.test(value.name)
    ? value.name
    : 'Error';
  const status = typeof value.status === 'number' ? String(value.status) : 'none';
  const message = (error instanceof Error ? error.message : '')
    .replace(/(?:https?|file|content):\/\/\S+/gi, '[uri omitted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, '[data omitted]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '[path omitted]')
    .slice(0, 160);
  return `error=${name}; httpStatus=${status}${message ? `; message=${message}` : ''}`;
}

type CaptureDiagnostic = {
  mode: 'command' | 'wake-word';
  endReason: string;
  durationMs: number;
  recording: boolean;
  meteringReceived: boolean;
  lastMeteringDb: number | null;
  peakMeteringDb: number;
  activeThresholdDb: number;
  speechThresholdDb: number;
  silenceThresholdDb: number;
  heardSpeech: boolean;
};

function logCaptureDiagnostic(details: CaptureDiagnostic): void {
  const level = (value: number | null) =>
    value === null || !Number.isFinite(value) ? 'n/a' : value.toFixed(1);
  recordDiagnostic(
    'MICROPHONE CAPTURE',
    `mode=${details.mode}; endReason=${details.endReason}; recording=${details.recording}; ` +
      `durationMs=${details.durationMs}; meteringReceived=${details.meteringReceived}; ` +
      `lastMeteringDb=${level(details.lastMeteringDb)}; peakMeteringDb=${level(details.peakMeteringDb)}; ` +
      `activeThresholdDb=${level(details.activeThresholdDb)}; ` +
      `speechThresholdDb=${level(details.speechThresholdDb)}; ` +
      `silenceThresholdDb=${level(details.silenceThresholdDb)}; heardSpeech=${details.heardSpeech}`,
  );
}

export async function startListening(recorder: AudioRecorder): Promise<void> {
  let permission: Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>;
  try {
    permission = await requestRecordingPermissionsAsync();
  } catch (error) {
    recordDiagnostic('MICROPHONE PERMISSION', `result=request-error; ${safeVoiceDiagnosticError(error)}`);
    throw error;
  }
  recordDiagnostic(
    'MICROPHONE PERMISSION',
    `granted=${permission.granted}; canAskAgain=${permission.canAskAgain}`,
  );
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
    const status = recorder.getStatus();
    recordDiagnostic(
      'MICROPHONE RECORDING',
      `recordCall=returned; active=${status.isRecording}; meteringAvailable=${typeof status.metering === 'number'}`,
    );
  } catch (error) {
    recordDiagnostic('MICROPHONE START ERROR', `phase=prepare-or-record; ${safeVoiceDiagnosticError(error)}`);
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

let cachedHungarianVoiceId: string | undefined;
let speechSequence = 0;
let previousSpeechFile: File | null = null;

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
  let lastMeteringDb: number | null = null;
  let activeSpeechThresholdDb = silenceThresholdDb;
  let lastSpeechAt = Date.now();

  while (true) {
    const status = recorder.getStatus();
    const logEnd = (endReason: string) => logCaptureDiagnostic({
      mode: 'command',
      endReason,
      durationMs: status.durationMillis,
      recording: status.isRecording,
      meteringReceived: receivedMetering,
      lastMeteringDb,
      peakMeteringDb: peakLevelDb,
      activeThresholdDb: activeSpeechThresholdDb,
      speechThresholdDb,
      silenceThresholdDb,
      heardSpeech,
    });
    if (!status.isRecording) {
      logEnd('recorder-stopped');
      return 'stopped';
    }
    if (status.durationMillis >= maximumDurationMs) {
      logEnd('timeout-maximum-duration');
      return 'timeout';
    }

    if (typeof status.metering === 'number') {
      receivedMetering = true;
      lastMeteringDb = status.metering;
      peakLevelDb = Math.max(peakLevelDb, status.metering);
      activeSpeechThresholdDb = Math.max(
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
        logEnd('silence-detected');
        return 'silence';
      }
      if (!heardSpeech && status.durationMillis >= 8_000) {
        logEnd('timeout-no-speech-by-8s');
        return 'timeout';
      }
    } else if (!receivedMetering && status.durationMillis >= meteringFallbackDurationMs) {
      logEnd('timeout-no-metering-fallback');
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
  let lastMeteringDb: number | null = null;
  let activeSpeechThresholdDb = silenceThresholdDb;
  let lastSpeechAt = Date.now();
  const meteringSamples: number[] = [];

  while (true) {
    const status = recorder.getStatus();
    const logEnd = (endReason: string) => logCaptureDiagnostic({
      mode: 'wake-word',
      endReason,
      durationMs: status.durationMillis,
      recording: status.isRecording,
      meteringReceived: receivedMetering,
      lastMeteringDb,
      peakMeteringDb: peakLevelDb,
      activeThresholdDb: activeSpeechThresholdDb,
      speechThresholdDb,
      silenceThresholdDb,
      heardSpeech,
    });
    if (!status.isRecording) {
      logEnd('recorder-stopped');
      return { heardSpeech: false, fingerprint: [] };
    }
    if (typeof status.metering === 'number') {
      receivedMetering = true;
      lastMeteringDb = status.metering;
      peakLevelDb = Math.max(peakLevelDb, status.metering);
      activeSpeechThresholdDb = Math.max(silenceThresholdDb, peakLevelDb - 18);
      meteringSamples.push(status.metering);
    }
    if (status.durationMillis >= maximumDurationMs) {
      logEnd(receivedMetering ? 'maximum-duration' : 'maximum-duration-no-metering');
      return { heardSpeech, fingerprint: makeFingerprint(meteringSamples) };
    }

    if (typeof status.metering === 'number') {
      if (status.metering >= activeSpeechThresholdDb && peakLevelDb >= speechThresholdDb) {
        heardSpeech = true;
        lastSpeechAt = Date.now();
      } else if (
        heardSpeech &&
        status.durationMillis >= 600 &&
        Date.now() - lastSpeechAt >= silenceDurationMs
      ) {
        logEnd('silence-detected');
        return { heardSpeech: true, fingerprint: makeFingerprint(meteringSamples) };
      }
    } else if (!receivedMetering && status.durationMillis >= maximumDurationMs) {
      logEnd('maximum-duration-no-metering');
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
  const info = await LegacyFileSystem.getInfoAsync(uri);
  if (!info.exists || !info.size || info.size <= 0) {
    throw new Error('The microphone recording is empty.');
  }

  const extension = uri.split(/[?#]/, 1)[0].match(/\.[a-z0-9]+$/i)?.[0]?.toLowerCase() ?? '';
  const mimeType =
    extension === '.webm'
      ? 'audio/webm'
      : extension === '.wav'
        ? 'audio/wav'
        : extension === '.3gp'
          ? 'audio/3gpp'
          : 'audio/mp4';

  return {
    audioBase64: await LegacyFileSystem.readAsStringAsync(uri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
    }),
    mimeType,
  };
}

export async function stopListeningAndTranscribe(
  recorder: AudioRecorder,
  language: 'en' | 'hu',
): Promise<string> {
  let phase = 'stop-recording';
  try {
    await recorder.stop();
    phase = 'disable-recording-mode';
    await setAudioModeAsync({ allowsRecording: false });
    if (!recorder.uri) {
      throw new Error('No microphone recording was created.');
    }
    phase = 'read-recording';
    const recording = await recordingToBase64(recorder.uri);
    phase = 'transcribe-request';
    recordDiagnostic(
      'TRANSCRIBE FLOW',
      `request=start; mimeType=${recording.mimeType}; audioBase64Chars=${recording.audioBase64.length}`,
    );
    const response = await zaraTranscribe({ ...recording, language });
    phase = 'validate-transcript';
    const transcript = response.transcript.trim();
    recordDiagnostic(
      'TRANSCRIBE FLOW',
      `response=received; transcriptChars=${transcript.length}; empty=${transcript.length === 0}`,
    );
    if (!transcript) {
      recordDiagnostic('TRANSCRIBE EMPTY', 'reason=empty-transcript');
    }
    return transcript;
  } catch (error) {
    recordDiagnostic('TRANSCRIBE FLOW ERROR', `phase=${phase}; ${safeVoiceDiagnosticError(error)}`);
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

function logSpeakResponse(stage: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    recordDiagnostic('SPEAK RESPONSE', `stage=${stage}; parsed=${value === null ? 'null' : typeof value}`);
    return;
  }
  const data = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'audioBase64', 'jobId', 'message', 'mimeType', 'retryAfterMs', 'status',
  ]);
  const keys = Object.keys(data).filter((key) => allowedKeys.has(key)).sort();
  const audioBase64 = typeof data.audioBase64 === 'string' ? data.audioBase64 : '';
  const status = ['queued', 'processing', 'completed', 'failed', 'cancelled'].includes(
    String(data.status),
  ) ? data.status : 'missing-or-unknown';
  recordDiagnostic(
    'SPEAK RESPONSE',
    `stage=${stage}; keys=${keys.join(',') || '(none)'}; status=${String(status)}; ` +
      `mimeType=${data.mimeType === 'audio/mpeg' ? 'audio/mpeg' : 'missing-or-other'}; ` +
      `audioBase64Present=${audioBase64.length > 0}; audioBase64Chars=${audioBase64.length}; ` +
      `jobIdPresent=${typeof data.jobId === 'string' && data.jobId.length > 0}`,
  );
}

function sanitizeSpeechError(error: unknown): { name: string; status: string; message: string } {
  const value = error && typeof error === 'object'
    ? error as { name?: unknown; status?: unknown }
    : {};
  const name = typeof value.name === 'string' && /^[a-zA-Z0-9_.-]{1,50}$/.test(value.name)
    ? value.name
    : 'RequestError';
  const status = typeof value.status === 'number' ? String(value.status) : 'none';
  const message = (error instanceof Error ? error.message : '')
    .replace(/(?:https?|file|content):\/\/\S+/gi, '[uri omitted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9+/=_-]{64,}\b/g, '[data omitted]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]+/g, '[path omitted]')
    .slice(0, 180);
  return { name, status, message };
}

export async function speak(
  text: string,
  options: SpeechOptions,
  player: AudioPlayer,
): Promise<'sample' | 'device'> {
  if (options.provider === 'sample') {
    let phase = 'start-request';
    let generatedFile: File | null = null;
    try {
      let response = await zaraSpeak({
        text,
        language: options.language === 'hu-HU' ? 'hu' : 'en',
        async: true,
      }) as unknown as SpeakResponseLike;
      logSpeakResponse('start', response);

      const deadline = Date.now() + 15 * 60_000;
      while (isSpeakJobPending(response)) {
        phase = 'waiting-for-job';
        if (typeof response.jobId !== 'string' || !response.jobId || Date.now() > deadline) {
          throw new Error('Zara saját hangjának előállítása túl sokáig tart. A szöveges válasz megmaradt.');
        }
        const delay = Math.min(
          3_000,
          Math.max(500, typeof response.retryAfterMs === 'number' ? response.retryAfterMs : 1_500),
        );
        await wait(delay);
        phase = 'poll-request';
        response = await zaraSpeak({
          text,
          language: options.language === 'hu-HU' ? 'hu' : 'en',
          async: true,
          jobId: response.jobId,
        }) as unknown as SpeakResponseLike;
        logSpeakResponse('poll', response);
      }

      phase = 'validate-response';
      const parsedAudio = parseSpeakAudioResponse(response);
      if (!parsedAudio.ok) {
        recordDiagnostic('SPEAK VALIDATION', parsedAudio.reason);
        throw new Error(
          typeof response.message === 'string'
            ? response.message
            : 'Zara saját hangja nem készült el. A szöveges válasz megmaradt.',
        );
      }

      let audioUri: string;
      if (Platform.OS === 'web') {
        audioUri = `data:audio/mpeg;base64,${parsedAudio.audioBase64}`;
      } else {
        phase = 'write-mp3';
        const audioFile = new File(Paths.cache, `zara-response-${++speechSequence}.mp3`);
        generatedFile = audioFile;
        if (audioFile.exists) audioFile.delete();
        audioFile.create({ overwrite: true });
        audioFile.write(parsedAudio.audioBytes);
        if (!audioFile.exists || audioFile.size !== parsedAudio.audioBytes.byteLength) {
          throw new Error('A generált MP3-fájl mentése nem sikerült.');
        }
        recordDiagnostic(
          'SPEAK AUDIO',
          `decodedMp3Bytes=${parsedAudio.audioBytes.byteLength}; ` +
            `cacheFileCreated=${audioFile.exists}; cacheFileBytes=${audioFile.size}`,
        );
        audioUri = audioFile.uri;
      }

      phase = 'set-playback-mode';
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      phase = 'player-replace';
      player.replace(audioUri);
      recordDiagnostic('SPEAK AUDIO', `player=replace; platform=${Platform.OS}`);
      phase = 'set-playback-rate';
      player.setPlaybackRate(options.speed ?? 1);
      phase = 'player-play';
      player.play();
      recordDiagnostic('SPEAK AUDIO', `player=play-called; platform=${Platform.OS}`);
      try {
        if (previousSpeechFile?.exists) previousSpeechFile.delete();
      } catch {
        // The player may still be holding the previous cache file.
      }
      previousSpeechFile = generatedFile;
      return 'sample';
    } catch (error) {
      const safe = sanitizeSpeechError(error);
      recordDiagnostic(
        'SPEAK FLOW ERROR',
        `phase=${phase}; error=${safe.name}; httpStatus=${safe.status}` +
          (safe.message ? `; message=${safe.message}` : ''),
      );
      throw error;
    }
  }

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