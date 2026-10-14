import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Linking } from 'react-native';
import { haversineM } from '../services/geofence';
import { formatMins, fmtTime, LIMIT_CHOICES } from '../services/stayTimer';

export default function HomeScreen({
  monitoring, mode, session, sites, lastFix, onToggleMonitoring, onOpenSettings, onEndSession, onSetLimit, onNoLimit,
}) {
  const [changingLimit, setChangingLimit] = React.useState(false);
  React.useEffect(() => { setChangingLimit(false); }, [session?.siteId, session?.entryAt, session?.deadlineAt]);

  // The eight closest sites. One pass over the list, so it stays quick with a
  // database of tens of thousands of car parks.
  const nearby = React.useMemo(() => {
    if (!lastFix) return sites.slice(0, 8);
    const best = [];
    for (const s of sites) {
      const distM = haversineM(s.lat, s.lng, lastFix.lat, lastFix.lng);
      if (best.length === 8 && distM >= best[7].distM) continue;
      let i = best.length;
      while (i > 0 && best[i - 1].distM > distM) i--;
      best.splice(i, 0, { ...s, distM });
      if (best.length > 8) best.pop();
    }
    return best;
  }, [sites, lastFix]);

  const payAndDisplay = session?.siteType === 'pay-and-display';
  const askForLimit = session && (changingLimit || (!session.deadlineAt && !session.limitDismissed));

  const navigateTo = (site) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${site.lat},${site.lng}`;
    Linking.openURL(url).catch(() => {});
  };

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
              {session.limitSource === 'you' || session.limitSource === 'remembered' ? (
                <Text style={styles.limitSource}>
                  {session.limitSource === 'you' ? 'You set' : 'You set last time'}: {formatMins(session.limitMinutes)}
                  {!changingLimit ? <Text style={styles.limitChange} onPress={() => setChangingLimit(true)}>  Change</Text> : null}
                </Text>
              ) : null}
            </>
          ) : session.limitDismissed ? (
            <Text style={styles.deadlineText}>
              No time limit set for this visit.
              <Text style={styles.limitChange} onPress={() => setChangingLimit(true)}>  Set one</Text>
            </Text>
          ) : (
            <Text style={styles.deadlineText}>
              {payAndDisplay ? 'Pay and display. Buy a ticket, then tell ParkMate how long it lasts.' : 'ParkMate has no time limit on record for this car park.'}
            </Text>
          )}
          {askForLimit ? (
            <View style={styles.limitBox}>
              <Text style={styles.limitQuestion}>{payAndDisplay ? 'How long did you pay for?' : 'What does the sign say?'}</Text>
              <View style={styles.limitRow}>
                {LIMIT_CHOICES.map((m) => (
                  <TouchableOpacity key={m} style={styles.limitChip} onPress={() => onSetLimit(m)}>
                    <Text style={styles.limitChipText}>{formatMins(m)}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity style={[styles.limitChip, styles.limitChipGhost]} onPress={() => { setChangingLimit(false); onNoLimit(); }}>
                  <Text style={styles.limitChipGhostText}>{payAndDisplay ? 'Not paying' : 'No limit shown'}</Text>
                </TouchableOpacity>
              </View>
              {!payAndDisplay ? <Text style={styles.limitNote}>Counted from when you arrived. ParkMate remembers it for this car park.</Text> : null}
            </View>
          ) : null}
          <TouchableOpacity style={styles.endBtn} onPress={onEndSession}>
            <Text style={styles.endBtnText}>I've left — end session</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.statusTitle}>{monitoring ? 'Watching for car parks' : 'Detection paused'}</Text>
          <Text style={styles.statusSub}>
            {monitoring
              ? `${sites.length.toLocaleString('en-GB')} car parks loaded. You'll get an alert when you park in one.`
              : 'Turn detection on to get alerts before parking charges.'}
          </Text>
          {monitoring && mode === 'foreground' ? (
            <Text style={styles.modeWarn}>
              Only working while ParkMate is open on screen. To get alerts with the app closed, allow location "all the time" for ParkMate in your phone's settings, then pause and start detection again.
            </Text>
          ) : monitoring ? (
            <Text style={styles.modeOk}>Running in the background. You can close the app or lock your phone.</Text>
          ) : null}
        </View>
      )}

      <TouchableOpacity
        style={[styles.toggle, monitoring ? styles.toggleOn : styles.toggleOff]}
        onPress={onToggleMonitoring}
      >
        <Text style={styles.toggleText}>{monitoring ? 'Pause detection' : 'Start detection'}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Nearby enforced car parks · tap to navigate</Text>
      <FlatList
        data={nearby}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.siteRow} onPress={() => navigateTo(item)}>
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
            <Text style={styles.siteGo}>›</Text>
          </TouchableOpacity>
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
  limitSource: { color: '#94a3b8', fontSize: 13, marginTop: 6 },
  limitChange: { color: '#93c5fd', fontWeight: '600' },
  limitBox: { marginTop: 14 },
  limitQuestion: { color: '#fff', fontSize: 16, fontWeight: '700', marginBottom: 10 },
  limitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  limitChip: { backgroundColor: '#22c55e', borderRadius: 999, paddingVertical: 10, paddingHorizontal: 16 },
  limitChipText: { color: '#06240f', fontWeight: '700', fontSize: 15 },
  limitChipGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#475569' },
  limitChipGhostText: { color: '#cbd5e1', fontWeight: '600', fontSize: 15 },
  limitNote: { color: '#64748b', fontSize: 12, marginTop: 10 },
  endBtn: { marginTop: 14, backgroundColor: '#1e3a5f', borderRadius: 10, padding: 12, alignItems: 'center' },
  endBtnText: { color: '#93c5fd', fontWeight: '600' },
  statusTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  statusSub: { color: '#94a3b8', fontSize: 14, marginTop: 6, lineHeight: 20 },
  modeOk: { color: '#4ade80', fontSize: 13, marginTop: 8, lineHeight: 18 },
  modeWarn: { color: '#fbbf24', fontSize: 13, marginTop: 8, lineHeight: 18 },
  toggle: { borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 20 },
  toggleOn: { backgroundColor: '#7f1d1d' },
  toggleOff: { backgroundColor: '#22c55e' },
  toggleText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  sectionTitle: { color: '#64748b', fontSize: 13, fontWeight: '700', letterSpacing: 1, marginBottom: 8 },
  siteRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1e293b' },
  siteName: { color: '#e2e8f0', fontSize: 15, fontWeight: '600' },
  siteMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  siteDist: { color: '#94a3b8', fontSize: 13, marginLeft: 10 },
  siteGo: { color: '#475569', fontSize: 22, marginLeft: 10, marginTop: -2 },
});
