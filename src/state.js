// Snapshot persistence for the in-memory maps + demo reset.
import * as DB from './db.js';
import * as T from './trust.js';
import { incidents } from './incidents.js';
import { simOrders } from './paypal.js';

const MAPS = { agents: T.agents, intents: T.intents, incidents, paypalSim: simOrders };

export function persistAll() {
  for (const [k, m] of Object.entries(MAPS)) DB.saveState(k, [...m.entries()]);
  DB.saveState('securityEvents', T.securityEvents);
  DB.saveState('usedNonces', [...T.usedNonces]);
}

export function restoreAll() {
  for (const [k, m] of Object.entries(MAPS)) { const rows = DB.loadState(k); if (rows) for (const [id, v] of rows) m.set(id, v); }
  T.securityEvents.push(...(DB.loadState('securityEvents') || []));
  for (const n of DB.loadState('usedNonces') || []) T.usedNonces.add(n);
  return { agents: T.agents.size, intents: T.intents.size, incidents: incidents.size, ledger: T.ledger.length };
}

export function resetAll() {
  for (const m of Object.values(MAPS)) m.clear();
  T.securityEvents.length = 0; T.ledger.length = 0; T.usedNonces.clear();
  DB.wipe();
}
