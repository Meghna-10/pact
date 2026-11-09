// Persistent store (built-in node:sqlite, no extra dependency).
//  - ledger:      append-only audit events (hash-chained in trust.js)
//  - raw_events:  every incoming PayPal / merchant event exactly as received, keyed by event_id
//                 (the primary key IS the idempotency check)
//  - state:       snapshots of agents, intents, incidents, etc.
// PACT_DB=':memory:' for tests.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const file = process.env.PACT_DB || fileURLToPath(new URL('../data/pact.db', import.meta.url));
export const db = new DatabaseSync(file);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS raw_events (
    event_id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, transaction_id TEXT,
    occurred_at TEXT, received_at TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
`);
export const dbFile = file;

export const saveState = (key, value) =>
  db.prepare('INSERT INTO state(key, json, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), new Date().toISOString());
export const loadState = key => { const r = db.prepare('SELECT json FROM state WHERE key = ?').get(key); return r ? JSON.parse(r.json) : null; };

export const appendLedger = ev => db.prepare('INSERT OR IGNORE INTO ledger(seq, json) VALUES(?, ?)').run(ev.seq, JSON.stringify(ev));
export const loadLedger = () => db.prepare('SELECT json FROM ledger ORDER BY seq').all().map(r => JSON.parse(r.json));

// Returns { inserted: false } when this event_id was already received (duplicate delivery).
export function insertRawEvent(e) {
  const r = db.prepare(`INSERT OR IGNORE INTO raw_events(event_id, source, type, transaction_id, occurred_at, received_at, verified, json)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(e.eventId, e.source, e.type, e.transactionId || null, e.occurredAt || null, new Date().toISOString(), e.verified ? 1 : 0, JSON.stringify(e.payload ?? {}));
  return { inserted: r.changes === 1 };
}
export const markApplied = id => db.prepare('UPDATE raw_events SET applied = 1 WHERE event_id = ?').run(id);
export const rawEvents = (txn, limit = 200) => (txn
  ? db.prepare('SELECT * FROM raw_events WHERE transaction_id = ? ORDER BY received_at').all(txn)
  : db.prepare('SELECT * FROM raw_events ORDER BY received_at DESC LIMIT ?').all(limit)).map(r => ({ ...r, json: JSON.parse(r.json), verified: !!r.verified, applied: !!r.applied }));

// Signing secret survives restarts so issued passports stay valid.
export function secret() {
  if (process.env.PACT_SECRET) return process.env.PACT_SECRET;
  let s = loadState('signing_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); saveState('signing_secret', s); }
  return s;
}

export function wipe() {
  const keep = loadState('signing_secret');
  db.exec('DELETE FROM state; DELETE FROM ledger; DELETE FROM raw_events;');
  if (keep) saveState('signing_secret', keep);
}
