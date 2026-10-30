import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Durable project state. SQLite (node:sqlite) in WAL mode so the web server and the
 * standalone worker can share one file. Chat lives in `messages`; everything the
 * studio produces lives in the other tables and is only changed through domain ops.
 */

export const DATA_DIR = process.env.FASTLANE_DATA_DIR ?? path.join(process.cwd(), "data");
export const MEDIA_DIR = path.join(DATA_DIR, "media");

const SCHEMA = `
create table if not exists projects (
  id text primary key,
  title text not null,
  kind text not null,                -- commercial | film
  duration integer not null,         -- seconds, 30..120
  aspect text not null,              -- 16:9 | 9:16
  sample integer not null default 0, -- 1 = illustrative sample content, never live
  autopilot integer not null default 0,
  budget_cents integer not null default 1500,
  stage text not null default 'brief',
  rev integer not null default 0,    -- bumped on every write; clients poll it
  created_at text not null,
  updated_at text not null
);

create table if not exists docs (
  id text primary key,
  project_id text not null,
  kind text not null,                -- brief | concepts | plan | shots
  version integer not null,
  data text not null,
  inputs text not null default '{}', -- {kind: version} this output was made from
  author text not null,              -- user | agent | system
  note text,
  created_at text not null,
  unique(project_id, kind, version)
);

create table if not exists assets (
  id text primary key,
  project_id text not null,
  kind text not null,                -- character | location | prop
  name text not null,
  data text not null,                -- description, look, role
  kept_version_id text,              -- "keep this look": the identity every shot uses
  position integer not null default 0,
  archived integer not null default 0,
  created_at text not null
);

create table if not exists asset_versions (
  id text primary key,
  asset_id text not null,
  project_id text not null,
  version integer not null,
  media_id text,
  prompt text,
  source text not null,              -- generated | upload | sample
  job_id text,
  status text not null,              -- pending | ready | failed
  created_at text not null
);

create table if not exists scenes (
  id text primary key,
  project_id text not null,
  shot_id text not null,
  rev integer not null,
  data text not null,                -- blocking scene (lib/blocking/types.ts)
  author text not null,
  note text,
  created_at text not null,
  unique(project_id, shot_id, rev)
);

create table if not exists frames (
  id text primary key,
  project_id text not null,
  shot_id text not null,
  kind text not null,                -- capture (grey camera view) | overhead | storyboard
  media_id text,
  job_id text,
  status text not null,
  inputs text not null,              -- {shotRev, sceneRev, assets:{id:versionId}, captureId}
  created_at text not null
);

create table if not exists takes (
  id text primary key,
  project_id text not null,
  shot_id text not null,
  job_id text,
  media_id text,
  inputs text not null,
  inputs_hash text not null,
  status text not null,              -- pending | ready | failed
  verdict text not null default 'none', -- none | accepted | rejected
  review text,
  attempt integer not null default 1,
  created_at text not null
);

create table if not exists audio (
  id text primary key,
  project_id text not null,
  kind text not null,                -- voice | music
  line_key text not null,            -- plan line id, or 'bed'
  text_hash text not null,
  media_id text,
  job_id text,
  status text not null,
  data text not null default '{}',   -- word timings, voice id, duration
  created_at text not null
);

create table if not exists cuts (
  id text primary key,
  project_id text not null,
  version integer not null,
  manifest text not null,
  media_id text,
  job_id text,
  status text not null,              -- pending | ready | failed
  accepted integer not null default 0,
  review text,
  note text,
  created_at text not null
);

create table if not exists media (
  id text primary key,
  project_id text not null,
  kind text not null,                -- image | video | audio
  path text not null,                -- relative to MEDIA_DIR
  mime text not null,
  width integer,
  height integer,
  duration real,
  provenance text not null,          -- sample | live | upload | blocking | assembled
  public_url text,
  public_expires_at text,
  meta text not null default '{}',
  created_at text not null
);

create table if not exists jobs (
  id text primary key,
  project_id text not null,
  kind text not null,
  idem_key text not null unique,     -- hash of everything that determines the output
  status text not null,              -- queued | submitting | submitted | succeeded | failed | ambiguous | cancelled
  provider text,
  provider_task_id text,
  input text not null,
  output text,
  error text,
  attempts integer not null default 0,
  est_cents integer not null default 0,
  actual_cents integer,
  next_run_at text,
  started_at text,
  finished_at text,
  created_at text not null,
  updated_at text not null
);

create table if not exists ledger (
  id text primary key,
  project_id text not null,
  job_id text,
  kind text not null,                -- reserve | charge | release
  cents integer not null,
  note text,
  created_at text not null
);

create table if not exists messages (
  id text primary key,
  project_id text not null,
  role text not null,                -- user | agent | system
  content text not null,             -- {text, choices?, results?, stage?}
  created_at text not null
);

-- Permission to spend, given by the person: a ceiling for one kind of work.
create table if not exists authorizations (
  id text primary key,
  project_id text not null,
  kind text not null,                -- allowance | production | retake | storyboards | sound | references | retry
  label text not null,
  covers text not null,              -- JSON array of spend classes: model | image | video | audio
  ceiling_cents integer not null,
  quote_id text,
  status text not null,              -- active | closed
  created_by text not null,          -- always 'user'
  created_at text not null,
  closed_at text
);

-- A priced offer the person can accept once. Bound to the inputs it was priced from.
create table if not exists quotes (
  id text primary key,
  project_id text not null,
  op text not null,
  input text not null,
  fingerprint text not null,
  cents integer not null,            -- the estimate
  ceiling_cents integer not null,    -- estimate plus the retry allowance
  label text not null,
  detail text not null default '{}', -- scope lines for the confirmation card
  status text not null,              -- open | approved | stale | expired | declined
  created_by text not null,          -- user | agent (who asked for the price)
  auth_id text,
  created_at text not null,
  expires_at text not null,
  decided_at text
);

-- Creative sign-offs: the sequence, an asset's primary image, an animatic, the final cut.
create table if not exists approvals (
  id text primary key,
  project_id text not null,
  kind text not null,                -- sequence | asset | animatic | final
  target text,
  fingerprint text not null,
  reviewer text,
  note text,
  created_at text not null
);

create index if not exists docs_kind on docs(project_id, kind, version);
create index if not exists scenes_shot on scenes(project_id, shot_id, rev);
create index if not exists takes_shot on takes(project_id, shot_id);
create index if not exists jobs_status on jobs(status, next_run_at);
create index if not exists messages_project on messages(project_id, created_at);
create index if not exists ledger_project on ledger(project_id, kind);
create index if not exists auth_project on authorizations(project_id, status);
create index if not exists quotes_project on quotes(project_id, status);
create index if not exists approvals_project on approvals(project_id, kind, created_at);
`;

