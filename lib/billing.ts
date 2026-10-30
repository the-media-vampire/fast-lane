import { db, id, json, now, tx } from "./db";
import { liveEnabled } from "./env";

/**
 * The one place money is allowed to move. Every billable call (model responses, image, video,
 * voice and music submissions, fallbacks, repairs, reviews) reserves here first and settles
 * here afterwards. Three rules hold at every boundary:
 *
 *   1. The spending gate: nothing is bought while spending is off on this server, and nothing
 *      is ever bought for the sample project.
 *   2. Authorization: money is spent only under a ceiling the person gave (an allowance for
 *      planning work, or an approved quote for production). The agent cannot create one.
 *   3. Idempotency: every ledger row carries a unique reference, so a settlement or release
 *      recorded twice is recorded once.
 */

export type SpendClass = "model" | "image" | "video" | "audio";
export const SPEND_CLASSES: SpendClass[] = ["model", "image", "video", "audio"];

export type BlockCode = "off" | "sample" | "missing" | "no-authorization" | "ceiling" | "limit";

export class SpendBlocked extends Error {
  constructor(
    message: string,
    readonly code: BlockCode,
    readonly needCents = 0,
    readonly remainingCents = 0,
  ) {
    super(message);
    this.name = "SpendBlocked";
  }
}

/* ---------------- the spending gate ---------------- */

export type Gate = { ok: true } | { ok: false; code: BlockCode; reason: string };

export function spendGate(projectId: string): Gate {
  const p = db().prepare("select sample from projects where id = ?").get(projectId) as { sample: number } | undefined;
  if (!p) return { ok: false, code: "missing", reason: "This project no longer exists." };
  if (p.sample) return { ok: false, code: "sample", reason: "This is the sample project, so nothing here is generated or billed." };
  if (!liveEnabled()) return { ok: false, code: "off", reason: "Spending is switched off on this server." };
  return { ok: true };
}

export function assertSpendable(projectId: string) {
  const g = spendGate(projectId);
  if (!g.ok) throw new SpendBlocked(g.reason, g.code);
}

/* ---------------- authorizations ---------------- */

export type AuthKind = "allowance" | "production" | "retake" | "storyboards" | "sound" | "references" | "retry";

export type AuthRow = {
  id: string;
  project_id: string;
  kind: AuthKind;
  label: string;
  covers: string;
  ceiling_cents: number;
  quote_id: string | null;
  status: "active" | "closed";
  created_by: string;
  created_at: string;
  closed_at: string | null;
};

export function authCovers(a: AuthRow): SpendClass[] {
  return json<SpendClass[]>(a.covers, []);
}

/**
 * Created only from the person's own actions: setting a planning allowance, or approving a
 * quote. No agent tool reaches this function.
 */
export function createAuthorization(projectId: string, a: { kind: AuthKind; label: string; covers: SpendClass[]; ceilingCents: number; quoteId?: string | null }): AuthRow {
  return tx(() => {
    const available = spend(projectId);
    if (a.ceilingCents > available.remainingCents) throw new SpendBlocked(`This approval needs ${money(a.ceilingCents)}, but the project limit has ${money(Math.max(0, available.remainingCents))} available. Set a higher project limit in Project information first.`, "limit", a.ceilingCents, available.remainingCents);
    const aid = id("aut");
    db()
      .prepare("insert into authorizations (id, project_id, kind, label, covers, ceiling_cents, quote_id, status, created_by, created_at) values (?, ?, ?, ?, ?, ?, ?, 'active', 'user', ?)")
      .run(aid, projectId, a.kind, a.label, JSON.stringify(a.covers), Math.max(0, Math.round(a.ceilingCents)), a.quoteId ?? null, now());
    // A quote authorizes its own scope; it never raises the project's separate hard limit.
    bumpProject(projectId);
    return getAuthorization(aid)!;
  });
}

export function getAuthorization(authId: string | null | undefined): AuthRow | null {
  if (!authId) return null;
  return (db().prepare("select * from authorizations where id = ?").get(authId) as AuthRow | undefined) ?? null;
}

export function authorizations(projectId: string, onlyActive = false): AuthRow[] {
  return db()
    .prepare(`select * from authorizations where project_id = ? ${onlyActive ? "and status = 'active'" : ""} order by created_at`)
    .all(projectId) as AuthRow[];
}

export function closeAuthorization(authId: string) {
  const a = getAuthorization(authId);
  if (!a || a.status !== "active") return;
  db().prepare("update authorizations set status = 'closed', closed_at = ? where id = ?").run(now(), authId);
  bumpProject(a.project_id);
}

/** The planning allowance, if the person set one. */
export function allowanceOf(projectId: string): AuthRow | null {
  return (db().prepare("select * from authorizations where project_id = ? and kind = 'allowance' and status = 'active' order by created_at desc limit 1").get(projectId) as AuthRow | undefined) ?? null;
}

