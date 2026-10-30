/**
 * Local voice slots. Replace these placeholder IDs with voices available under
 * your own provider account when connecting speech generation.
 */

export type Voice = { id: string; name: string; tone: string; gender: "female" | "male" | "neutral"; use: "narrator" | "character" | "both" };

export const VOICES: Voice[] = [
  { id: "configure-warm-narrator", name: "Danielle", tone: "Calm, warm narrator", gender: "female", use: "narrator" },
  { id: "configure-british-storyteller", name: "George", tone: "Warm British storyteller", gender: "male", use: "both" },
  { id: "configure-reassuring", name: "Sarah", tone: "Mature, reassuring", gender: "female", use: "both" },
  { id: "configure-relaxed", name: "Roger", tone: "Laid-back, resonant", gender: "male", use: "both" },
  { id: "configure-bright", name: "Bella", tone: "Bright, professional", gender: "female", use: "both" },
  { id: "configure-neutral", name: "River", tone: "Relaxed, neutral", gender: "neutral", use: "narrator" },
  { id: "configure-understated", name: "Noah", tone: "Calm, understated", gender: "male", use: "both" },
  { id: "configure-deep-storyteller", name: "David", tone: "Deep British storyteller", gender: "male", use: "narrator" },
];

export const DEFAULT_NARRATOR = VOICES[0];

export function voiceById(voiceId: string | null | undefined): Voice | null {
  return VOICES.find((v) => v.id === voiceId) ?? null;
}

/** Pick a narrator from the plan's voice direction. */
export function narratorFor(style: string): Voice {
  const s = style.toLowerCase();
  if (/\b(male|man|his|baritone|deep)\b/.test(s)) return /british|storyteller/.test(s) ? VOICES[1] : VOICES[3];
  if (/bright|upbeat|energetic|lively/.test(s)) return VOICES[4];
  if (/reassur|mature|confident/.test(s)) return VOICES[2];
  return DEFAULT_NARRATOR;
}

/** Give each speaking character a distinct voice, matching gender words in their look. */
export function castVoices(characters: { id: string; text: string }[], narratorId: string): Record<string, string> {
  const used = new Set([narratorId]);
  const out: Record<string, string> = {};
  for (const c of characters) {
    const t = c.text.toLowerCase();
    const gender = /\b(woman|female|she|her|girl|mother|grandmother)\b/.test(t) ? "female" : /\b(man|male|he|his|boy|father|grandfather)\b/.test(t) ? "male" : "neutral";
    const pick = VOICES.find((v) => v.use !== "narrator" && !used.has(v.id) && (gender === "neutral" || v.gender === gender)) ?? VOICES.find((v) => !used.has(v.id)) ?? DEFAULT_NARRATOR;
    used.add(pick.id);
    out[c.id] = pick.id;
  }
  return out;
}
