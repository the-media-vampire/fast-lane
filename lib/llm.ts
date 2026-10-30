import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { release, reserve, settle } from "./billing";
import { claudeClient } from "./providers";

/**
 * Claude access for Fast Lane. One model (Claude Opus 5.5) with effort tuned per route.
 * Server-side refusal fallbacks are on ("default" routing), so a declined request is
 * re-run on a fallback model inside the same call instead of silently stopping.
 *
 * Every call is metered: a bounded allowance is reserved before the request (so a project
 * with no approved allowance never calls the model), and the reported token usage is charged
 * the moment a response arrives — before parsing or tool handling can fail.
 */

export const MODEL = process.env.FASTLANE_MODEL ?? "claude-opus-5-5";
const BETAS: Anthropic.Beta.AnthropicBeta[] = ["server-side-fallback-2026-07-01"];

// Claude Opus 5.5 list prices, cents per million tokens.
export const CENTS_PER_MTOK = { input: 400, output: 2000, cacheRead: 20, cacheWrite: 500 };

export type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

export function usageCents(u: Usage | null | undefined): number {
  if (!u) return 0;
  const cents =
    (u.input_tokens * CENTS_PER_MTOK.input +
      u.output_tokens * CENTS_PER_MTOK.output +
      (u.cache_read_input_tokens ?? 0) * CENTS_PER_MTOK.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * CENTS_PER_MTOK.cacheWrite) /
    1_000_000;
  return Math.max(1, Math.ceil(cents));
}

/** The most one call can cost: every input token written to cache, every output token used. */
export function boundCents(inputChars: number, images: number, maxTokens: number): number {
  const inputTokens = Math.ceil(inputChars / 3) + images * 1700 + 800;
  return Math.ceil((inputTokens * CENTS_PER_MTOK.cacheWrite + maxTokens * CENTS_PER_MTOK.output) / 1_000_000) + 1;
}

/** Who pays for a model call. */
export type Bill = { projectId: string; purpose: string; jobId?: string | null; authId?: string | null };

function uncertainOutcome(err: unknown): boolean {
  // No HTTP status: the connection dropped or timed out after the request may have been processed.
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) return err.status === undefined;
  return false;
}

/** Reserve, call, and charge the reported usage as soon as the response exists. */
export async function metered<R extends { usage?: Usage | null; model?: string }>(bill: Bill, bound: number, call: () => Promise<R>): Promise<R & { cents: number }> {
  const ref = `model:${crypto.randomUUID()}`;
  reserve(bill.projectId, { cls: "model", cents: bound, ref, jobId: bill.jobId, authId: bill.authId, note: bill.purpose });
  let res: R;
  try {
    res = await call();
  } catch (err) {
    if (uncertainOutcome(err)) settle(ref, { cents: bound, basis: "uncertain", note: `${bill.purpose} (connection lost; may have been billed)` });
    else release(ref, `${bill.purpose} not billed`);
    throw err;
  }
  const cents = usageCents(res.usage ?? null);
  settle(ref, { cents, basis: "usage", note: bill.purpose, meta: { model: res.model ?? MODEL, usage: res.usage, centsPerMTok: CENTS_PER_MTOK } });
  return Object.assign(res, { cents });
}

export class RefusalError extends Error {}

export type Effort = "low" | "medium" | "high" | "xhigh";

/** One structured call: Claude returns JSON matching `schema`, already validated. */
export async function structured<S extends z.ZodType>(input: {
  schema: S;
  system: string;
  prompt: string;
  effort?: Effort;
  images?: { mime: "image/jpeg" | "image/png" | "image/webp"; base64: string; label: string }[];
  maxTokens?: number;
  bill: Bill;
}): Promise<{ data: z.infer<S>; cents: number }> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of input.images ?? []) {
    content.push({ type: "text", text: img.label });
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.base64 } });
  }
  content.push({ type: "text", text: input.prompt });
  const maxTokens = input.maxTokens ?? 16000;
  const schemaChars = JSON.stringify(z.toJSONSchema(input.schema, { unrepresentable: "any" })).length;
  const bound = boundCents(input.system.length + input.prompt.length + schemaChars, input.images?.length ?? 0, maxTokens);

  const res = await metered(input.bill, bound, () =>
    claudeClient().beta.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      betas: BETAS,
      fallbacks: "default",
      system: input.system,
      output_config: { effort: input.effort ?? "medium", format: betaZodOutputFormat(input.schema) },
      messages: [{ role: "user", content }],
    } as never),
  );
  // Usage is already charged; a refusal or a malformed answer still cost what it cost.
  if (res.stop_reason === "refusal") throw new RefusalError("Claude declined this request.");
  if (res.stop_reason === "max_tokens") throw new Error("The response was cut off before it finished.");
  if (res.parsed_output == null) throw new Error("Claude's answer did not match the expected shape.");
  return { data: res.parsed_output as z.infer<S>, cents: res.cents };
}

export const AGENT_BETAS = BETAS;
