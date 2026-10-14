// The detection engine. Everything that has to keep working while ParkMate is
// closed lives here, outside React: the background location task, the geofence
// detector, the current visit and its reminders. The screens subscribe to it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { createDetector, hasLeft } from './geofence';
import { planSession, planUserLimit } from './stayTimer';
import { ensureChannel, ensureNotificationSetup, scheduleSessionReminders, cancelReminders } from './notifications';
import { loadSites, refreshSites, loadUserLimits, saveUserLimits } from './siteSync';

export const LOCATION_TASK = 'parkmate-detection';
const SETTINGS_KEY = 'parkmate:settings';
const HISTORY_KEY = 'parkmate:history';
const SESSION_KEY = 'parkmate:session';
const HISTORY_MAX = 30;
const FIX_INTERVAL_MS = 30000;
export const DEFAULT_SETTINGS = { backgroundEnabled: true, alertLeadMinutes: 15, includeUnverified: true };

const state = {
  ready: false,
  sites: [],
  activeSites: [],
  settings: DEFAULT_SETTINGS,
  session: null,
  history: [],
  userLimits: {},
  lastFix: null,
  monitoring: false,
  mode: null, // 'background' | 'service' | 'foreground'
};
let detector = null;
let watcher = null;
let initPromise = null;
const listeners = new Set();

export function getState() { return state; }
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch {} } }

function rebuildActive() {
  state.activeSites = state.sites.filter((s) => state.settings.includeUnverified || s.verified);
  // Never swap the detector mid-visit: a fresh one would not know we are inside.
  if (!state.session || !detector) detector = createDetector(state.activeSites);
}

async function readJson(key, fallback) {
  try { const raw = await AsyncStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function saveSession() {
  const p = state.session ? AsyncStorage.setItem(SESSION_KEY, JSON.stringify(state.session)) : AsyncStorage.removeItem(SESSION_KEY);
  p.catch(() => {});
}

/** Load everything once. Safe to call from the UI and from the background task. */
export function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const [storedSettings, data, history, limits, session] = await Promise.all([
        readJson(SETTINGS_KEY, null),
        loadSites(),
        readJson(HISTORY_KEY, []),
        loadUserLimits(),
        readJson(SESSION_KEY, null),
      ]);
      if (storedSettings) state.settings = { ...DEFAULT_SETTINGS, ...storedSettings };
      state.sites = data.sites;
      state.history = Array.isArray(history) ? history : [];
      state.userLimits = limits;
      state.session = session;
      rebuildActive();
      try { state.monitoring = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK); } catch { state.monitoring = false; }
      if (state.monitoring) state.mode = 'service';
      state.ready = true;
      emit();
      // Look for a newer database without holding anything up.
      refreshSites(data).then((newer) => {
        if (!newer) return;
        state.sites = newer.sites;
        rebuildActive();
        emit();
      });
    })();
  }
  return initPromise;
}

// ---- visits -----------------------------------------------------------------

async function startSession(site, at) {
  const opts = { alertLeadMinutes: state.settings.alertLeadMinutes };
  const knownLimit = site.siteType === 'free-max-stay' && site.maxStayMinutes;
  // A limit the driver read off the sign on an earlier visit. Not used for pay
  // and display, where the time depends on the ticket bought each visit.
  const remembered = !knownLimit && site.siteType !== 'pay-and-display' ? state.userLimits[site.id] : null;
  const plan = remembered
    ? planUserLimit(site, at, remembered, { ...opts, remembered: true })
    : planSession(site, at, opts);
  let notifIds = [];
  try { await ensureChannel(); notifIds = await scheduleSessionReminders(plan); } catch {}
  state.session = {
    siteId: site.id,
    siteName: site.name,
    siteType: site.siteType,
    gracePeriodMinutes: site.gracePeriodMinutes,
    lat: site.lat,
    lng: site.lng,
    radiusM: site.radiusM,
    entryAt: at,
    deadlineAt: plan.deadlineAt,
    hardLimitAt: plan.hardLimitAt,
    hint: plan.reminders[0]?.message,
    limitSource: knownLimit ? 'database' : remembered ? 'remembered' : null,
    limitMinutes: knownLimit ? site.maxStayMinutes : remembered || null,
    notifIds,
  };
  saveSession();
}

export async function endSession(at = Date.now()) {
  const s = state.session;
  if (!s) return;
  try { await cancelReminders(s.notifIds); } catch {}
  state.session = null;
  saveSession();
  state.history = [
    { id: `${s.siteId}-${s.entryAt}`, siteName: s.siteName, entryAt: s.entryAt, exitAt: at, deadlineAt: s.deadlineAt || null },
    ...state.history,
  ].slice(0, HISTORY_MAX);
  AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)).catch(() => {});
  rebuildActive(); // pick up any database that arrived during the visit
  emit();
}

