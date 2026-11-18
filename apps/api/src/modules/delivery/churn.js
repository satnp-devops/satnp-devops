// Churn-risk scoring and upsell flags for renewals (docs/delivery/DELIVERY.md §7). Pure.
//
// Signals come from tables every company already fills in phase 2: the institute's timeline
// (calls, messages, meetings, notes), its open tasks, its lost deals and consent records, plus the
// delivery module's own implementation projects. The weights are fixed here so scores compare
// across companies; the quiet-account period and the medium/high thresholds are settings.

export const CHURN_WEIGHTS = Object.freeze({
  neverContacted: 30,
  quiet: 20,
  veryQuiet: 30,
  overdueTaskEach: 5,
  overdueTaskMax: 15,
  recentLostDeal: 15,
  implementationOverdue: 25,
  implementationOnHold: 20,
  implementationCancelled: 30,
  consentWithdrawn: 10,
  renewalUnattended: 15,
});

/**
 * @param {{
 *   daysSinceActivity: number | null, overdueTasks: number, recentLostDeals: number,
 *   implementation: { status: string, overdue: boolean } | null,
 *   consentWithdrawn: boolean, daysToRenewal: number, autoRenew: boolean, openDeals: number,
 * }} signals
 * @param {{ inactiveDays: number, mediumScore: number, highScore: number }} rules
 * @returns {{ score: number, level: 'low' | 'medium' | 'high', signals: Array<{ key: string, label: string, points: number }> }}
 */
export function scoreChurnRisk(signals, rules) {
  const w = CHURN_WEIGHTS;
  const found = [];
  const add = (key, label, points) => found.push({ key, label, points });

  if (signals.daysSinceActivity === null || signals.daysSinceActivity === undefined) {
    add('never_contacted', 'No calls, messages or meetings on record', w.neverContacted);
  } else if (signals.daysSinceActivity >= rules.inactiveDays * 2) {
    add('very_quiet', `No contact for ${signals.daysSinceActivity} days`, w.veryQuiet);
  } else if (signals.daysSinceActivity >= rules.inactiveDays) {
    add('quiet', `No contact for ${signals.daysSinceActivity} days`, w.quiet);
  }

  if (signals.overdueTasks > 0) {
    const points = Math.min(w.overdueTaskMax, signals.overdueTasks * w.overdueTaskEach);
    add('overdue_tasks', `${signals.overdueTasks} overdue ${signals.overdueTasks === 1 ? 'task' : 'tasks'}`, points);
  }
  if (signals.recentLostDeals > 0) add('lost_deal', 'Lost a deal in the last 6 months', w.recentLostDeal);

  const impl = signals.implementation;
  if (impl?.status === 'cancelled') add('implementation_cancelled', 'Implementation was cancelled', w.implementationCancelled);
  else if (impl?.status === 'on_hold') add('implementation_on_hold', 'Implementation is on hold', w.implementationOnHold);
  else if (impl && impl.status !== 'live' && impl.overdue) add('implementation_overdue', 'Go-live is overdue', w.implementationOverdue);

  if (signals.consentWithdrawn) add('consent_withdrawn', 'A contact withdrew consent to be contacted', w.consentWithdrawn);
  if (signals.daysToRenewal <= 30 && !signals.autoRenew && signals.openDeals === 0) {
    add('renewal_unattended', 'Renews within 30 days with no auto-renew and no open deal', w.renewalUnattended);
  }

  const score = Math.max(0, Math.min(100, found.reduce((sum, s) => sum + s.points, 0)));
  const level = score >= rules.highScore ? 'high' : score >= rules.mediumScore ? 'medium' : 'low';
  return { score, level, signals: found };
}

/**
 * Upsell flags: more students than licensed seats, and product lines the company sells to
 * institutes that this one hasn't bought yet.
 * @param {{ seats: number | null, studentCount: number | null, ownedLineIds: string[],
 *           offeredLines: Array<{ id: string, name: string }> }} input
 * @returns {Array<{ key: string, label: string, productLineIds?: string[] }>}
 */
export function upsellFlags({ seats, studentCount, ownedLineIds, offeredLines }) {
  const flags = [];
  if (seats && studentCount && studentCount > seats) {
    flags.push({ key: 'seats_exceeded', label: `${studentCount.toLocaleString('en-IN')} students on ${seats.toLocaleString('en-IN')} seats` });
  }
  const owned = new Set(ownedLineIds);
  const missing = offeredLines.filter((line) => !owned.has(line.id));
  if (owned.size > 0 && missing.length > 0) {
    flags.push({
      key: 'cross_sell',
      label: `Not using ${missing.map((line) => line.name).join(', ')}`,
      productLineIds: missing.map((line) => line.id),
    });
  }
  return flags;
}

/** Which reminders are due now: offsets (days before term end) reached and not yet sent for this term. Pure. */
export function dueReminders({ daysToRenewal, offsets, sent }) {
  const already = new Set(sent);
  // Only the closest reached offset is sent, so a subscription created 20 days before renewal
  // gets the 30-day reminder once, not 90, 60 and 30 together; the skipped ones count as sent.
  const reached = [...offsets].filter((days) => daysToRenewal <= days && daysToRenewal >= 0).sort((a, b) => a - b);
  if (reached.length === 0) return { send: null, markSent: [] };
  const closest = reached[0];
  if (already.has(closest)) return { send: null, markSent: reached.filter((d) => !already.has(d)) };
  return { send: closest, markSent: reached.filter((d) => !already.has(d)) };
}
