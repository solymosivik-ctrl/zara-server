import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import React, { useCallback } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useAudioRecorder, RecordingPresets } from 'expo-audio';
import { Screen } from '@/components/Screen';
import { normalizeOwnerName, useZara, type ZaraSettings } from '@/context/ZaraContext';
import { ZARA_APP_VERSION, ZARA_BUNDLE_ID } from '@/constants/build';
import { useColors } from '@/hooks/useColors';
import { recordVoiceProfileSample, VoiceInputError } from '@/services/speech';
import {
  isCalculatorAccessibilityEnabled,
  openCalculatorAccessibilitySettings,
} from '@/services/calculator-accessibility';

export default function SettingsScreen() {
  const colors = useColors();
  const { settings, updateSettings } = useZara();
  const hu = settings.language === 'hu';
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true });
  const [training, setTraining] = React.useState(false);
  const [trainingStep, setTrainingStep] = React.useState(0);
  const [ownerNameDraft, setOwnerNameDraft] = React.useState(settings.ownerName ?? '');
  const [accessibilityEnabled, setAccessibilityEnabled] = React.useState(false);

  React.useEffect(() => {
    setOwnerNameDraft(settings.ownerName ?? '');
  }, [settings.ownerName]);

  const refreshAccessibilityState = useCallback(async () => {
    setAccessibilityEnabled(await isCalculatorAccessibilityEnabled());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshAccessibilityState();
    }, [refreshAccessibilityState]),
  );

  const trainVoiceProfile = async () => {
    if (training) return;
    setTraining(true);
    const samples: number[][] = [];
    try {
      for (let step = 0; step < 3; step += 1) {
        setTrainingStep(step + 1);
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        samples.push(await recordVoiceProfileSample(recorder));
      }
      updateSettings({
        ownerVoiceProfile: { samples, createdAt: new Date().toISOString() },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert(
        hu ? 'A hangprofil nem készült el' : 'Voice profile was not created',
        error instanceof VoiceInputError
          ? error.message
          : hu
            ? 'Mondd a mintamondatot közelebb a telefonhoz, majd próbáld újra.'
            : 'Speak closer to the phone and try again.',
      );
    } finally {
      setTraining(false);
      setTrainingStep(0);
    }
  };

  const toggle = (key: keyof ZaraSettings, value: boolean) => {
    updateSettings({ [key]: value });
    Haptics.selectionAsync();
  };

  const handleAccessibilitySettings = async () => {
    try {
      await openCalculatorAccessibilitySettings();
    } catch (error) {
      Alert.alert(
        hu ? 'AccessibilityService nem érhető el' : 'AccessibilityService unavailable',
        error instanceof Error ? error.message : hu ? 'Nyisd meg ezt a funkciót telepített Android APK-ból.' : 'Use this feature from the installed Android APK.',
      );
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={[styles.eyebrow, { color: colors.primary }]}>ZARA / CONTROL</Text>
        <Text style={[styles.title, { color: colors.foreground }]}>{hu ? 'Beállítások' : 'Settings'}</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {hu ? 'A Zara hangjának és intelligenciájának vezérlése.' : 'Shape Zara’s voice, language, and intelligence.'}
        </Text>

        <SettingsSection title={hu ? 'HANG' : 'VOICE'} colors={colors}>
          <SettingsRow icon="volume-2" title={hu ? 'Beszélt válaszok' : 'Spoken responses'} subtitle={hu ? 'Válaszok felolvasása' : 'Read assistant replies aloud'} colors={colors}>
            <Switch value={settings.voiceEnabled} onValueChange={(value) => toggle('voiceEnabled', value)} trackColor={{ false: colors.secondary, true: colors.primary }} thumbColor={settings.voiceEnabled ? colors.primaryForeground : colors.mutedForeground} />
          </SettingsRow>
          <SettingsRow
            icon="radio"
            title={hu ? 'Szia / Hallasz Zara' : 'Hello Zara / Can you hear me'}
            subtitle={
              hu
                ? 'Automatikus hangébresztés kikapcsolva; a mikrofon gomb továbbra is használható'
                : 'Automatic wake is disabled; the microphone button is still available'
            }
            colors={colors}
          >
            <Switch
              value={settings.wakeWordEnabled}
              onValueChange={(value) => toggle('wakeWordEnabled', value)}
              disabled
              trackColor={{ false: colors.secondary, true: colors.primary }}
              thumbColor={settings.wakeWordEnabled ? colors.primaryForeground : colors.mutedForeground}
            />
          </SettingsRow>
          <ChoiceRow icon="mic" title={hu ? 'Hang' : 'Voice'} value={settings.voiceName} options={['Zara', 'Nova', 'Atlas']} onChange={(value) => updateSettings({ voiceName: value })} colors={colors} />
          <ChoiceRow icon="sliders" title={hu ? 'Sebesség' : 'Speech speed'} value={settings.voiceSpeed} options={['slow', 'balanced', 'fast']} onChange={(value) => updateSettings({ voiceSpeed: value as ZaraSettings['voiceSpeed'] })} colors={colors} />
        </SettingsSection>

        <SettingsSection title={hu ? 'TULAJDONOS' : 'OWNER'} colors={colors}>
          <SettingsRow
            icon="user"
            title={settings.ownerName ?? (hu ? 'Nincs megadva név' : 'No name saved')}
            subtitle={hu ? 'A teljes név helyben van tárolva' : 'The full name is stored on this device'}
            colors={colors}
          >
            {settings.ownerName ? (
              <Pressable
                accessibilityLabel={hu ? 'Tulajdonos nevének törlése' : 'Delete owner name'}
                onPress={() => updateSettings({ ownerName: null, ownerVoiceProfile: null })}
                hitSlop={10}
              >
                <Feather name="trash-2" size={18} color={colors.destructive} />
              </Pressable>
            ) : null}
          </SettingsRow>
          <View style={[styles.ownerNameEditor, { borderBottomColor: colors.border }]}>
            <TextInput
              value={ownerNameDraft}
              onChangeText={setOwnerNameDraft}
              placeholder={hu ? 'Teljes név, például: Solymosi Viktor' : 'Full name, for example: Solymosi Viktor'}
              placeholderTextColor={colors.mutedForeground}
              autoCapitalize="words"
              returnKeyType="done"
              style={[styles.ownerNameInput, { color: colors.foreground, borderColor: colors.border }]}
            />
            <Pressable
              onPress={() => {
                const ownerName = normalizeOwnerName(ownerNameDraft);
                if (!ownerName) {
                  Alert.alert(
                    hu ? 'Teljes név szükséges' : 'Full name required',
                    hu ? 'Írj be legalább két névelemet.' : 'Enter at least two name parts.',
                  );
                  return;
                }
                updateSettings({ ownerName, language: 'hu' });
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }}
              style={({ pressed }) => [styles.saveNameButton, { backgroundColor: colors.primary, opacity: pressed ? 0.78 : 1 }]}
            >
              <Text style={{ color: colors.primaryForeground, fontSize: 12, fontWeight: '700' }}>{hu ? 'Mentés' : 'Save'}</Text>
            </Pressable>
          </View>
          <SettingsRow
            icon="shield"
            title={settings.ownerVoiceProfile ? (hu ? 'Hangprofil betanítva' : 'Voice profile trained') : (hu ? 'Hangprofil betanítása' : 'Train voice profile')}
            subtitle={
              training
                ? `${hu ? 'Mondd: „Szia Zara”' : 'Say: “Szia Zara”'} (${trainingStep}/3)`
                : hu
                  ? 'Mondd háromszor ugyanazt az ébresztőmondatot: „Szia Zara”'
                  : 'Say the same wake phrase three times: “Szia Zara”'
            }
            colors={colors}
          >
            <Pressable
              accessibilityLabel={hu ? 'Hangprofil betanítása' : 'Train voice profile'}
              disabled={training}
              onPress={() => void trainVoiceProfile()}
              hitSlop={10}
            >
              <Feather name={training ? 'loader' : settings.ownerVoiceProfile ? 'refresh-cw' : 'mic'} size={18} color={training ? colors.mutedForeground : colors.primary} />
            </Pressable>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={hu ? 'NYELV' : 'LANGUAGE'} colors={colors}>
          <SettingsRow
            icon="globe"
            title="Magyar"
            subtitle="Zara rögzített beszéd- és válasznyelve"
            colors={colors}
          >
            <Feather name="check" size={18} color={colors.primary} />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={hu ? 'ANDROID VEZÉRLÉS' : 'ANDROID CONTROL'} colors={colors}>
          <SettingsRow
            icon="shield"
            title={hu ? 'Calculator bezárása hanggal' : 'Close Calculator by voice'}
            subtitle={
              accessibilityEnabled
                ? hu
                  ? 'Engedélyezve: a Zara a Calculator előterében figyeli a parancsot'
                  : 'Enabled: Zara listens while Calculator is in front'
                : hu
                  ? 'Engedélyezd az Android Accessibility beállításaiban'
                  : 'Enable it in Android Accessibility settings'
            }
            colors={colors}
          >
            <Pressable
              accessibilityLabel={hu ? 'Accessibility beállítások megnyitása' : 'Open accessibility settings'}
              testID="open-accessibility-settings"
              onPress={() => void handleAccessibilitySettings()}
              style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
            >
              <Text style={[styles.accessibilityButton, { color: accessibilityEnabled ? colors.primary : colors.accent }]}>
                {hu ? 'BEÁLLÍTÁS' : 'SET UP'}
              </Text>
            </Pressable>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title={hu ? 'INTELLIGENCIA' : 'INTELLIGENCE'} colors={colors}>
          <ChoiceRow icon="cpu" title={hu ? 'AI modell' : 'AI model'} value={settings.aiModel} options={['AI connection ready', 'Fast reasoning', 'Deep reasoning']} onChange={(value) => updateSettings({ aiModel: value })} colors={colors} />
          <ChoiceRow icon="sliders" title={hu ? 'Válasz stílusa' : 'Response style'} value={settings.responseStyle} options={['focused', 'warm', 'technical']} onChange={(value) => updateSettings({ responseStyle: value as ZaraSettings['responseStyle'] })} colors={colors} />
        </SettingsSection>

        <SettingsSection title={hu ? 'DIAGNOSZTIKA' : 'DEBUG'} colors={colors}>
          <SettingsRow
            icon="hash"
            title={hu ? 'Mobil bundle' : 'Mobile bundle'}
            subtitle={hu ? 'A futó Expo bundle azonosítója' : 'Identifier of the running Expo bundle'}
            colors={colors}
          >
            <Text style={[styles.bundleValue, { color: colors.primary }]}>{ZARA_BUNDLE_ID}</Text>
          </SettingsRow>
          <SettingsRow
            icon="info"
            title={hu ? 'Alkalmazásverzió' : 'App version'}
            subtitle={hu ? 'Az aktuális Expo manifestből' : 'Read from the current Expo manifest'}
            colors={colors}
          >
            <Text style={[styles.bundleValue, { color: colors.primary }]}>{ZARA_APP_VERSION}</Text>
          </SettingsRow>
        </SettingsSection>

        <View style={[styles.readyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.readyIcon, { backgroundColor: colors.secondary }]}>
            <Feather name="shield" size={18} color={colors.primary} />
          </View>
          <View style={styles.readyCopy}>
            <Text style={[styles.readyTitle, { color: colors.foreground }]}>{hu ? 'Helyi előzmények' : 'Local-first memory'}</Text>
            <Text style={[styles.readyText, { color: colors.mutedForeground }]}>{hu ? 'A beszélgetések ezen az eszközön maradnak.' : 'Conversations stay on this device for now.'}</Text>
          </View>
          <View style={[styles.readyDot, { backgroundColor: colors.primary }]} />
        </View>

        <Text style={[styles.version, { color: colors.mutedForeground }]}>ZARA CORE · {ZARA_BUNDLE_ID}</Text>
      </ScrollView>
    </Screen>
  );
}

function SettingsSection({ title, colors, children }: { title: string; colors: ReturnType<typeof useColors>; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{title}</Text>
      <View style={[styles.sectionBox, { backgroundColor: colors.card, borderColor: colors.border }]}>{children}</View>
    </View>
  );
}

function SettingsRow({ icon, title, subtitle, colors, children }: { icon: keyof typeof Feather.glyphMap; title: string; subtitle: string; colors: ReturnType<typeof useColors>; children: React.ReactNode }) {
  return (
    <View style={styles.settingsRow}>
      <View style={[styles.settingIcon, { backgroundColor: colors.secondary }]}><Feather name={icon} size={17} color={colors.primary} /></View>
      <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.foreground }]}>{title}</Text><Text style={[styles.settingSubtitle, { color: colors.mutedForeground }]}>{subtitle}</Text></View>
      {children}
    </View>
  );
}

