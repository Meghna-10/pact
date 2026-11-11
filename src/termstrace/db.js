// SQLite persistence (built-in node:sqlite). TT_DB=':memory:' for tests.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const file = process.env.TT_DB || fileURLToPath(new URL('../../data/termstrace.db', import.meta.url));
if (file !== ':memory:') fs.mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
export const db = new DatabaseSync(file);
export const dbFile = file;

// Migrations: the schema file is idempotent (CREATE ... IF NOT EXISTS); version 1 is recorded once.
db.exec(fs.readFileSync(new URL('../../db/termstrace-schema.sql', import.meta.url), 'utf8'));
if (!db.prepare('SELECT 1 FROM schema_version WHERE version = 1').get()) db.prepare('INSERT INTO schema_version VALUES (1, ?)').run(new Date().toISOString());

export const saveAgreement = a => db.prepare(`INSERT INTO agreements(id, created_at, updated_at, status, doc_sha256, json) VALUES(?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status, json = excluded.json`)
  .run(a.id, a.createdAt, new Date().toISOString(), a.status, a.document.sha256, JSON.stringify(a));
export const loadAgreement = id => { const r = db.prepare('SELECT json FROM agreements WHERE id = ?').get(id); return r ? JSON.parse(r.json) : null; };
export const allAgreements = () => db.prepare('SELECT json FROM agreements ORDER BY created_at DESC').all().map(r => JSON.parse(r.json));

// Returns { inserted:false } for a redelivered event id.
export function insertRawEvent(e) {
  const r = db.prepare(`INSERT OR IGNORE INTO raw_events(event_id, source, type, ref, agreement_id, verified, received_at, json) VALUES(?,?,?,?,?,?,?,?)`)
    .run(e.eventId, e.source, e.type, e.ref || null, e.agreementId || null, e.verified ? 1 : 0, new Date().toISOString(), JSON.stringify(e.payload ?? {}));
  return { inserted: r.changes === 1 };
}
export const markApplied = id => db.prepare('UPDATE raw_events SET applied = 1 WHERE event_id = ?').run(id);
export const rawEvents = (limit = 100) => db.prepare('SELECT * FROM raw_events ORDER BY received_at DESC LIMIT ?').all(limit).map(r => ({ ...r, verified: !!r.verified, applied: !!r.applied, json: JSON.parse(r.json) }));

// Tamper-evident ledger: hash = sha256(prev_hash + entry).
export function appendLedger(agreementId, type, source, data) {
  const prev = db.prepare('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1').get()?.hash || 'GENESIS';
  const at = new Date().toISOString(), body = JSON.stringify(data ?? {});
  const hash = crypto.createHash('sha256').update(prev + at + agreementId + type + source + body).digest('hex');
  db.prepare('INSERT INTO ledger(at, agreement_id, type, source, data, prev_hash, hash) VALUES(?,?,?,?,?,?,?)').run(at, agreementId, type, source, body, prev, hash);
  return { at, type, source, data, hash };
}
export const ledgerFor = id => db.prepare('SELECT * FROM ledger WHERE agreement_id = ? ORDER BY seq').all(id).map(r => ({ ...r, data: JSON.parse(r.data) }));
export function verifyLedger() {
  let prev = 'GENESIS', n = 0;
  for (const r of db.prepare('SELECT * FROM ledger ORDER BY seq').all()) {
    const h = crypto.createHash('sha256').update(prev + r.at + r.agreement_id + r.type + r.source + r.data).digest('hex');
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, brokenAt: r.seq, entries: n };
    prev = r.hash; n++;
  }
  return { ok: true, entries: n };
}
export const kvGet = k => { const r = db.prepare('SELECT json FROM kv WHERE key = ?').get(k); return r ? JSON.parse(r.json) : null; };
export const kvSet = (k, v) => db.prepare('INSERT INTO kv(key, json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(k, JSON.stringify(v));
export function counts() {
  return Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM agreements GROUP BY status').all().map(r => [r.status, r.n]));
}
