// Stay-timer logic — pure, unit-testable.
// Given an entry time and a site's terms, computes the deadline and the
// schedule of reminders ("leave in 15 min", "grace period started", etc.).

const MIN = 60 * 1000;

/**
 * Compute the parking session plan for a site entered at entryAt (ms epoch).
 *
 * Site types:
 *  - free-max-stay : free for maxStayMinutes, then a charge. Deadline = entry + maxStay
 *                    (+ grace as hard limit). We alert BEFORE maxStay expires.
 *  - pay-and-display : user must buy time on arrival; we can't know how much,
 *                    so we prompt on entry and let the user log their expiry.
 *  - pay-on-exit   : no leave deadline; remind to PAY before/at exit.
 *  - customer-only : no timed limit known; warn on entry only.
 */
export function planSession(site, entryAt, opts = {}) {
  const alertLead = (opts.alertLeadMinutes ?? 15) * MIN;
  const grace = (site.gracePeriodMinutes ?? opts.gracePeriodMinutes ?? 10) * MIN;
  const plan = {
    siteId: site.id,
    entryAt,
    siteType: site.siteType,
    deadlineAt: null,      // when free/paid time runs out
    hardLimitAt: null,     // deadline + grace: after this a PCN is likely
    reminders: [],         // [{at, kind, message}]
  };

  const push = (at, kind, message) => {
    if (at >= entryAt) plan.reminders.push({ at, kind, message });
  };

  if (site.siteType === 'free-max-stay' && site.maxStayMinutes) {
    const deadline = entryAt + site.maxStayMinutes * MIN;
    plan.deadlineAt = deadline;
    plan.hardLimitAt = deadline + grace;
    push(entryAt, 'entry',
      `Entered ${site.name} (${site.operatorName || 'private operator'}). ` +
      `Free stay: ${formatMins(site.maxStayMinutes)} — leave by ${fmtTime(deadline)}.`);
    push(deadline - alertLead, 'pre-deadline',
      `${formatMins(alertLead / MIN)} left at ${site.name}. Leave by ${fmtTime(deadline)} to avoid a parking charge.`);
    push(deadline, 'deadline',
      `Max stay reached at ${site.name}. Grace period (~${grace / MIN} min) — leave NOW.`);
    push(plan.hardLimitAt, 'overstay',
      `Grace period over at ${site.name}. A Parking Charge Notice is now likely.`);
  } else if (site.siteType === 'pay-and-display') {
    push(entryAt, 'entry',
      `Entered ${site.name} — PAY AND DISPLAY site (${site.operatorName || 'private operator'}). ` +
      `Buy a ticket, then log your expiry time in ParkMate for a reminder.`);
  } else if (site.siteType === 'pay-on-exit') {
    push(entryAt, 'entry',
      `Entered ${site.name} — ANPR pay-on-exit. Remember to pay before you leave ` +
      `(or within the operator's payment window).`);
  } else {
    push(entryAt, 'entry',
      `Entered ${site.name} — privately enforced car park (${site.operatorName || 'operator unknown'}). Check the signage terms.`);
  }
  return plan;
}

/** For pay-and-display: user logged the expiry they bought. */
export function planPaidExpiry(site, paidUntilAt, opts = {}) {
  const alertLead = (opts.alertLeadMinutes ?? 15) * MIN;
  const grace = (site.gracePeriodMinutes ?? opts.gracePeriodMinutes ?? 10) * MIN;
  const reminders = [];
  const push = (at, kind, message) => reminders.push({ at, kind, message });
  push(paidUntilAt - alertLead, 'pre-deadline',
    `Your ticket at ${site.name} expires at ${fmtTime(paidUntilAt)} — ${formatMins(alertLead / MIN)} left. Top up or head back.`);
  push(paidUntilAt, 'deadline',
    `Ticket expired at ${site.name}. ~${grace / MIN} min grace period — move now.`);
  push(paidUntilAt + grace, 'overstay',
    `Grace period over at ${site.name}. A Parking Charge Notice is now likely.`);
  return { siteId: site.id, deadlineAt: paidUntilAt, hardLimitAt: paidUntilAt + grace, reminders };
}

export function cancelOnExit(plan, exitAt) {
  // On confirmed exit, all future reminders are void.
  return { ...plan, reminders: plan.reminders.filter((r) => r.at <= exitAt), exitedAt: exitAt };
}

export function formatMins(mins) {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