/** Additive columns for databases created before they existed. */
const MIGRATIONS = [
  // What the studio is driving toward between checkpoints: {concepts, develop, produce}.
  "alter table projects add column pipeline text not null default '{}'",
  // The named creative reviewer (simple project information, no accounts).
  "alter table projects add column reviewer text",
  // Jobs: the authorization they spend under, a polling lease, a dispatch hold, and the purchase attempt number.
  "alter table jobs add column auth_id text",
  "alter table jobs add column lease_owner text",
  "alter table jobs add column lease_until text",
  "alter table jobs add column hold text",
  "alter table jobs add column charge_seq integer not null default 1",
  // Ledger: an idempotency reference, the authorization, how the amount is known, and provenance.
  "alter table ledger add column ref text",
  "alter table ledger add column auth_id text",
  "alter table ledger add column basis text",
  "alter table ledger add column meta text",
  "create unique index if not exists ledger_ref on ledger(ref) where ref is not null",
  // Cuts: what kind of sign-off a version received.
  "alter table cuts add column acceptance text",
  "alter table cuts add column accepted_by text",
  "alter table cuts add column accepted_at text",
  // Assets: the version a person approved (distinct from the version shots currently use).
  "alter table assets add column approved_version_id text",
  // Asset versions: a short label (Portrait, Full body, Profile, Outfit…), the request note, and its role.
  "alter table asset_versions add column label text",
  "alter table asset_versions add column note text",
  "alter table asset_versions add column role text",
  // Frames: the direction a redraw was given, and its drift check.
  "alter table frames add column note text",
  "alter table frames add column meta text",
  // Takes: generated or supplied by the person.
  "alter table takes add column source text not null default 'generated'",
];

type Global = typeof globalThis & { __fastLaneDb?: DatabaseSync };

export function db(): DatabaseSync {
  const g = globalThis as Global;
  if (g.__fastLaneDb) return g.__fastLaneDb;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const conn = new DatabaseSync(path.join(DATA_DIR, "fastlane.db"));
  conn.exec("pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
  conn.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      conn.exec(sql);
    } catch {
      // Column already present.
    }
  }
  g.__fastLaneDb = conn;
  return conn;
}

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Run fn inside one write transaction. node:sqlite has no helper, so do it by hand. Nested
 * calls become savepoints, so a helper that needs atomicity can be used inside a larger one.
 */
let depth = 0;
export function tx<T>(fn: () => T): T {
  const conn = db();
  const name = `sp_${depth}`;
  conn.exec(depth === 0 ? "begin immediate" : `savepoint ${name}`);
  depth++;
  try {
    const out = fn();
    depth--;
    conn.exec(depth === 0 ? "commit" : `release ${name}`);
    return out;
  } catch (err) {
    depth--;
    conn.exec(depth === 0 ? "rollback" : `rollback to ${name}; release ${name}`);
    throw err;
  }
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