/** Charged plus still-reserved money under one authorization. */
export function authUsage(authId: string): { spentCents: number; reservedCents: number } {
  const rows = db().prepare("select kind, coalesce(sum(cents), 0) as cents from ledger where auth_id = ? group by kind").all(authId) as { kind: string; cents: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.cents)]));
  return { spentCents: by.charge ?? 0, reservedCents: Math.max(0, (by.reserve ?? 0) - (by.release ?? 0)) };
}

export function authRemaining(a: AuthRow): number {
  const u = authUsage(a.id);
  return a.ceiling_cents - u.spentCents - u.reservedCents;
}

/**
 * Which authorization pays for this. A named one must be active and cover the class; otherwise
 * the most specific active authorization that covers the class and has room.
 */
export function chooseAuthorization(projectId: string, cls: SpendClass, cents: number, preferId?: string | null): AuthRow {
  const fits = (a: AuthRow) => a.status === "active" && authCovers(a).includes(cls);
  if (preferId) {
    const a = getAuthorization(preferId);
    if (!a || a.project_id !== projectId || !fits(a)) throw new SpendBlocked("That approval no longer covers this work. Ask for a fresh estimate.", "no-authorization", cents, 0);
    const left = authRemaining(a);
    if (cents > left) throw new SpendBlocked(`This needs about ${money(cents)}, but the approved ceiling for “${a.label}” has ${money(left)} left.`, "ceiling", cents, left);
    return a;
  }
  const candidates = authorizations(projectId, true).filter(fits);
  if (!candidates.length) {
    throw new SpendBlocked(
      cls === "video" ? "Video always needs your approval of an estimate first." : "There's no approved allowance for this yet. Set a planning allowance, or approve an estimate.",
      "no-authorization",
      cents,
      0,
    );
  }
  // Prefer the narrowest approval (a quote's own ceiling) over the general allowance.
  const ordered = [...candidates].sort((x, y) => (x.kind === "allowance" ? 1 : 0) - (y.kind === "allowance" ? 1 : 0) || y.created_at.localeCompare(x.created_at));
  for (const a of ordered) if (authRemaining(a) >= cents) return a;
  const best = Math.max(...ordered.map(authRemaining));
  throw new SpendBlocked(`This needs about ${money(cents)}, but the approved ${ordered.length === 1 && ordered[0].kind === "allowance" ? "allowance" : "ceiling"} has ${money(Math.max(0, best))} left.`, "ceiling", cents, Math.max(0, best));
}

/* ---------------- the ledger ---------------- */

export type Basis = "estimate" | "usage" | "provider" | "uncertain" | "reported";

type LedgerKind = "reserve" | "charge" | "release";

