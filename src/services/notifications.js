// Expo notifications wrapper — Android channel + scheduling from a session plan.
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

export const CHANNEL_ID = 'parkmate-alerts';

export async function ensureNotificationSetup() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Parking alerts',
      importance: Notifications.AndroidImportance.MAX,
      sound: 'default',
      vibrationPattern: [0, 400, 200, 400],
      enableVibrate: true,
    });
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/** Schedule every future reminder in a session plan. Returns notification ids. */
export async function scheduleSessionReminders(plan) {
  const ids = [];
  const now = Date.now();
  for (const r of plan.reminders) {
    if (r.at <= now + 1000) {
      // Fire immediately (entry alerts).
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: titleFor(r.kind), body: r.message, sound: 'default' },
        trigger: null,
      });
      ids.push(id);
    } else {
      const id = await Notifications.scheduleNotificationAsync({
        content: { title: titleFor(r.kind), body: r.message, sound: 'default' },
        trigger: { type: 'date', date: new Date(r.at), channelId: CHANNEL_ID },
      });
      ids.push(id);
    }
  }
  return ids;
}

export async function cancelReminders(ids = []) {
  await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id).catch(() => {})));
}

function titleFor(kind) {
  switch (kind) {
    case 'entry': return 'ParkMate — private car park detected';
    case 'pre-deadline': return 'ParkMate — time to head back';
    case 'deadline': return 'ParkMate — max stay reached';
    case 'overstay': return 'ParkMate — overstay warning';
    default: return 'ParkMate';
  }
}
