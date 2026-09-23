import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  RecordingPresets,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { ZaraOrb } from '@/components/ZaraOrb';
import { Screen } from '@/components/Screen';
import { ZARA_APP_VERSION, ZARA_BUNDLE_ID } from '@/constants/build';
import { normalizeOwnerName, useZara } from '@/context/ZaraContext';
import { useColors } from '@/hooks/useColors';
import {
  clearDiagnostics,
  diagnosticLines,
  recordDiagnostic,
  useApiDiagnostics,
} from '@/services/api-diagnostics';
import { launchAndroidApp, parseAndroidAppCommand } from '@/services/android-apps';
import { getWeatherResponse, parseWeatherRequest } from '@/services/weather';
import {
  cancelListening,
  startListening,
  speak,
  stopListeningAndTranscribe,
  VoiceInputError,
  waitForSpeechEnd,
  waitForWakeWordCandidate,
  voiceFingerprintSimilarity,
} from '@/services/speech';

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function preferredOwnerGreeting(ownerName: string | null): string | null {
  if (!ownerName) return null;
  const parts = ownerName.split(/\s+/).filter(Boolean);
  return parts.at(-1) ?? ownerName;
}

function normalizeSpeechForComparison(value: string): string {
  return value
    .toLocaleLowerCase('hu-HU')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRecentAssistantEcho(
  transcript: string,
  lastAssistantSpeech: { normalized: string; expiresAt: number } | null,
): boolean {
  if (!lastAssistantSpeech || Date.now() > lastAssistantSpeech.expiresAt) return false;
  const normalizedTranscript = normalizeSpeechForComparison(transcript);
  if (!normalizedTranscript || normalizedTranscript.length < 5) return false;
  if (normalizedTranscript === lastAssistantSpeech.normalized) return true;
  const spokenWords = new Set(lastAssistantSpeech.normalized.split(' '));
  const transcriptWords = normalizedTranscript.split(' ');
  const matchingWords = transcriptWords.filter((word) => spokenWords.has(word)).length;
  return matchingWords >= 3 && matchingWords / transcriptWords.length >= 0.7;
}

export default function HomeScreen() {
  const colors = useColors();
  const router = useRouter();
  const {
    hydrated,
    conversations,
    createConversation,
    sendMessage,
    settings,
    sendingConversationId,
    sendError,
    clearSendError,
    updateSettings,
  } = useZara();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [generatingSpeech, setGeneratingSpeech] = useState(false);
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [wakeWordListening, setWakeWordListening] = useState(false);
  const [wakeWordAttempt, setWakeWordAttempt] = useState(0);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const finishingVoiceRef = useRef(false);
  const voiceSessionActiveRef = useRef(false);
  const previousPlaybackFinishedRef = useRef(false);
  const wakeWordCycleRef = useRef(0);
  const collectingOwnerNameRef = useRef(false);
  const ownerVerifiedRef = useRef(false);
  const lastAssistantSpeechRef = useRef<{ normalized: string; expiresAt: number } | null>(null);
  const silentVoiceTurnsRef = useRef(0);
  const assistantEchoCountRef = useRef(0);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const speechPlayer = useAudioPlayer(null, { updateInterval: 100 });
  const speechStatus = useAudioPlayerStatus(speechPlayer);
  const current = activeId ? conversations.find((item) => item.id === activeId) : undefined;
  const isThinking = Boolean(activeId && sendingConversationId === activeId);
  const isSpeaking = generatingSpeech || speechStatus.playing;
  const latestMessage = current?.messages[current.messages.length - 1];
  const diagnostics = useApiDiagnostics();

  useEffect(() => {
    if (!hydrated || activeId || conversations.length === 0) return;
    setActiveId(conversations[0].id);
  }, [activeId, conversations, hydrated]);

  const speakResponse = async (responseText: string | null): Promise<boolean> => {
    if (!responseText || !settings.voiceEnabled) return false;
    setGeneratingSpeech(true);
    setVoiceError(null);
    try {
      lastAssistantSpeechRef.current = {
        normalized: normalizeSpeechForComparison(responseText),
        expiresAt: Date.now() + 8_000,
      };
      const speed = settings.voiceSpeed === 'slow' ? 0.9 : settings.voiceSpeed === 'fast' ? 1.1 : 1;
      const playback = await speak(
        responseText,
        { language: 'hu-HU', speed, provider: 'elevenlabs' },
        speechPlayer,
      );
      if (playback === 'device' && voiceSessionActiveRef.current) {
        setTimeout(() => void beginVoiceListening(), 250);
      }
      return true;
    } catch (error) {
      setVoiceError(
        error instanceof Error
          ? error.message
          : 'Zara could not play the spoken response. The text response is still available.',
      );
      return false;
    } finally {
      setGeneratingSpeech(false);
    }
  };

  const handleSend = async () => {
    if (!text.trim()) return;
    const conversation = current ?? createConversation();
    const outgoingText = text;
    setActiveId(conversation.id);
    setText('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const appCommand = parseAndroidAppCommand(outgoingText);
    console.info('[Zara weather trace] 1 raw text input', JSON.stringify(outgoingText));
    console.info('[Zara weather trace] 2 parseWeatherRequest input', JSON.stringify(outgoingText));
    const weatherRequest = parseWeatherRequest(outgoingText);
    recordDiagnostic('TEXT WEATHER INTENT', String(Boolean(weatherRequest)));
    recordDiagnostic('TEXT WEATHER QUERY', weatherRequest?.query ?? '(none)');
    if (!weatherRequest) recordDiagnostic('WEATHER REQUEST', 'NOT SENT');
    console.info(
      '[Zara weather trace] 3 parseWeatherRequest output',
      JSON.stringify(weatherRequest),
    );
    const weatherResponse = weatherRequest ? await getWeatherResponse(weatherRequest) : undefined;
    const localResponse = appCommand
      ? await launchAndroidApp(appCommand)
      : weatherRequest
        ? weatherResponse?.displayText
        : undefined;
    if (localResponse) {
      recordDiagnostic('CHAT REQUEST', 'NOT SENT (local response was used)');
    } else {
      recordDiagnostic('CHAT REQUEST', 'EXPECTED; inspect CHAT BEFORE/AFTER below');
    }
    const responseText = await sendMessage(conversation.id, outgoingText, { localResponse });
    await speakResponse(weatherResponse?.spokenText ?? responseText);
  };

  const finishVoiceInput = async () => {
    if (finishingVoiceRef.current) return;
    finishingVoiceRef.current = true;
    try {
      setListening(false);
      setTranscribing(true);
      const transcript = await stopListeningAndTranscribe(recorder, settings.language);
      if (!transcript) throw new Error('No speech was recognized.');
      if (isRecentAssistantEcho(transcript, lastAssistantSpeechRef.current)) {
        assistantEchoCountRef.current += 1;
        setText('');
        if (assistantEchoCountRef.current >= 2) {
          voiceSessionActiveRef.current = false;
          ownerVerifiedRef.current = false;
          setVoiceSessionActive(false);
        } else if (voiceSessionActiveRef.current) {
          setTimeout(() => void beginVoiceListening(), 550);
        }
        return;
      }
      silentVoiceTurnsRef.current = 0;
      assistantEchoCountRef.current = 0;
      if (collectingOwnerNameRef.current) {
        const ownerName = normalizeOwnerName(
          transcript
          .replace(/[.!?]+$/g, '')
          .replace(/^(a nevem|engem úgy hívnak hogy|engem úgy hívnak|én)\s+/i, '')
          .trim(),
        );
        if (!ownerName) {
          setText('');
          await speakResponse(
            'Kérlek, mondd a teljes nevedet, legalább két névelemmel. Például: Pintér Viktor, vagy idősebb Pintér Viktor.',
          );
          return;
        }
        collectingOwnerNameRef.current = false;
        updateSettings({ ownerName, language: 'hu' });
        setText('');
        const confirmation = `Örülök, hogy megismerhetlek, ${ownerName}. Megjegyeztem a nevedet.`;
        await speakResponse(confirmation);
        return;
      }
      setText(transcript);
      console.info('[Zara weather trace] 1 raw Speech-to-Text result', JSON.stringify(transcript));
      console.info('[Zara weather trace] 2 parseWeatherRequest input', JSON.stringify(transcript));
      const conversation = current ?? createConversation();
      setActiveId(conversation.id);
      const normalizedTranscript = transcript
        .toLocaleLowerCase('hu-HU')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const asksAboutIdentity =
        /\bki vagyok\b|\balkotoja?\b|\balkot[oó]\b|\btulajdonos\b|\b(en|én).{0,12}\bvagyok\b/i.test(
          normalizedTranscript,
        );
      if (asksAboutIdentity) {
        const identityResponse =
          ownerVerifiedRef.current && settings.ownerName
            ? `Te vagy ${settings.ownerName}, Zara tulajdonosa és alkotója.`
            : 'Ezt csak a hitelesített tulajdonos hangjának felismerése után mondhatom meg.';
        await speakResponse(identityResponse);
        setText('');
        return;
      }
      const appCommand = parseAndroidAppCommand(transcript);
      const weatherRequest = parseWeatherRequest(transcript);
      recordDiagnostic('RAW STT TRANSCRIPT', transcript);
      recordDiagnostic('WEATHER INTENT', String(Boolean(weatherRequest)));
      recordDiagnostic('PARSER OUTPUT', JSON.stringify(weatherRequest));
      recordDiagnostic('FINAL WEATHER QUERY', weatherRequest?.query ?? '(none)');
      if (!weatherRequest) recordDiagnostic('WEATHER REQUEST', 'NOT SENT');
      console.info(
        '[Zara weather trace] 3 parseWeatherRequest output',
        JSON.stringify(weatherRequest),
      );
      const weatherResponse = weatherRequest ? await getWeatherResponse(weatherRequest) : undefined;
      const localResponse = appCommand
        ? await launchAndroidApp(appCommand)
        : weatherRequest
          ? weatherResponse?.displayText
          : undefined;
      if (localResponse) {
        recordDiagnostic('CHAT REQUEST', 'NOT SENT (local response was used)');
      } else {
        recordDiagnostic('CHAT REQUEST', 'EXPECTED; inspect CHAT BEFORE/AFTER below');
      }
      const responseText = await sendMessage(conversation.id, transcript, {
        ownerVerified: ownerVerifiedRef.current,
        localResponse,
      });
      const startedSpeaking = voiceSessionActiveRef.current
        ? await speakResponse(weatherResponse?.spokenText ?? responseText)
        : false;
      setText('');
      if (!startedSpeaking && voiceSessionActiveRef.current) {
        setTimeout(() => void beginVoiceListening(), 500);
      }
    } catch (error) {
      setListening(false);
      if (
        error instanceof VoiceInputError &&
        error.code === 'no-speech' &&
        voiceSessionActiveRef.current
      ) {
        silentVoiceTurnsRef.current += 1;
        setText('');
        if (silentVoiceTurnsRef.current >= 2) {
          voiceSessionActiveRef.current = false;
          ownerVerifiedRef.current = false;
          setVoiceSessionActive(false);
        } else {
          setTimeout(() => void beginVoiceListening(), 450);
        }
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Zara could not use voice input. Please try again.';
      setVoiceError(message);
      if (error instanceof VoiceInputError && error.code === 'permission-blocked') {
        Alert.alert(
          settings.language === 'hu' ? 'Mikrofon letiltva' : 'Microphone blocked',
          message,
          [
            { text: settings.language === 'hu' ? 'Mégse' : 'Cancel', style: 'cancel' },
            ...(Platform.OS !== 'web'
              ? [{
                  text: settings.language === 'hu' ? 'Beállítások' : 'Open settings',
                  onPress: () => Linking.openSettings().catch(() => undefined),
                }]
              : []),
          ],
        );
      }
    } finally {
      setTranscribing(false);
      finishingVoiceRef.current = false;
    }
  };

  const beginVoiceListening = async () => {
    if (!voiceSessionActiveRef.current) return;
    setVoiceError(null);
    try {
      finishingVoiceRef.current = false;
      await startListening(recorder);
      if (!voiceSessionActiveRef.current) {
        await cancelListening(recorder);
        return;
      }
      setListening(true);
      void waitForSpeechEnd(recorder)
        .then(async (reason) => {
          if (reason === 'silence') {
            await finishVoiceInput();
            return;
          }
          if (reason === 'timeout') {
            // Do not send an all-silence recording to transcription. Speech
            // services can hallucinate a reply from silence and restart the
            // continuous voice loop indefinitely.
            await cancelListening(recorder);
            voiceSessionActiveRef.current = false;
            ownerVerifiedRef.current = false;
            setVoiceSessionActive(false);
            setListening(false);
          }
        })
        .catch((error) => {
          setVoiceError(
            error instanceof Error
              ? error.message
              : 'Zara could not detect when you finished speaking.',
          );
        });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Zara could not use voice input. Please try again.';
      setVoiceError(message);
    }
  };

  useEffect(() => {
    if (
      !hydrated ||
      !settings.wakeWordEnabled ||
      voiceSessionActive ||
      listening ||
      transcribing ||
      isThinking ||
      isSpeaking ||
      wakeWordListening
    ) {
      return;
    }

    const cycle = wakeWordCycleRef.current + 1;
    wakeWordCycleRef.current = cycle;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setVoiceError(null);
          await startListening(recorder);
          if (cancelled || wakeWordCycleRef.current !== cycle) {
            await cancelListening(recorder);
            return;
          }
          setWakeWordListening(true);
          const candidate = await waitForWakeWordCandidate(recorder);
          if (cancelled || wakeWordCycleRef.current !== cycle) {
            await cancelListening(recorder);
            return;
          }
          if (!candidate.heardSpeech) {
            await cancelListening(recorder);
            return;
          }
          if (
            settings.ownerVoiceProfile &&
            voiceFingerprintSimilarity(
              candidate.fingerprint,
              settings.ownerVoiceProfile.samples,
            ) < 0.58
          ) {
            await cancelListening(recorder);
            return;
          }

          const transcript = await stopListeningAndTranscribe(recorder, settings.language);
          const normalized = transcript
            .toLocaleLowerCase('hu-HU')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[.,!?;:]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const wakeWords = normalized.split(' ').filter(Boolean);
          const greetings = new Set([
            'hello',
            'helo',
            'hallo',
            'szia',
            'hallasz',
            'hallod',
            'figyelsz',
            'hallatsz',
            'halasz',
          ]);
          const names = new Set(['zara', 'sara', 'sarah', 'zsara', 'zala', 'zsuzsa']);
          const isGreeting = (word: string) =>
            greetings.has(word) ||
            [...greetings].some((greeting) => editDistance(word, greeting) <= 1);
          const isZaraName = (word: string) =>
            names.has(word) || editDistance(word, 'zara') <= 1;
          const greetingIndex = wakeWords.findIndex(isGreeting);
          const nameIndex = wakeWords.findIndex(isZaraName);
          const wokeZara =
            wakeWords.length >= 2 &&
            wakeWords.length <= 4 &&
            greetingIndex >= 0 &&
            nameIndex >= 0 &&
            Math.abs(greetingIndex - nameIndex) <= 2;

          if (wokeZara && !cancelled) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            voiceSessionActiveRef.current = true;
            ownerVerifiedRef.current = Boolean(settings.ownerVoiceProfile);
            silentVoiceTurnsRef.current = 0;
            assistantEchoCountRef.current = 0;
            setVoiceSessionActive(true);
            collectingOwnerNameRef.current = !settings.ownerName;
            const greetingName = preferredOwnerGreeting(settings.ownerName) ?? 'Viktor';
            const acknowledgement = collectingOwnerNameRef.current
              ? `Szia ${greetingName}! Miben segíthetek? Mondd el a teljes neved.`
              : `Szia ${greetingName}! Miben segíthetek?`;
            const startedSpeaking = await speakResponse(acknowledgement);
            if (!startedSpeaking) {
              setTimeout(() => void beginVoiceListening(), 350);
            }
          }
        } catch (error) {
          if (
            !cancelled &&
            error instanceof VoiceInputError &&
            error.code !== 'recognition-failed' &&
            error.code !== 'no-speech'
          ) {
            setVoiceError(
              settings.language === 'hu'
                ? error.code === 'permission-blocked'
                  ? 'A mikrofon le van tiltva. Engedélyezd a telefon beállításaiban.'
                  : 'A „Hello Zara” figyeléshez engedélyezd a mikrofont.'
                : error.message,
            );
          }
        } finally {
          if (!cancelled) {
            setWakeWordListening(false);
            setWakeWordAttempt((currentAttempt) => currentAttempt + 1);
          }
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (wakeWordCycleRef.current === cycle) wakeWordCycleRef.current += 1;
    };
  }, [
    hydrated,
    isSpeaking,
    isThinking,
    listening,
    settings.language,
    settings.wakeWordEnabled,
    transcribing,
    voiceSessionActive,
    wakeWordAttempt,
  ]);

  useEffect(() => {
    const newlyFinished =
      speechStatus.didJustFinish && !previousPlaybackFinishedRef.current;
    previousPlaybackFinishedRef.current = speechStatus.didJustFinish;
    if (!newlyFinished || !voiceSessionActive) return;
    const timer = setTimeout(() => void beginVoiceListening(), 450);
    return () => clearTimeout(timer);
  }, [speechStatus.didJustFinish, voiceSessionActive]);

  const handleMic = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (voiceSessionActiveRef.current) {
      voiceSessionActiveRef.current = false;
      ownerVerifiedRef.current = false;
      setVoiceSessionActive(false);
      setListening(false);
      if (speechStatus.playing) speechPlayer.pause();
      try {
        await cancelListening(recorder);
      } catch {
        // The recorder may already be stopping after silence detection.
      }
      return;
    }

    if (isThinking || transcribing || isSpeaking) return;
    wakeWordCycleRef.current += 1;
    setWakeWordListening(false);
    try {
      await cancelListening(recorder);
    } catch {
      // Wake-word monitoring may be between recording cycles.
    }
    voiceSessionActiveRef.current = true;
    setVoiceSessionActive(true);
    await beginVoiceListening();
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.primary }]}>ZARA / CORE</Text>
            <Text style={[styles.greeting, { color: colors.foreground }]}>
              {settings.language === 'hu' ? 'Jó estét.' : 'Good evening.'}
            </Text>
            <Text style={[styles.buildTag, { color: colors.mutedForeground }]}>
              Zara Mobile v{ZARA_APP_VERSION} · {ZARA_BUNDLE_ID}
            </Text>
          </View>
          <Pressable
            accessibilityLabel="Open settings"
            testID="open-settings"
            onPress={() => router.push('/(tabs)/settings')}
            style={({ pressed }) => [
              styles.iconButton,
              { borderColor: colors.border, opacity: pressed ? 0.68 : 1 },
            ]}
          >
            <Feather name="sliders" size={19} color={colors.secondaryForeground} />
          </Pressable>
        </View>

        <View style={styles.orbStage}>
          <ZaraOrb listening={listening || wakeWordListening} thinking={isThinking} />
          <View style={styles.statusRow}>
            {isThinking ? <ActivityIndicator size="small" color={colors.primary} /> : <View style={[styles.statusDot, { backgroundColor: listening ? colors.accent : colors.primary }]} />}
            <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
              {isSpeaking
                ? settings.language === 'hu'
                  ? 'Beszél…'
                  : 'Speaking…'
                : transcribing
                ? settings.language === 'hu'
                  ? 'Felismerem a beszédet…'
                  : 'Recognizing speech…'
                : isThinking
                ? settings.language === 'hu'
                  ? 'Gondolkodik…'
                  : 'Thinking…'
                : listening
                ? settings.language === 'hu'
                  ? 'Hallgatlak'
                  : 'Listening'
                : wakeWordListening
                ? settings.language === 'hu'
                  ? 'Mondd: Hello Zara'
                  : 'Say: Hello Zara'
                : settings.language === 'hu'
                  ? 'Készen áll'
                  : 'Ready when you are'}
            </Text>
          </View>
        </View>

        {latestMessage ? (
          <View style={[styles.responseCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.responseHeader}>
              <Text style={[styles.responseLabel, { color: latestMessage.role === 'assistant' ? colors.primary : colors.accent }]}>
                {latestMessage.role === 'assistant' ? 'ZARA' : 'YOU'}
              </Text>
              {isThinking ? <ActivityIndicator size="small" color={colors.primary} /> : null}
            </View>
            <Text style={[styles.responseText, { color: colors.secondaryForeground }]}>{latestMessage.text}</Text>
          </View>
        ) : null}

        {sendError || voiceError ? (
          <View style={[styles.errorNotice, { backgroundColor: colors.card, borderColor: colors.destructive }]}>
            <Feather name="alert-circle" size={16} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.secondaryForeground }]}>{voiceError ?? sendError}</Text>
            <Pressable onPress={() => { clearSendError(); setVoiceError(null); }} hitSlop={10}>
              <Feather name="x" size={16} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ) : null}

        {listening ? (
          <View style={[styles.notice, { borderColor: colors.accent, backgroundColor: colors.card }]}>
            <Feather name="radio" size={16} color={colors.accent} />
            <Text style={[styles.noticeText, { color: colors.secondaryForeground }]}>
              {settings.language === 'hu'
                ? 'Folyamatos beszélgetés aktív. A válasz után újra figyelek.'
                : 'Continuous conversation is active. I’ll listen again after replying.'}
            </Text>
          </View>
        ) : null}

        {wakeWordListening && !listening ? (
          <View style={[styles.notice, { borderColor: colors.primary, backgroundColor: colors.card }]}>
            <Feather name="radio" size={16} color={colors.primary} />
            <Text style={[styles.noticeText, { color: colors.secondaryForeground }]}>
              {settings.language === 'hu'
                ? 'Ébresztőszó aktív. Mondd: „Hello Zara”.'
                : 'Wake phrase active. Say “Hello Zara”.'}
            </Text>
          </View>
        ) : null}

        <View style={styles.sectionHeading}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
            {settings.language === 'hu' ? 'GYORS INDÍTÁS' : 'QUICK START'}
          </Text>
          <Text style={[styles.sectionHint, { color: colors.mutedForeground }]}>
            {conversations.length ? `${conversations.length} ${settings.language === 'hu' ? 'beszélgetés' : 'sessions'}` : '0 sessions'}
          </Text>
        </View>

        <View style={styles.quickRow}>
          {[
            { icon: 'message-circle' as const, label: settings.language === 'hu' ? 'Kérdezz bármit' : 'Ask anything' },
            { icon: 'calendar' as const, label: settings.language === 'hu' ? 'Tervezd a napod' : 'Plan my day' },
            { icon: 'zap' as const, label: settings.language === 'hu' ? 'Ötleteljünk' : 'Brainstorm' },
          ].map((item) => (
            <Pressable
              key={item.label}
              onPress={() => setText(item.label)}
              style={({ pressed }) => [
                styles.quickCard,
                { backgroundColor: colors.card, borderColor: colors.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <Feather name={item.icon} size={17} color={colors.primary} />
              <Text style={[styles.quickText, { color: colors.secondaryForeground }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.composerWrap}>
          <View style={[styles.composer, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              accessibilityLabel="Message Zara"
              testID="message-input"
              value={text}
              onChangeText={setText}
              placeholder={settings.language === 'hu' ? 'Írj Zarának…' : 'Message Zara…'}
              placeholderTextColor={colors.mutedForeground}
              multiline
              editable={!isThinking && !listening && !transcribing && !isSpeaking}
              style={[styles.input, { color: colors.foreground }]}
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />
            <Pressable
              accessibilityLabel={listening ? 'Stop listening' : transcribing ? 'Recognizing speech' : 'Start voice input'}
              testID="voice-button"
              onPress={handleMic}
              disabled={(isThinking || transcribing || isSpeaking) && !voiceSessionActive}
              style={({ pressed }) => [
                styles.micButton,
                { backgroundColor: listening ? colors.accent : colors.secondary, opacity: pressed ? 0.72 : transcribing ? 0.55 : 1 },
              ]}
            >
              {transcribing
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Feather name={listening ? 'square' : 'mic'} size={18} color={listening ? colors.accentForeground : colors.primary} />}
            </Pressable>
            <Pressable
              accessibilityLabel="Send message"
              testID="send-button"
              onPress={handleSend}
              disabled={isThinking || isSpeaking || !text.trim()}
              style={({ pressed }) => [
                styles.sendButton,
                { backgroundColor: text.trim() ? colors.primary : colors.secondary, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              {isThinking ? <ActivityIndicator size="small" color={colors.primaryForeground} /> : <Feather name="arrow-up" size={19} color={text.trim() ? colors.primaryForeground : colors.mutedForeground} />}
            </Pressable>
          </View>
          <Text style={[styles.composerFootnote, { color: colors.mutedForeground }]}>
            {settings.language === 'hu' ? 'A Zara helyben tárolja az előzményeket.' : 'Zara keeps your conversations on this device.'}
          </Text>
        </View>

        <View style={[styles.diagnosticPanel, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.diagnosticHeader}>
            <Pressable
              accessibilityLabel="Toggle diagnostics"
              onPress={() => setDiagnosticsExpanded((expanded) => !expanded)}
              style={styles.diagnosticTitleButton}
            >
              <Feather name={diagnosticsExpanded ? 'chevron-down' : 'chevron-right'} size={15} color={colors.primary} />
              <Text style={[styles.diagnosticTitle, { color: colors.primary }]}>DIAGNOSTIKA / TEMP</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="Clear diagnostics"
              onPress={clearDiagnostics}
              hitSlop={8}
            >
              <Text style={[styles.diagnosticClear, { color: colors.mutedForeground }]}>CLEAR</Text>
            </Pressable>
          </View>
          {diagnosticsExpanded ? (
            diagnostics.length === 0 ? (
              <Text style={[styles.diagnosticEmpty, { color: colors.mutedForeground }]}>
                API-kérés után itt jelenik meg a teljes URL, metódus, body, státusz és válasz.
              </Text>
            ) : (
              diagnostics
                .slice()
                .reverse()
                .map((entry) => (
                  <Text
                    key={entry.id}
                    selectable
                    style={[styles.diagnosticEntry, { color: colors.secondaryForeground }]}
                  >
                    {diagnosticLines(entry).join('\n')}
                  </Text>
                ))
            )
          ) : null}
        </View>

        {!hydrated ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 24, flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 2.4 },
  greeting: { fontSize: 28, fontWeight: '700', marginTop: 7, letterSpacing: -0.6 },
  buildTag: { fontSize: 9, marginTop: 5, letterSpacing: 0.3 },
  iconButton: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  orbStage: { alignItems: 'center', justifyContent: 'center', marginTop: 24, marginBottom: 20 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: -5 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 13, letterSpacing: 0.2 },
  responseCard: { borderWidth: 1, borderRadius: 18, padding: 15, marginBottom: 18 },
  responseHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  responseLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 1.8 },
  responseText: { fontSize: 14, lineHeight: 21 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 18 },
  errorNotice: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 18 },
  noticeText: { fontSize: 12, flex: 1, lineHeight: 17 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 11 },
  sectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  sectionHint: { fontSize: 11 },
  quickRow: { flexDirection: 'row', gap: 9 },
  quickCard: { flex: 1, minHeight: 82, padding: 12, borderWidth: 1, borderRadius: 16, justifyContent: 'space-between' },
  quickText: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  composerWrap: { marginTop: 26, paddingTop: 6 },
  composer: { minHeight: 64, borderRadius: 20, borderWidth: 1, padding: 8, flexDirection: 'row', alignItems: 'flex-end', gap: 7 },
  input: { flex: 1, fontSize: 15, lineHeight: 20, maxHeight: 80, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 9 },
  micButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  sendButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  composerFootnote: { textAlign: 'center', fontSize: 10, marginTop: 10 },
  diagnosticPanel: { marginTop: 22, borderWidth: 1, borderRadius: 16, padding: 12 },
  diagnosticHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  diagnosticTitleButton: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 2 },
  diagnosticTitle: { fontSize: 10, fontWeight: '800', letterSpacing: 1.4 },
  diagnosticClear: { fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  diagnosticEmpty: { fontSize: 10, lineHeight: 15, marginTop: 10 },
  diagnosticEntry: { fontFamily: 'monospace', fontSize: 10, lineHeight: 15, marginTop: 12 },
  loader: { marginTop: 20 },
});
