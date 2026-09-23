import { Feather } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { useZara, type Reminder } from '@/context/ZaraContext';
import { useColors } from '@/hooks/useColors';
import { getReminderPermissionStatus, requestReminderPermission } from '@/services/reminders';

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function initialReminderDate(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

function dateParts(date: Date): { date: string; time: string } {
  return {
    date: `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function parseDateTime(dateText: string, timeText: string): Date | null {
  const dateMatch = dateText.trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  const timeMatch = timeText.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const result = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    result.getFullYear() !== year ||
    result.getMonth() !== month - 1 ||
    result.getDate() !== day ||
    result.getHours() !== hour ||
    result.getMinutes() !== minute
  ) {
    return null;
  }
  return result;
}

function formatReminderDate(value: string): string {
  return new Date(value).toLocaleString('hu-HU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setTimeFromNow(offsetMinutes: number): { date: string; time: string } {
  const date = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return dateParts(date);
}

function setNextTime(hour: number): { date: string; time: string } {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return dateParts(date);
}

export default function RemindersScreen() {
  const colors = useColors();
  const { reminders, addReminder, deleteReminder, settings } = useZara();
  const hu = settings.language === 'hu';
  const initial = dateParts(initialReminderDate());
  const [title, setTitle] = useState('');
  const [dateText, setDateText] = useState(initial.date);
  const [timeText, setTimeText] = useState(initial.time);
  const [saving, setSaving] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<{
    granted: boolean;
    canAskAgain: boolean;
  } | null>(null);

  const sortedReminders = useMemo(
    () => [...reminders].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt)),
    [reminders],
  );

  const refreshNotificationPermission = async () => {
    try {
      setNotificationPermission(await getReminderPermissionStatus());
    } catch {
      setNotificationPermission(null);
    }
  };

  useEffect(() => {
    void refreshNotificationPermission();
  }, []);

  const handleRequestPermission = async () => {
    try {
      const granted = await requestReminderPermission();
      await refreshNotificationPermission();
      if (!granted && Platform.OS !== 'web') {
        await Linking.openSettings();
      }
    } catch {
      Alert.alert(
        hu ? 'Értesítés nem engedélyezhető' : 'Notifications unavailable',
        hu ? 'Nyisd meg a telefon beállításaiban a Zara értesítéseit.' : 'Open Zara notification settings on your phone.',
      );
    }
  };

  const selectTime = (parts: { date: string; time: string }) => {
    setDateText(parts.date);
    setTimeText(parts.time);
  };

  const handleAdd = async () => {
    const scheduledAt = parseDateTime(dateText, timeText);
    if (!title.trim()) {
      Alert.alert(hu ? 'Hiányzó szöveg' : 'Missing text', hu ? 'Írd le, mire emlékeztessen Zara.' : 'Write what Zara should remind you about.');
      return;
    }
    if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
      Alert.alert(hu ? 'Érvénytelen időpont' : 'Invalid time', hu ? 'Adj meg egy érvényes, jövőbeli időpontot.' : 'Enter a valid time in the future.');
      return;
    }

    setSaving(true);
    try {
      await addReminder(title, scheduledAt);
      setTitle('');
      const next = dateParts(initialReminderDate());
      setDateText(next.date);
      setTimeText(next.time);
    } catch (error) {
      Alert.alert(
        hu ? 'Az emlékeztető nem készült el' : 'Reminder was not created',
        error instanceof Error ? error.message : hu ? 'Engedélyezd az értesítéseket, majd próbáld újra.' : 'Allow notifications and try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (reminder: Reminder) => {
    Alert.alert(
      hu ? 'Emlékeztető törlése' : 'Delete reminder',
      reminder.title,
      [
        { text: hu ? 'Mégse' : 'Cancel', style: 'cancel' },
        { text: hu ? 'Törlés' : 'Delete', style: 'destructive', onPress: () => void deleteReminder(reminder.id) },
      ],
    );
  };

  return (
    <Screen>
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
          <Text style={[styles.eyebrow, { color: colors.primary }]}>ZARA / PLAN</Text>
          <Text style={[styles.title, { color: colors.foreground }]}>{hu ? 'Emlékeztetők' : 'Reminders'}</Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {hu ? 'Helyi értesítések a telefonodon, beszédfelismerés nélkül.' : 'Local phone notifications, without speech recognition.'}
          </Text>

          {notificationPermission && !notificationPermission.granted ? (
            <Pressable
              onPress={() => void handleRequestPermission()}
              style={({ pressed }) => [
                styles.permissionCard,
                { backgroundColor: colors.secondary, borderColor: colors.border, opacity: pressed ? 0.72 : 1 },
              ]}
            >
              <Feather name="bell-off" size={18} color={colors.accent} />
              <View style={styles.permissionCopy}>
                <Text style={[styles.permissionTitle, { color: colors.foreground }]}>
                  {hu ? 'Értesítések nincsenek engedélyezve' : 'Notifications are disabled'}
                </Text>
                <Text style={[styles.permissionText, { color: colors.mutedForeground }]}>
                  {notificationPermission.canAskAgain
                    ? hu
                      ? 'Koppints ide az engedély megadásához.'
                      : 'Tap here to allow notifications.'
                    : hu
                      ? 'Koppints ide a telefon beállításainak megnyitásához.'
                      : 'Tap here to open phone settings.'}
                </Text>
              </View>
              <Feather name="chevron-right" size={17} color={colors.mutedForeground} />
            </Pressable>
          ) : null}

          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.cardHeader}>
              <View style={[styles.cardIcon, { backgroundColor: colors.secondary }]}>
                <Feather name="plus" size={18} color={colors.primary} />
              </View>
              <View style={styles.cardCopy}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>{hu ? 'Új emlékeztető' : 'New reminder'}</Text>
                <Text style={[styles.cardSubtitle, { color: colors.mutedForeground }]}>
                  {hu ? 'Az értesítést a telefon helyben ütemezi.' : 'The phone schedules the notification locally.'}
                </Text>
              </View>
            </View>

            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={hu ? 'Például: Vedd be a gyógyszert' : 'For example: Take your medicine'}
              placeholderTextColor={colors.mutedForeground}
              style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
              returnKeyType="done"
            />

            <View style={styles.fieldRow}>
              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{hu ? 'Dátum' : 'Date'}</Text>
                <TextInput
                  value={dateText}
                  onChangeText={setDateText}
                  placeholder="2026.09.08"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  style={[styles.input, styles.smallInput, { color: colors.foreground, borderColor: colors.border }]}
                />
              </View>
              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{hu ? 'Idő' : 'Time'}</Text>
                <TextInput
                  value={timeText}
                  onChangeText={setTimeText}
                  placeholder="08:00"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  style={[styles.input, styles.smallInput, { color: colors.foreground, borderColor: colors.border }]}
                />
              </View>
            </View>

            <View style={styles.quickRow}>
              {[
                { label: hu ? '1 óra múlva' : 'In 1 hour', parts: setTimeFromNow(60) },
                { label: hu ? 'Holnap 8:00' : 'Tomorrow 8:00', parts: setNextTime(8) },
                { label: hu ? 'Holnap 20:00' : 'Tomorrow 20:00', parts: setNextTime(20) },
              ].map((option) => (
                <Pressable
                  key={option.label}
                  onPress={() => selectTime(option.parts)}
                  style={({ pressed }) => [styles.quickButton, { backgroundColor: colors.secondary, opacity: pressed ? 0.7 : 1 }]}
                >
                  <Text style={[styles.quickText, { color: colors.secondaryForeground }]}>{option.label}</Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              onPress={() => void handleAdd()}
              disabled={saving}
              style={({ pressed }) => [styles.addButton, { backgroundColor: colors.primary, opacity: saving || pressed ? 0.7 : 1 }]}
            >
              <Feather name="bell" size={16} color={colors.primaryForeground} />
              <Text style={[styles.addButtonText, { color: colors.primaryForeground }]}>
                {saving ? (hu ? 'Mentés…' : 'Saving…') : hu ? 'Emlékeztető beállítása' : 'Set reminder'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.listHeader}>
            <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>{hu ? 'ÜTEMEZVE' : 'SCHEDULED'}</Text>
            <Text style={[styles.count, { color: colors.primary }]}>{reminders.length}</Text>
          </View>

          {sortedReminders.length === 0 ? (
            <View style={[styles.emptyCard, { borderColor: colors.border }]}>
              <Feather name="calendar" size={24} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>{hu ? 'Még nincs emlékeztető' : 'No reminders yet'}</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                {hu ? 'Az első emlékeztetődet fent tudod beállítani.' : 'Set your first reminder above.'}
              </Text>
            </View>
          ) : (
            sortedReminders.map((reminder) => (
              <View key={reminder.id} style={[styles.reminderRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[styles.reminderIcon, { backgroundColor: colors.secondary }]}>
                  <Feather name="bell" size={16} color={colors.primary} />
                </View>
                <View style={styles.reminderCopy}>
                  <Text style={[styles.reminderTitle, { color: colors.foreground }]}>{reminder.title}</Text>
                  <Text style={[styles.reminderTime, { color: colors.mutedForeground }]}>{formatReminderDate(reminder.scheduledAt)}</Text>
                </View>
                <Pressable accessibilityLabel={hu ? 'Emlékeztető törlése' : 'Delete reminder'} onPress={() => handleDelete(reminder)} hitSlop={10}>
                  <Feather name="trash-2" size={17} color={colors.destructive} />
                </Pressable>
              </View>
            ))
          )}
      </KeyboardAwareScrollViewCompat>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingBottom: 36 },
  eyebrow: { fontSize: 11, fontWeight: '700', letterSpacing: 2.2 },
  title: { fontSize: 28, fontWeight: '700', marginTop: 7, letterSpacing: -0.6 },
  subtitle: { fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: 320 },
  permissionCard: { minHeight: 66, borderRadius: 16, borderWidth: 1, padding: 12, marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 11 },
  permissionCopy: { flex: 1 },
  permissionTitle: { fontSize: 12, fontWeight: '700' },
  permissionText: { fontSize: 11, lineHeight: 16, marginTop: 3 },
  card: { borderRadius: 18, borderWidth: 1, padding: 14, marginTop: 25 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  cardIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  cardCopy: { flex: 1 },
  cardTitle: { fontSize: 14, fontWeight: '700' },
  cardSubtitle: { fontSize: 11, lineHeight: 16, marginTop: 3 },
  input: { minHeight: 44, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 13 },
  fieldRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  field: { flex: 1 },
  fieldLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 6 },
  smallInput: { minHeight: 42 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  quickButton: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  quickText: { fontSize: 11, fontWeight: '600' },
  addButton: { minHeight: 46, borderRadius: 13, marginTop: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  addButtonText: { fontSize: 13, fontWeight: '700' },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 28, marginBottom: 10 },
  sectionTitle: { fontSize: 10, fontWeight: '700', letterSpacing: 1.8 },
  count: { fontSize: 12, fontWeight: '700' },
  emptyCard: { minHeight: 140, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  emptyTitle: { fontSize: 14, fontWeight: '700', marginTop: 10 },
  emptyText: { fontSize: 12, marginTop: 5, textAlign: 'center' },
  reminderRow: { minHeight: 70, borderRadius: 16, borderWidth: 1, padding: 12, marginBottom: 9, flexDirection: 'row', alignItems: 'center', gap: 11 },
  reminderIcon: { width: 35, height: 35, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  reminderCopy: { flex: 1 },
  reminderTitle: { fontSize: 13, fontWeight: '700' },
  reminderTime: { fontSize: 11, marginTop: 4 },
});