function ChoiceRow({ icon, title, value, options, onChange, colors }: { icon: keyof typeof Feather.glyphMap; title: string; value: string; options: string[]; onChange: (value: string) => void; colors: ReturnType<typeof useColors> }) {
  const nextValue = options[(options.indexOf(value) + 1) % options.length];
  return (
    <Pressable onPress={() => onChange(nextValue)} style={({ pressed }) => [styles.choiceRow, { opacity: pressed ? 0.72 : 1 }]}>
      <View style={[styles.settingIcon, { backgroundColor: colors.secondary }]}><Feather name={icon} size={17} color={colors.primary} /></View>
      <Text style={[styles.choiceTitle, { color: colors.foreground }]}>{title}</Text>
      <Text style={[styles.choiceValue, { color: colors.primary }]}>{value}</Text>
      <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 30 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 2.2 },
  title: { fontSize: 28, fontWeight: '700', marginTop: 7, letterSpacing: -0.6 },
  subtitle: { fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 300 },
  section: { marginTop: 28 },
  sectionTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8, marginBottom: 10 },
  sectionBox: { borderRadius: 18, borderWidth: 1, overflow: 'hidden' },
  settingsRow: { minHeight: 70, paddingHorizontal: 13, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#233149' },
  settingIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  settingCopy: { flex: 1 },
  settingTitle: { fontSize: 14, fontWeight: '600' },
  settingSubtitle: { fontSize: 11, marginTop: 4 },
  ownerNameEditor: { padding: 13, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  ownerNameInput: { flex: 1, minHeight: 42, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 13 },
  saveNameButton: { minHeight: 42, paddingHorizontal: 13, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  choiceRow: { minHeight: 61, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 12 },
  choiceTitle: { flex: 1, fontSize: 14, fontWeight: '600' },
  choiceValue: { fontSize: 11, maxWidth: 120, textAlign: 'right' },
  bundleValue: { fontSize: 10, maxWidth: 130, textAlign: 'right', fontWeight: '700' },
  accessibilityButton: { fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  readyCard: { marginTop: 27, padding: 14, borderRadius: 18, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  readyIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  readyCopy: { flex: 1 },
  readyTitle: { fontSize: 13, fontWeight: '700' },
  readyText: { fontSize: 11, marginTop: 4, lineHeight: 16 },
  readyDot: { width: 8, height: 8, borderRadius: 4 },
  version: { textAlign: 'center', fontSize: 10, letterSpacing: 1.4, marginTop: 25 },
});