function insertLedger(row: { projectId: string; jobId?: string | null; authId?: string | null; kind: LedgerKind; cents: number; note: string; ref: string | null; basis?: Basis | null; meta?: unknown }): boolean {
  const res = db()
    .prepare("insert or ignore into ledger (id, project_id, job_id, auth_id, kind, cents, note, ref, basis, meta, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id("led"), row.projectId, row.jobId ?? null, row.authId ?? null, row.kind, Math.max(0, Math.round(row.cents)), row.note, row.ref, row.basis ?? null, row.meta === undefined ? null : JSON.stringify(row.meta), now());
  return Number(res.changes) === 1;
}

type ReserveRow = { id: string; project_id: string; job_id: string | null; auth_id: string | null; cents: number; ref: string; note: string };

function reserveRow(ref: string): ReserveRow | null {
  return (db().prepare("select id, project_id, job_id, auth_id, cents, ref, note from ledger where ref = ? and kind = 'reserve'").get(ref) as ReserveRow | undefined) ?? null;
}

/**
 * Hold money for one billable call. Checks the gate, the authorization's ceiling and the
 * project's overall limit, then records the reservation under `ref` (idempotent).
 */
export function reserve(projectId: string, r: { cls: SpendClass; cents: number; ref: string; jobId?: string | null; authId?: string | null; note: string }): { authId: string } {
  return tx(() => {
    const existing = reserveRow(r.ref);
    if (existing) return { authId: existing.auth_id ?? "" };
    assertSpendable(projectId);
    const cents = Math.max(0, Math.round(r.cents));
    const auth = chooseAuthorization(projectId, r.cls, cents, r.authId);
    const s = spend(projectId);
    if (cents > s.remainingCents) {
      throw new SpendBlocked(`This needs about ${money(cents)}, but the project's spending limit has ${money(Math.max(0, s.remainingCents))} left.`, "limit", cents, Math.max(0, s.remainingCents));
    }
    insertLedger({ projectId, jobId: r.jobId, authId: auth.id, kind: "reserve", cents, note: r.note, ref: r.ref, basis: "estimate" });
    bumpProject(projectId);
    return { authId: auth.id };
  });
}

/** Turn a reservation into a charge. Recording it twice records it once. */
export function settle(ref: string, s: { cents: number; basis: Basis; meta?: unknown; note?: string }): boolean {
  return tx(() => {
    const r = reserveRow(ref);
    if (!r) return false;
    if (db().prepare("select 1 from ledger where ref = ?").get(`${ref}:charge`)) return false;
    insertLedger({ projectId: r.project_id, jobId: r.job_id, authId: r.auth_id, kind: "release", cents: r.cents, note: `${r.note} settled`, ref: `${ref}:release` });
    const charged = insertLedger({ projectId: r.project_id, jobId: r.job_id, authId: r.auth_id, kind: "charge", cents: s.cents, note: s.note ?? r.note, ref: `${ref}:charge`, basis: s.basis, meta: s.meta });
    bumpProject(r.project_id);
    return charged;
  });
}

/** Give a reservation back (nothing was bought). Never after a charge. */
export function release(ref: string, note?: string): boolean {
  return tx(() => {
    const r = reserveRow(ref);
    if (!r) return false;
    if (db().prepare("select 1 from ledger where ref = ?").get(`${ref}:charge`)) return false;
    const done = insertLedger({ projectId: r.project_id, jobId: r.job_id, authId: r.auth_id, kind: "release", cents: r.cents, note: note ?? `${r.note} released`, ref: `${ref}:release` });
    if (done) bumpProject(r.project_id);
    return done;
  });
}

export function isOpen(ref: string): boolean {
  return !!reserveRow(ref) && !db().prepare("select 1 from ledger where ref = ?").get(`${ref}:release`);
}

/** Open model-call reservations a job left behind (a restart interrupted the call). */
export function openModelReservations(jobId: string): ReserveRow[] {
  const rows = db().prepare("select id, project_id, job_id, auth_id, cents, ref, note from ledger where job_id = ? and kind = 'reserve' and ref like 'model:%'").all(jobId) as ReserveRow[];
  return rows.filter((r) => isOpen(r.ref));
}

/**
 * A charge that happened without a reservation we can attach it to (historical usage being
 * reconciled). It is recorded with its basis and never invented.
 */
export function recordHistorical(projectId: string, h: { cents: number; ref: string; note: string; basis: Basis; meta?: unknown }): boolean {
  const done = insertLedger({ projectId, kind: "charge", cents: h.cents, note: h.note, ref: h.ref, basis: h.basis, meta: h.meta });
  if (done) bumpProject(projectId);
  return done;
}

export type Spend = {
  budgetCents: number;
  spentCents: number;
  reservedCents: number;
  remainingCents: number;
  /** Money possibly charged for requests whose outcome is unknown; kept reserved until resolved. */
  uncertainCents: number;
  /** Charges whose amount is an estimate rather than provider-reported or token usage. */
  estimatedCents: number;
  approvedCents: number;
};

export function spend(projectId: string): Spend {
  const p = db().prepare("select budget_cents from projects where id = ?").get(projectId) as { budget_cents: number } | undefined;
  const rows = db().prepare("select kind, coalesce(sum(cents), 0) as cents from ledger where project_id = ? group by kind").all(projectId) as { kind: string; cents: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.cents)]));
  const spent = by.charge ?? 0;
  const reserved = Math.max(0, (by.reserve ?? 0) - (by.release ?? 0));
  const uncertain = (
    db()
      .prepare(
        `select coalesce(sum(l.cents), 0) as cents from ledger l join jobs j on j.id = l.job_id
         where l.project_id = ? and l.kind = 'reserve' and j.status = 'ambiguous'
           and not exists (select 1 from ledger r where r.ref = l.ref || ':release')`,
      )
      .get(projectId) as { cents: number }
  ).cents;
  const estimated = (db().prepare("select coalesce(sum(cents), 0) as cents from ledger where project_id = ? and kind = 'charge' and basis in ('estimate', 'uncertain', 'reported')").get(projectId) as { cents: number }).cents;
  const approved = (db().prepare("select coalesce(sum(ceiling_cents), 0) as cents from authorizations where project_id = ?").get(projectId) as { cents: number }).cents;
  const budget = p?.budget_cents ?? 0;
  return { budgetCents: budget, spentCents: spent, reservedCents: reserved, remainingCents: budget - spent - reserved, uncertainCents: Number(uncertain), estimatedCents: Number(estimated), approvedCents: Number(approved) };
}

export type LedgerLine = { at: string; kind: string; cents: number; note: string; basis: string | null; authId: string | null; jobId: string | null; meta: Record<string, unknown> | null };

export function ledgerLines(projectId: string, limit = 400): LedgerLine[] {
  const rows = db().prepare("select * from ledger where project_id = ? and kind = 'charge' order by created_at desc limit ?").all(projectId, limit) as { created_at: string; kind: string; cents: number; note: string; basis: string | null; auth_id: string | null; job_id: string | null; meta: string | null }[];
  return rows.map((r) => ({ at: r.created_at, kind: r.kind, cents: r.cents, note: r.note, basis: r.basis, authId: r.auth_id, jobId: r.job_id, meta: r.meta ? json<Record<string, unknown>>(r.meta, {}) : null }));
}

/* ---------------- helpers ---------------- */

export function money(cents: number) {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function bumpProject(projectId: string) {
  db().prepare("update projects set rev = rev + 1 where id = ?").run(projectId);
}
