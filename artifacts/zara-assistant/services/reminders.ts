import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';

const REMINDER_CHANNEL_ID = 'zara-reminders';
const isAndroidExpoGo =
  Platform.OS === 'android' &&
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const expoGoNotificationError =
  'Az Androidos emlékeztetők az Expo Go alkalmazásban nem érhetők el. Ehhez Zara development build szükséges.';
let notificationsModulePromise: Promise<typeof import('expo-notifications')> | null = null;
let notificationHandlerConfigured = false;

async function getNotifications(): Promise<typeof import('expo-notifications')> {
  if (isAndroidExpoGo) {
    throw new Error(expoGoNotificationError);
  }
  if (!notificationsModulePromise) {
    notificationsModulePromise = import('expo-notifications').then((loaded) => {
      const candidate = loaded as unknown as {
        default?: typeof import('expo-notifications');
      };
      const module = candidate.default ?? (loaded as typeof import('expo-notifications'));
      return module;
    });
  }
  return notificationsModulePromise;
}

async function configureNotificationHandler(
  Notifications: typeof import('expo-notifications'),
): Promise<void> {
  if (notificationHandlerConfigured) return;
  if (typeof Notifications.setNotificationHandler !== 'function') {
    throw new Error('A telefon értesítési modulja nem érhető el. Töltsd újra a Zara appot, majd próbáld újra.');
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  notificationHandlerConfigured = true;
}

export async function getReminderPermissionStatus(): Promise<{
  granted: boolean;
  canAskAgain: boolean;
} | null> {
  if (Platform.OS === 'web') return null;
  const Notifications = await getNotifications();
  await configureNotificationHandler(Notifications);

  if (Platform.OS === 'android') {
    if (typeof Notifications.setNotificationChannelAsync !== 'function') {
      throw new Error('Az Android értesítési modulja nem érhető el. Töltsd újra a Zara appot, majd próbáld újra.');
    }
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Zara emlékeztetők',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#65E8FF',
    });
  }

  if (typeof Notifications.getPermissionsAsync !== 'function') {
    throw new Error('Az értesítési engedély kezelése nem érhető el ebben az Expo Go munkamenetben.');
  }
  const current = await Notifications.getPermissionsAsync();
  return { granted: current.granted, canAskAgain: current.canAskAgain };
}

export async function requestReminderPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const Notifications = await getNotifications();
  await configureNotificationHandler(Notifications);

  if (Platform.OS === 'android') {
    if (typeof Notifications.setNotificationChannelAsync !== 'function') {
      throw new Error('Az Android értesítési modulja nem érhető el. Töltsd újra a Zara appot, majd próbáld újra.');
    }
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Zara emlékeztetők',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#65E8FF',
    });
  }

  if (
    typeof Notifications.getPermissionsAsync !== 'function' ||
    typeof Notifications.requestPermissionsAsync !== 'function'
  ) {
    throw new Error('Az értesítési engedély kezelése nem érhető el ebben az Expo Go munkamenetben.');
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function scheduleReminderNotification(title: string, scheduledAt: Date): Promise<string> {
  if (scheduledAt.getTime() <= Date.now()) {
    throw new Error('Az emlékeztető időpontjának a jövőben kell lennie.');
  }

  const Notifications = await getNotifications();
  const permitted = await requestReminderPermission();
  if (!permitted) {
    throw new Error('Az értesítések engedélyezése szükséges az emlékeztetőkhöz.');
  }

  if (typeof Notifications.scheduleNotificationAsync !== 'function') {
    throw new Error('Az értesítés ütemezése nem érhető el ebben az Expo Go munkamenetben.');
  }
  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Zara emlékeztető',
      body: title,
      data: { type: 'zara-reminder' },
      sound: 'default',
    },
    trigger: {
      type: 'date',
      date: scheduledAt,
      ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL_ID } : {}),
    } as unknown as import('expo-notifications').NotificationTriggerInput,
  });
  if (typeof Notifications.getAllScheduledNotificationsAsync === 'function') {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    if (!scheduled.some((item) => item.identifier === notificationId)) {
      throw new Error('A telefon nem tudta megerősíteni az értesítés ütemezését.');
    }
  }
  return notificationId;
}

export async function cancelReminderNotification(notificationId: string | null): Promise<void> {
  if (!notificationId || Platform.OS === 'web' || isAndroidExpoGo) return;
  const Notifications = await getNotifications();
  if (typeof Notifications.cancelScheduledNotificationAsync !== 'function') {
    throw new Error('Az értesítés törlése nem érhető el ebben az Expo Go munkamenetben.');
  }
  await Notifications.cancelScheduledNotificationAsync(notificationId);
}