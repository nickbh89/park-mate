import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity } from 'react-native';
import { haversineM } from '../services/geofence';
import { formatMins, fmtTime } from '../services/stayTimer';

export default function HomeScreen({
  monitoring, session, sites, lastFix, onToggleMonitoring, onOpenSettings, onEndSession,
}) {
  const nearby = React.useMemo(() => {
    if (!lastFix) return sites.slice(0, 8);
    return [...sites]
      .map((s) => ({ ...s, distM: haversineM(s.lat, s.lng, lastFix.lat, lastFix.lng) }))
      .sort((a, b) => a.distM - b.distM)
      .slice(0, 8);
  }, [sites, lastFix]);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <Text style={styles.brand}>ParkMate</Text>
        <TouchableOpacity onPress={onOpenSettings}><Text style={styles.gear}>⚙︎</Text></TouchableOpacity>
      </View>

      {session ? (
        <View style={[styles.card, styles.activeCard]}>
          <Text style={styles.activeLabel}>PARKED — {session.siteName}</Text>
          {session.deadlineAt ? (
            <>
              <Countdown deadlineAt={session.deadlineAt} />
              <Text style={styles.deadlineText}>Leave by {fmtTime(session.deadlineAt)}</Text>
            </>
          ) : (
            <Text style={styles.deadlineText}>{session.hint || 'Check signage for terms.'}</Text>
          )}
          <TouchableOpacity style={styles.endBtn} onPress={onEndSession}>
            <Text style={styles.endBtnText}>I've left — end session</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.statusTitle}>{monitoring ? 'Watching for car parks' : 'Detection paused'}</Text>
          <Text style={styles.statusSub}>
            {monitoring
              ? `${sites.length} enforced sites loaded. You'll get an alert when you park in one.`
              : 'Turn detection on to get alerts before parking charges.'}
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.toggle, monitoring ? styles.toggleOn : styles.toggleOff]}
        onPress={onToggleMonitoring}
      >
        <Text style={styles.toggleText}>{monitoring ? 'Pause detection' : 'Start detection'}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Nearby enforced car parks</Text>
      <FlatList
        data={nearby}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <View style={styles.siteRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.siteName}>{item.name}</Text>
              <Text style={styles.siteMeta}>
                {item.operatorName} · {item.siteType === 'free-max-stay' && item.maxStayMinutes
                  ? `free ${formatMins(item.maxStayMinutes)}`
                  : item.siteType.replace(/-/g, ' ')}
                {!item.verified ? ' · unverified' : ''}
              </Text>
            </View>
            {item.distM != null && (
              <Text style={styles.siteDist}>
                {item.distM < 1000 ? `${Math.round(item.distM)} m` : `${(item.distM / 1609).toFixed(1)} mi`}
              </Text>
            )}
          </View>
        )}
      />
    </View>
  );
}

function Countdown({ deadlineAt }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = deadlineAt - now;
  const over = left <= 0;
  const abs = Math.abs(left);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  return (
    <Text style={[styles.countdown, over && styles.countdownOver]}>
      {over ? '-' : ''}{h > 0 ? `${h}:` : ''}{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
      {over ? ' OVER' : ' left'}
    </Text>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0e1726', paddingTop: 60, paddingHorizontal: 20 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  brand: { fontSize: 28, fontWeight: '800', color: '#fff' },
  gear: { fontSize: 24, color: '#94a3b8' },
  card: { backgroundColor: '#16233a', borderRadius: 16, padding: 20, marginBottom: 14 },
  activeCard: { borderColor: '#f59e0b', borderWidth: 1 },
  activeLabel: { color: '#f59e0b', fontWeight: '700', fontSize: 13, letterSpacing: 1, marginBottom: 8 },
  countdown: { color: '#fff', fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'] },
  countdownOver: { color: '#ef4444' },
  deadlineText: { color: '#cbd5e1', fontSize: 15, marginTop: 6 },
  endBtn: { marginTop: 14, backgroundColor: '#1e3a5f', borderRadius: 10, padding: 12, alignItems: 'center' },
  endBtnText: { color: '#93c5fd', fontWeight: '600' },
  statusTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  statusSub: { color: '#94a3b8', fontSize: 14, marginTop: 6, lineHeight: 20 },
  toggle: { borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 20 },
  toggleOn: { backgroundColor: '#7f1d1d' },
  toggleOff: { backgroundColor: '#22c55e' },
  toggleText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  sectionTitle: { color: '#64748b', fontSize: 13, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  siteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1e293b' },
  siteName: { color: '#e2e8f0', fontSize: 15, fontWeight: '600' },
  siteMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  siteDist: { color: '#94a3b8', fontSize: 13, marginLeft: 10 },
});