/** The driver read the sign: start (or restart) the countdown from their answer. */
export async function setSessionLimit(minutes) {
  const s = state.session;
  if (!s) return;
  const payAndDisplay = s.siteType === 'pay-and-display';
  const now = Date.now();
  const site = { id: s.siteId, name: s.siteName, siteType: s.siteType, gracePeriodMinutes: s.gracePeriodMinutes };
  // A max-stay limit runs from arrival; a ticket runs from when it was bought.
  const plan = planUserLimit(site, payAndDisplay ? now : s.entryAt, minutes,
    { alertLeadMinutes: state.settings.alertLeadMinutes, now });
  try { await cancelReminders(s.notifIds); } catch {}
  let notifIds = [];
  try { notifIds = await scheduleSessionReminders(plan); } catch {}
  state.session = { ...s, deadlineAt: plan.deadlineAt, hardLimitAt: plan.hardLimitAt, limitSource: 'you', limitMinutes: minutes, limitDismissed: false, notifIds };
  saveSession();
  if (!payAndDisplay) {
    state.userLimits = { ...state.userLimits, [s.siteId]: minutes };
    saveUserLimits(state.userLimits);
  }
  emit();
}

/** "No limit on the sign": stop asking for this visit and forget any saved limit. */
export async function dismissSessionLimit() {
  const s = state.session;
  if (!s) return;
  try { await cancelReminders(s.notifIds); } catch {}
  state.session = { ...s, deadlineAt: null, hardLimitAt: null, limitSource: null, limitMinutes: null, limitDismissed: true, notifIds: [] };
  saveSession();
  if (state.userLimits[s.siteId]) {
    const next = { ...state.userLimits };
    delete next[s.siteId];
    state.userLimits = next;
    saveUserLimits(next);
  }
  emit();
}

// ---- location fixes ---------------------------------------------------------

// Fixes are handled strictly one batch at a time so two batches can never both
// decide to start a visit.
let chain = Promise.resolve();
export function handleFixes(fixes) {
  chain = chain.then(() => processFixes(fixes)).catch(() => {});
  return chain;
}

async function processFixes(fixes) {
  await init();
  for (const f of fixes) {
    if (typeof f.lat !== 'number' || typeof f.lng !== 'number') continue;
    state.lastFix = f;
    if (state.session && hasLeft(state.session, f.lat, f.lng)) await endSession(f.at);
    const events = detector ? detector.update(f.lat, f.lng, f.at) : [];
    for (const ev of events) {
      if (ev.type === 'enter' && !state.session) await startSession(ev.site, ev.at);
      if (ev.type === 'exit' && state.session?.siteId === ev.site.id) await endSession(ev.at);
    }
  }
  emit();
}

const toFix = (loc) => ({ lat: loc.coords.latitude, lng: loc.coords.longitude, at: loc.timestamp });

// Android delivers fixes here even when ParkMate is closed or the screen is off.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  await handleFixes(data.locations.map(toFix));
});

// ---- starting and stopping --------------------------------------------------

export async function startDetection() {
  await init();
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { ok: false, reason: 'permission' };
  let background = false;
  if (state.settings.backgroundEnabled) {
    try { background = (await Location.requestBackgroundPermissionsAsync()).status === 'granted'; } catch {}
  }
  await ensureNotificationSetup();
  rebuildActive();
  const options = { accuracy: Location.Accuracy.Balanced, timeInterval: FIX_INTERVAL_MS, distanceInterval: 25 };
  try {
    // A foreground service keeps detection alive with the screen off or another
    // app in front. With "Allow all the time" it also survives being restarted.
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      ...options,
      deferredUpdatesInterval: FIX_INTERVAL_MS,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: 'ParkMate is watching for car parks',
        notificationBody: 'You will get an alert when you park somewhere that is enforced.',
        notificationColor: '#22c55e',
      },
    });
    state.mode = background ? 'background' : 'service';
  } catch {
    // Last resort: detect only while ParkMate is open on screen.
    try {
      watcher = await Location.watchPositionAsync(options, (loc) => { handleFixes([toFix(loc)]); });
      state.mode = 'foreground';
    } catch {
      state.monitoring = false;
      state.mode = null;
      emit();
      return { ok: false, reason: 'location' };
    }
  }
  state.monitoring = true;
  emit();
  return { ok: true, mode: state.mode };
}

export async function stopDetection() {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {}
  watcher?.remove();
  watcher = null;
  state.monitoring = false;
  state.mode = null;
  emit();
}

// ---- settings and history ---------------------------------------------------

export async function updateSettings(next) {
  state.settings = next;
  rebuildActive();
  emit();
  try { await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
}

export async function clearHistory() {
  state.history = [];
  emit();
  try { await AsyncStorage.removeItem(HISTORY_KEY); } catch {}
}
