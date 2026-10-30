import crypto from "node:crypto";
import { db, id, now, json, tx } from "./db";
import { release, reserve, settle, SpendBlocked, type Basis, type SpendClass } from "./billing";

/**
 * Durable jobs. A job is keyed by its project and a hash of everything that determines its
 * output, so asking twice for the same picture or clip inside one project returns the first
 * job instead of buying it again; another project never receives it.
 *
 * Money: a billable job reserves under an authorization when it is queued and settles exactly
 * once (terminal transitions are conditional and ledger rows carry unique references).
 * Paid submissions are two-phase: the row is marked `submitting` before the provider call and
 * the provider task id is persisted before any polling. A process that dies mid-call leaves
 * `submitting`, which the worker turns into `ambiguous`: its reservation stays held until a
 * person resolves it, and it is never bought again automatically.
 */

export type JobStatus = "queued" | "submitting" | "submitted" | "running" | "succeeded" | "failed" | "ambiguous" | "cancelled";

export type JobRow = {
  id: string;
  project_id: string;
  kind: string;
  idem_key: string;
  status: JobStatus;
  provider: string | null;
  provider_task_id: string | null;
  input: string;
  output: string | null;
  error: string | null;
  attempts: number;
  est_cents: number;
  actual_cents: number | null;
  next_run_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  auth_id: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  hold: string | null;
  charge_seq: number;
};

/** Kept for callers that only care about "this can't be bought right now". */
export { SpendBlocked as BudgetError };

export function hashKey(parts: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(parts)).digest("hex").slice(0, 32);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** The deduplication key: always scoped to one project. */
export function jobKey(projectId: string, kind: string, key: unknown, attempt = 1): string {
  return hashKey({ project: projectId, kind, key, attempt });
}

/** What a job kind spends money on (null: free, local work). */
export function spendClassOf(kind: string): SpendClass | null {
  if (kind.startsWith("think.") || kind.startsWith("review.")) return "model";
  if (kind.startsWith("image.")) return "image";
  if (kind === "video.clip") return "video";
  if (kind.startsWith("audio.")) return "audio";
  return null;
}

export function getJob(jobId: string | null | undefined): JobRow | null {
  if (!jobId) return null;
  return (db().prepare("select * from jobs where id = ?").get(jobId) as JobRow | undefined) ?? null;
}

export function jobInput<T>(job: JobRow): T {
  return json<T>(job.input, {} as T);
}

export function jobOutput<T>(job: JobRow): T | null {
  return job.output ? json<T>(job.output, null as T) : null;
}

/** The ledger reference of a job's current purchase attempt. */
export function jobRef(job: Pick<JobRow, "id" | "charge_seq">): string {
  return `job:${job.id}:${job.charge_seq ?? 1}`;
}

export { spend, type Spend } from "./billing";

/* ---------- enqueue ---------- */

export type Enqueue = {
  projectId: string;
  kind: string;
  /** Everything that determines the output. Same project + key → same job, no second purchase. */
  key: unknown;
  input: unknown;
  /** The reservation for a billable job. Model jobs reserve per call instead (pass 0). */
  estCents: number;
  provider?: string;
  /** Explicit re-try of a failed or rejected output: makes a new key. */
  attempt?: number;
  /** The authorization to spend under (a production run, a retake). Defaults to one that covers it. */
  authId?: string | null;
};

