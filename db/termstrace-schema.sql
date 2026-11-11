-- TermsTrace schema (SQLite). Applied by src/db.js; each migration runs once (schema_version).

-- migration 1
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

-- One row per captured agreement. The document text, extracted fields, confirmed terms,
-- PayPal links, observations and comparisons live in `json` (an append-mostly document).
CREATE TABLE IF NOT EXISTS agreements (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  status      TEXT NOT NULL,          -- draft | confirmed | match | mismatch | needs_review
  doc_sha256  TEXT NOT NULL,
  json        TEXT NOT NULL
);

-- Every incoming billing event exactly as received. event_id is the idempotency key:
-- a redelivered webhook hits the primary key and is ignored.
CREATE TABLE IF NOT EXISTS raw_events (
  event_id     TEXT PRIMARY KEY,
  source       TEXT NOT NULL,          -- paypal | test-fixture
  type         TEXT NOT NULL,
  ref          TEXT,                   -- plan or subscription id
  agreement_id TEXT,
  verified     INTEGER NOT NULL DEFAULT 0,
  applied      INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL,
  json         TEXT NOT NULL
);

-- Append-only evidence ledger. Each entry stores the SHA-256 of the previous one (tamper-evident).
CREATE TABLE IF NOT EXISTS ledger (
  seq          INTEGER PRIMARY KEY,
  at           TEXT NOT NULL,
  agreement_id TEXT NOT NULL,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  data         TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_agreement ON ledger(agreement_id);

-- Small key/value store (demo sandbox plan ids).
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
