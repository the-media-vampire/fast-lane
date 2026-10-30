import Anthropic from "@anthropic-ai/sdk";
import { media as adapterMedia } from "./adapters/media";
import { assertSpendable } from "./billing";
import { secret } from "./env";

/**
 * Where paid providers come from. Production code always asks here, so offline checks can
 * swap in fakes (or spies that fail if touched) without real credentials or network.
 */

export type Media = typeof adapterMedia;

/** The subset of the Anthropic client Fast Lane uses. */
export type ClaudeClient = {
  beta: {
    messages: {
      create: (body: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;
      parse: (body: never) => Promise<{ usage: Anthropic.Beta.BetaUsage; model: string; stop_reason: string | null; parsed_output?: unknown }>;
    };
  };
};

type Registry = { media?: Media; claude?: ClaudeClient; realClaude?: Anthropic };
const g = globalThis as typeof globalThis & { __fastLaneProviders?: Registry };
const registry = (g.__fastLaneProviders ??= {});

/** Tests only: replace the providers. Pass {} to restore the real ones. */
export function setProviders(p: { media?: Media; claude?: ClaudeClient }) {
  registry.media = p.media;
  registry.claude = p.claude;
}

export function claudeClient(): ClaudeClient {
  if (registry.claude) return registry.claude;
  registry.realClaude ??= new Anthropic({ apiKey: secret("ANTHROPIC_API_KEY"), maxRetries: 2, timeout: 300_000 });
  return registry.realClaude as unknown as ClaudeClient;
}

/** Calls that buy something or publish a file to a public URL. */
const PAID = new Set(["imageSubmit", "clipSubmit", "musicSubmit", "speak", "publish"]);

/**
 * The media services for one project. Paid calls pass the spending gate first, so a stale
 * queue, a sample project or a server with spending off can never reach a provider.
 */
export function mediaFor(projectId: string): Media {
  const base = registry.media ?? adapterMedia;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!PAID.has(String(prop))) return value.bind(target);
      return (...args: unknown[]) => {
        assertSpendable(projectId);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Free, project-independent media work (inspection, assembly, overlays, balance). */
export function freeMedia(): Media {
  const base = registry.media ?? adapterMedia;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (PAID.has(String(prop))) return () => Promise.reject(new Error(`${String(prop)} needs a project's spending gate.`));
      return value.bind(target);
    },
  });
}
