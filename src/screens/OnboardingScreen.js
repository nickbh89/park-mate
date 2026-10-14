// Short first-run walkthrough. Also reachable from Settings > How ParkMate works.
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

const STEPS = [
  {
    title: 'Start detection',
    body: 'Tap "Start detection" on the home screen and choose "Allow all the time" when Android asks about location. ParkMate then keeps watching for privately enforced car parks in the background, even with the app closed.',
  },
  {
    title: 'Park as normal',
    body: 'When you stop in a car park we know about, you get an alert straight away. If we know the time limit a countdown starts. If we do not, tap the limit shown on the sign and ParkMate counts down from when you arrived.',
  },
  {
    title: 'Get a warning in time',
    body: 'You get a notification before your time runs out. Choose how early in Settings: 10, 15, 20 or 30 minutes.',
  },
  {
    title: 'Always check the signs',
    body: 'Site data is community-maintained and can be out of date. The signage at each car park is the binding record of its terms.',
  },
];

export default function OnboardingScreen({ onDone }) {
  const [step, setStep] = React.useState(0);
  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.skip} onPress={onDone}>
        <Text style={styles.skipText}>{last ? '' : 'Skip'}</Text>
      </TouchableOpacity>

      <View style={styles.body}>
        <Text style={styles.count}>{step + 1} of {STEPS.length}</Text>
        <Text style={styles.title}>{current.title}</Text>
        <Text style={styles.text}>{current.body}</Text>
      </View>

      <View style={styles.dots}>
        {STEPS.map((_, i) => (
          <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
        ))}
      </View>

      <TouchableOpacity style={styles.next} onPress={() => (last ? onDone() : setStep(step + 1))}>
        <Text style={styles.nextText}>{last ? 'Got it' : 'Next'}</Text>
      </TouchableOpacity>
      {step > 0 ? (
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep(step - 1)}>
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.backBtn}><Text style={styles.backText}> </Text></View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0e1726', padding: 24, paddingTop: 60 },
  skip: { alignSelf: 'flex-end', padding: 8 },
  skipText: { color: '#94a3b8', fontSize: 15 },
  body: { flex: 1, justifyContent: 'center' },
  count: { color: '#22c55e', fontSize: 13, fontWeight: '700', letterSpacing: 1, marginBottom: 10 },
  title: { color: '#fff', fontSize: 28, fontWeight: '800', marginBottom: 14 },
  text: { color: '#cbd5e1', fontSize: 17, lineHeight: 26 },
  dots: { flexDirection: 'row', justifyContent: 'center', marginBottom: 20 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#1e293b', marginHorizontal: 4 },
  dotActive: { backgroundColor: '#22c55e' },
  next: { backgroundColor: '#22c55e', borderRadius: 12, padding: 16, alignItems: 'center' },
  nextText: { color: '#052e16', fontWeight: '700', fontSize: 16 },
  backBtn: { padding: 14, alignItems: 'center' },
  backText: { color: '#94a3b8', fontSize: 15 },
});
