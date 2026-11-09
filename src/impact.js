// Impact dashboard: only counts what PACT actually observed. No "money saved" claims.
import { intents } from './trust.js';
import * as A from './assurance.js';
import { incidents, stage } from './incidents.js';
import { stats } from './events.js';

export function impact() {
  const paid = [...intents.values()].filter(i => i.payment);
  const chains = paid.map(i => A.chain(i.id));
  const inc = [...incidents.values()];
  const resolved = inc.filter(i => i.status === 'resolved' && i.resolution);
  const ttr = resolved.map(i => new Date(i.resolution.at) - new Date(i.createdAt));
  const byStatus = {};
  for (const c of chains) byStatus[c.txnStatus] = (byStatus[c.txnStatus] || 0) + 1;
  const refunds = A.refundTracker();
  return {
    transactions: { total: paid.length, byStatus, human: chains.filter(c => c.initiator === 'human buyer').length, agent: chains.filter(c => c.initiator === 'AI agent').length,
      avgHealth: chains.length ? Math.round(chains.reduce((s, c) => s + c.health, 0) / chains.length) : null },
    reconciliationDiscrepancies: chains.reduce((s, c) => s + c.reconciliation.mismatches.length, 0),
    duplicateCapturesDetected: inc.filter(i => i.kind === 'duplicate_capture').length,
    duplicateDeliveriesIgnored: stats.duplicates,
    refundsAwaiting: refunds.filter(r => r.state === 'awaiting').length,
    refundsOverdue: refunds.filter(r => r.state === 'overdue').length,
    incidents: { total: inc.length, open: inc.filter(i => i.status === 'open').length, underReview: inc.filter(i => i.status === 'under_review').length, resolved: resolved.length,
      byStage: inc.reduce((m, i) => ((m[stage(i)] = (m[stage(i)] || 0) + 1), m), {}) },
    avgTimeToResolutionMin: ttr.length ? Math.round(ttr.reduce((a, b) => a + b, 0) / ttr.length / 600) / 100 : null,
    evidenceCompletenessAvg: chains.length ? Math.round(chains.reduce((s, c) => s + c.evidence.score, 0) / chains.length) : null,
    events: { ...stats },
    note: 'Counts of what PACT observed in this environment. Demo data resolves in seconds, so time-to-resolution here is not a real-world benchmark. No money-saved figures without a measured baseline.',
  };
}
