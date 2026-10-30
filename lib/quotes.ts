import { db, id, json, now, tx } from "./db";
import type { SpendClass, AuthKind } from "./billing";

/**
 * Priced offers. A paid action asked for by the person or by Astra becomes a quote: the scope,
 * the estimate and a ceiling that includes the retry allowance, bound to the exact inputs it
 * was priced from. Only the person's confirmation endpoint can accept one, it can be accepted
 * once, and a quote whose inputs have changed is replaced by a fresh one instead of buying.
 */

export type QuoteLine = { label: string; cents: number };
export type QuoteDetail = {
  /** What will be made, in plain words. */
  scope: string[];
  /** Price lines that add up to the estimate. */
  lines: QuoteLine[];
  /** The retry allowance on top of the estimate. */
  retryCents: number;
  notes: string[];
  covers: SpendClass[];
  authKind: AuthKind;
};

export type QuoteRow = {
  id: string;
  project_id: string;
  op: string;
  input: string;
  fingerprint: string;
  cents: number;
  ceiling_cents: number;
  label: string;
  detail: string;
  status: "open" | "approved" | "stale" | "expired" | "declined";
  created_by: "user" | "agent";
  auth_id: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
};

export type QuoteView = { id: string; op: string; cents: number; ceilingCents: number; label: string; detail: QuoteDetail; status: QuoteRow["status"]; createdBy: string; createdAt: string; expiresAt: string };

const MINUTES = 30;

export function createQuote(projectId: string, q: { op: string; input: Record<string, unknown>; fingerprint: string; cents: number; ceilingCents: number; label: string; detail: QuoteDetail; createdBy: "user" | "agent" }): QuoteRow {
  return tx(() => {
    // One open offer per action and input: a fresh price replaces the old one.
    const inputJson = JSON.stringify(q.input);
    db().prepare("update quotes set status = 'stale', decided_at = ? where project_id = ? and op = ? and input = ? and status = 'open'").run(now(), projectId, q.op, inputJson);
    const qid = id("quo");
    const t = new Date();
    db()
      .prepare(
        `insert into quotes (id, project_id, op, input, fingerprint, cents, ceiling_cents, label, detail, status, created_by, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
      .run(qid, projectId, q.op, inputJson, q.fingerprint, Math.round(q.cents), Math.round(q.ceilingCents), q.label, JSON.stringify(q.detail), q.createdBy, t.toISOString(), new Date(t.getTime() + MINUTES * 60_000).toISOString());
    db().prepare("update projects set rev = rev + 1 where id = ?").run(projectId);
    return getQuote(qid)!;
  });
}

export function getQuote(quoteId: string | null | undefined): QuoteRow | null {
  if (!quoteId) return null;
  return (db().prepare("select * from quotes where id = ?").get(quoteId) as QuoteRow | undefined) ?? null;
}

export function openQuotes(projectId: string): QuoteRow[] {
  expireQuotes(projectId);
  return db().prepare("select * from quotes where project_id = ? and status = 'open' order by created_at desc").all(projectId) as QuoteRow[];
}

export function expireQuotes(projectId: string) {
  db().prepare("update quotes set status = 'expired', decided_at = ? where project_id = ? and status = 'open' and expires_at < ?").run(now(), projectId, now());
}

/** Single use: only one caller can move an open quote to approved. */
export function takeQuote(quoteId: string, authId: string): boolean {
  const res = db().prepare("update quotes set status = 'approved', auth_id = ?, decided_at = ? where id = ? and status = 'open' and expires_at >= ?").run(authId, now(), quoteId, now());
  return Number(res.changes) === 1;
}

export function markQuote(quoteId: string, status: "stale" | "declined" | "expired") {
  const q = getQuote(quoteId);
  db().prepare("update quotes set status = ?, decided_at = ? where id = ? and status = 'open'").run(status, now(), quoteId);
  if (q) db().prepare("update projects set rev = rev + 1 where id = ?").run(q.project_id);
}

export function quoteView(q: QuoteRow): QuoteView {
  return { id: q.id, op: q.op, cents: q.cents, ceilingCents: q.ceiling_cents, label: q.label, detail: json<QuoteDetail>(q.detail, { scope: [], lines: [], retryCents: 0, notes: [], covers: [], authKind: "retry" }), status: q.status, createdBy: q.created_by, createdAt: q.created_at, expiresAt: q.expires_at };
}