export function enqueue(e: Enqueue): { job: JobRow; reused: boolean } {
  const idem = jobKey(e.projectId, e.kind, e.key, e.attempt ?? 1);
  const cls = spendClassOf(e.kind);
  return tx(() => {
    const existing = db().prepare("select * from jobs where idem_key = ?").get(idem) as JobRow | undefined;
    if (existing && existing.project_id !== e.projectId) throw new Error("Job key collision across projects.");
    if (existing && existing.status !== "failed" && existing.status !== "cancelled") return { job: existing, reused: true };
    if (existing) {
      // The same inputs failed before: buying again is a new purchase attempt with its own reservation.
      const seq = (existing.charge_seq ?? 1) + 1;
      let authId: string | null = e.authId ?? null;
      if (e.estCents > 0 && cls) authId = reserve(e.projectId, { cls, cents: e.estCents, ref: `job:${existing.id}:${seq}`, jobId: existing.id, authId: e.authId, note: `${e.kind} retry` }).authId;
      db()
        .prepare("update jobs set status = 'queued', error = null, output = null, provider_task_id = null, est_cents = ?, charge_seq = ?, auth_id = ?, hold = null, lease_owner = null, lease_until = null, next_run_at = ?, updated_at = ? where id = ?")
        .run(e.estCents, seq, authId, now(), now(), existing.id);
      return { job: getJob(existing.id)!, reused: false };
    }
    const jobId = id("job");
    const t = now();
    db()
      .prepare(
        `insert into jobs (id, project_id, kind, idem_key, status, provider, input, est_cents, next_run_at, created_at, updated_at, auth_id, charge_seq)
         values (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(jobId, e.projectId, e.kind, idem, e.provider ?? null, JSON.stringify(e.input), e.estCents, t, t, t, e.authId ?? null);
    if (e.estCents > 0 && cls) {
      const { authId } = reserve(e.projectId, { cls, cents: e.estCents, ref: `job:${jobId}:1`, jobId, authId: e.authId, note: e.kind });
      db().prepare("update jobs set auth_id = ? where id = ?").run(authId, jobId);
    }
    return { job: getJob(jobId)!, reused: false };
  });
}

/* ---------- state transitions (used by the worker) ---------- */

const LIVE = "('queued', 'submitting', 'submitted', 'running', 'ambiguous')";

export function claim(jobId: string, from: JobStatus[], to: JobStatus): boolean {
  const placeholders = from.map(() => "?").join(",");
  const res = db()
    .prepare(`update jobs set status = ?, hold = null, attempts = attempts + 1, started_at = coalesce(started_at, ?), updated_at = ? where id = ? and status in (${placeholders})`)
    .run(to, now(), now(), jobId, ...from);
  return Number(res.changes) === 1;
}

export function markSubmitted(jobId: string, provider: string, taskId: string) {
  db()
    .prepare("update jobs set status = 'submitted', provider = ?, provider_task_id = ?, lease_owner = null, lease_until = null, next_run_at = ?, updated_at = ? where id = ? and status in ('submitting', 'running', 'submitted')")
    .run(provider, taskId, inSeconds(8), now(), jobId);
}

export function reschedule(jobId: string, seconds: number) {
  db().prepare("update jobs set next_run_at = ?, updated_at = ? where id = ?").run(inSeconds(seconds), now(), jobId);
}

/** Keep a queued job from dispatching (spending is off, the sample, no approval) and say why. */
export function holdJob(jobId: string, reason: string, seconds = 120) {
  db().prepare("update jobs set hold = ?, next_run_at = ?, updated_at = ? where id = ? and status = 'queued'").run(reason, inSeconds(seconds), now(), jobId);
}

/**
 * Settle a finished job. Returns false (and records nothing) when the job was already
 * terminal, so a duplicate completion never charges twice.
 */
export function succeed(job: JobRow, output: unknown, actualCents: number | null, basis?: Basis): boolean {
  return tx(() => {
    const res = db()
      .prepare(`update jobs set status = 'succeeded', output = ?, actual_cents = ?, lease_owner = null, lease_until = null, finished_at = ?, updated_at = ? where id = ? and status in ${LIVE}`)
      .run(JSON.stringify(output), actualCents ?? job.est_cents, now(), now(), job.id);
    if (Number(res.changes) !== 1) return false;
    const fresh = getJob(job.id)!;
    if (fresh.est_cents > 0) settle(jobRef(fresh), { cents: actualCents ?? fresh.est_cents, basis: basis ?? (actualCents == null ? "estimate" : "provider"), note: job.kind, meta: { provider: fresh.provider, taskId: fresh.provider_task_id } });
    return true;
  });
}

/** `charged` is true when the provider took money even though no usable output came back. */
export function fail(job: JobRow, error: string, charged = false): boolean {
  return tx(() => {
    const res = db()
      .prepare(`update jobs set status = 'failed', error = ?, lease_owner = null, lease_until = null, finished_at = ?, updated_at = ? where id = ? and status in ${LIVE}`)
      .run(error.slice(0, 2000), now(), now(), job.id);
    if (Number(res.changes) !== 1) return false;
    const fresh = getJob(job.id)!;
    if (fresh.est_cents > 0) {
      if (charged) settle(jobRef(fresh), { cents: fresh.est_cents, basis: "estimate", note: `${job.kind} failed but charged` });
      else release(jobRef(fresh), `${job.kind} failed`);
    }
    return true;
  });
}

/** The provider may or may not have accepted it: keep the money reserved until a person resolves it. */
export function markAmbiguous(job: JobRow, why: string): boolean {
  const res = db()
    .prepare("update jobs set status = 'ambiguous', error = ?, lease_owner = null, lease_until = null, updated_at = ? where id = ? and status in ('queued', 'submitting', 'submitted', 'running')")
    .run(why, now(), job.id);
  return Number(res.changes) === 1;
}

/** Drop work that never reached a provider. Uncertain work cannot be dropped this way. */
export function cancel(jobId: string): boolean {
  return tx(() => {
    const job = getJob(jobId);
    if (!job || job.status !== "queued") return false;
    const res = db().prepare("update jobs set status = 'cancelled', finished_at = ?, updated_at = ? where id = ? and status = 'queued'").run(now(), now(), jobId);
    if (Number(res.changes) !== 1) return false;
    if (job.est_cents > 0) release(jobRef(job), `${job.kind} cancelled`);
    return true;
  });
}

/**
 * A person's ruling on uncertain work after checking the provider: it was not charged
 * (release the hold) or it was (charge the estimate). Either way the job ends.
 */
export function resolveUncertain(jobId: string, verdict: "not_charged" | "charged"): boolean {
  return tx(() => {
    const job = getJob(jobId);
    if (!job || job.status !== "ambiguous") return false;
    db().prepare("update jobs set status = ?, finished_at = ?, updated_at = ?, error = ? where id = ?").run(verdict === "charged" ? "failed" : "cancelled", now(), now(), `${job.error ?? ""} Resolved by a person: ${verdict === "charged" ? "charged, no result" : "not charged"}.`.trim(), jobId);
    if (job.est_cents > 0) {
      if (verdict === "charged") settle(jobRef(job), { cents: job.est_cents, basis: "estimate", note: `${job.kind} charged without a result` });
      else release(jobRef(job), `${job.kind} confirmed not charged`);
    }
    return true;
  });
}

/* ---------- polling leases ---------- */

type G = typeof globalThis & { __fastLaneWorkerId?: string };
export const WORKER_ID = ((globalThis as G).__fastLaneWorkerId ??= `w_${crypto.randomUUID().slice(0, 8)}`);

/** Only one process may poll (and settle) a submitted job at a time. */
export function leasePoll(jobId: string, seconds = 120, owner = WORKER_ID): boolean {
  const t = now();
  const res = db()
    .prepare("update jobs set lease_owner = ?, lease_until = ?, updated_at = ? where id = ? and status = 'submitted' and (lease_until is null or lease_until < ? or lease_owner = ?)")
    .run(owner, inSeconds(seconds), t, jobId, t, owner);
  return Number(res.changes) === 1;
}

export function releaseLease(jobId: string, owner = WORKER_ID) {
  db().prepare("update jobs set lease_owner = null, lease_until = null where id = ? and lease_owner = ?").run(jobId, owner);
}

export function inSeconds(s: number): string {
  return new Date(Date.now() + s * 1000).toISOString();
}

export function dueJobs(limit = 8): JobRow[] {
  const t = now();
  return db()
    .prepare("select * from jobs where status in ('queued', 'submitted') and (next_run_at is null or next_run_at <= ?) and (lease_until is null or lease_until < ? or lease_owner = ?) order by created_at limit ?")
    .all(t, t, WORKER_ID, limit) as JobRow[];
}

export function projectJobs(projectId: string): JobRow[] {
  return db().prepare("select * from jobs where project_id = ? order by created_at desc").all(projectId) as JobRow[];
}
