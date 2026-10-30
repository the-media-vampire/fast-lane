import { z } from "zod";
import { structured, type Bill, type Effort } from "./llm";
import {
  LIMITS,
  ConceptStory,
  type AssetData,
  type AssetKind,
  type Beat,
  type Brief,
  type Concept,
  type Framing,
  type Kind,
  type Move,
  type Plan,
  type Shot,
} from "./types";

/**
 * The creative calls. Each one turns current project state into a new document version.
 * Model-facing schemas are deliberately loose (structured outputs support a subset of JSON
 * Schema); everything is normalised and clamped here before it is stored.
 */

export const SET_PRESETS = [
  "cafe",
  "kitchen",
  "living_room",
  "office",
  "shop",
  "bar",
  "bedroom",
  "gym",
  "street",
  "park",
  "studio_tabletop",
  "generic_interior",
] as const;

const HOUSE_RULES = `You are Astra, the creative partner inside Fast Lane, a studio that turns an idea into a finished 30-second to two-minute film: mostly commercials, sometimes short films and light stories.

Working rules:
- An idea is enough. Develop whatever is missing yourself; recommend, don't interrogate.
- Keep the user's facts separate from your creative assumptions.
- Never invent a business's name, prices, offers, guarantees, addresses, phone numbers, URLs, awards or factual claims. If copy would need one, write around it or leave a clearly marked placeholder such as [brand line].
- Only ask a question when the answer would materially change the film, and then offer two or three concrete choices with one recommended.
- Production limits for this lane: at most 3 recurring foreground characters, 3 locations and 24 shots. Performances stay simple: standing, sitting, walking, turning, looking, simple prop interaction. No crowds, stunts or fine choreography. Short dialogue and voiceover; at most one visible speaker per shot.
- Write with restraint and taste: specific images, plain words, no clichés, no exclamation marks.
- Keep what the person reads short. Detailed descriptions go only in the fields meant for image and video prompts.`;

function kindWords(kind: Kind) {
  return kind === "commercial" ? "commercial" : "short film";
}

/* ---------------- Brief ---------------- */

const BriefOut = z.object({
  title: z.string().describe("2–4 word working title"),
  summary: z.string().describe("One short sentence (at most 20 words): what the film is and who it is for. Plain words."),
  purpose: z.string().describe("At most 8 words, e.g. 'Bring bikes in before spring'"),
  audience: z.string().describe("At most 8 words"),
  tone: z.string().describe("2–4 words, e.g. 'Quiet, warm, observational'"),
  pacing: z.string().describe("At most 8 words"),
  supplied: z.object({ purpose: z.boolean(), audience: z.boolean(), tone: z.boolean() }).describe("True only where the person stated it themselves"),
  facts: z.array(z.string()).describe("Only what the user actually said or supplied; each at most 10 words."),
  assumptions: z.array(z.string()).describe("Your creative proposals that fill gaps; each at most 12 words, editable."),
  needsProductImage: z.boolean().describe("True only if exact product identity matters and no product image was supplied."),
  questions: z
    .array(
      z.object({
        question: z.string().describe("At most 14 words"),
        why: z.string().describe("At most 14 words"),
        choices: z.array(z.object({ label: z.string().describe("2–5 words"), detail: z.string().describe("At most 10 words"), recommended: z.boolean() })),
      }),
    )
    .describe("0–2 consequential questions, most important first. Only ones whose answer changes the film."),
});

export async function interpretBrief(input: {
  idea: string;
  kind: Kind;
  duration: number;
  aspect: string;
  uploads: { label: string; use: string }[];
  script?: string;
  answers?: { question: string; answer: string }[];
  bill: Bill;
}) {
  const { data, cents } = await structured({
    schema: BriefOut,
    effort: "low",
    maxTokens: 6000,
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `Interpret this request for a ${input.duration}-second ${kindWords(input.kind)} in ${input.aspect}.

The user wrote:
"""${input.idea}"""

Uploaded material: ${input.uploads.length ? input.uploads.map((u) => `${u.label} (${u.use})`).join("; ") : "none"}.
${input.script ? `The user supplied a script. Respect it; it is a fact, not a suggestion:\n"""${input.script.slice(0, 6000)}"""\n` : ""}${input.answers?.length ? `Answers already given:\n${input.answers.map((a) => `- ${a.question} → ${a.answer}`).join("\n")}` : ""}

Propose purpose, audience, tone and pacing in a few words each. Facts are only what the user stated or supplied. Put every inference in assumptions. Identify only what is missing; ask at most two questions, and only ones whose answer would change the film.`,
  });
  const questions = data.questions.slice(0, 2).map((q, i) => ({
    id: `q${i + 1}`,
    question: q.question,
    why: q.why,
    choices: normaliseChoices(q.choices),
  }));
  return { data: { ...data, questions }, cents };
}

function normaliseChoices(choices: { label: string; detail: string; recommended: boolean }[]) {
  const list = choices.slice(0, 3);
  while (list.length < 2) list.push({ label: "Leave it to Astra", detail: "Use the recommendation", recommended: false });
  const rec = Math.max(0, list.findIndex((c) => c.recommended));
  return list.map((c, i) => ({ id: `c${i + 1}`, label: c.label, detail: c.detail, recommended: i === rec }));
}

/* ---------------- Concepts ---------------- */

const ConceptsOut = z.object({
  concepts: z.array(
    z.object({
      title: z.string().describe("2–4 words"),
      tag: z.string().describe("2–4 word uppercase-style descriptor, e.g. CRAFT & TEXTURE"),
      pitch: z.string().describe("Exactly one sentence of 15–20 words: the idea as the person will read it on the card"),
      logline: z.string().describe("One or two sentences, evocative"),
      hook: z.string().describe("The first seconds: what grabs attention"),
      structure: z.string().describe("Beginning, middle, end in one sentence each"),
      story: z.array(z.object({
        title: z.string().describe("A 1–3 word beat heading, e.g. The discovery or First ride; no shot numbers"),
        visual: z.string().describe("One plain sentence, at most 22 words, describing what happens"),
        lines: z.array(z.object({
          kind: z.enum(["vo", "dialogue", "super"]),
          speaker: z.string().describe("Character name for dialogue; empty otherwise"),
          text: z.string().describe("The actual words, not a description of them"),
        })).describe("Only the words heard or seen in this beat; empty for a silent beat"),
      })).describe("4–6 beats covering the complete story, including the ending and any closing on-screen copy. This is the person's story preview before assets are made."),
      why: z.string().describe("Why this suits the brief, one sentence"),
      look: z.string().describe("Visual language: light, palette, lensing, rhythm"),
      imagePrompt: z.string().describe("A single key frame for this treatment, photographic, no text, no logos"),
      recommended: z.boolean(),
    }),
  ),
});

export async function proposeConcepts(input: { brief: Brief; direction?: string; previous?: Concept[]; bill: Bill }) {
  const b = input.brief;
  const { data, cents } = await structured({
    schema: ConceptsOut,
    effort: "medium",
    maxTokens: 8000,
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `${briefBlock(b)}
${input.direction ? `\nThe user's direction for this round: "${input.direction}"` : ""}
${input.previous?.length ? `\nPrevious directions (offer genuinely different ones unless asked to refine): ${input.previous.map((c) => c.title).join(", ")}` : ""}

Propose exactly three distinct treatments with different hooks and story structures, each achievable within the lane's limits and the ${b.duration}-second length. For EACH direction include a complete 4–6 beat story preview: beginning, development and ending, with the actual spoken or on-screen words next to the relevant beat. Keep actions to one short sentence each, no shot numbers, camera settings or timestamps. Silent ideas do not need invented speech. Preserve supplied script words and factual claims. Mark exactly one as recommended. Examples from advertising may inform you but are never templates.`,
  });
  const list = data.concepts.slice(0, 3);
  if (list.length < 3) throw new Error("Expected three concepts.");
  const rec = Math.max(0, list.findIndex((c) => c.recommended));
  const concepts: Concept[] = list.map((c, i) => ({ ...c, story: ConceptStory.parse(c.story), id: `k${Date.now().toString(36)}${i}`, recommended: i === rec }));
  return { concepts, cents };
}

/* ---------------- Plan ---------------- */

const PlanOut = z.object({
  title: z.string(),
  summary: z.string().describe("One sentence (at most 20 words) the person reads above the plan"),
  treatment: z.string().describe("Two or three sentences explaining the concept and feeling (shown only on request)"),
  beats: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      scene: z.string().describe("Film only: scene heading like INT. CAFÉ – DAWN. Empty for commercials."),
      visual: z.string().describe("What we see (commercial) or scene action (film), one or two plain sentences"),
      sound: z.string().describe("Sound and music in a few words, e.g. 'Room tone, a bell, soft piano'"),
      lines: z.array(
        z.object({
          kind: z.enum(["vo", "dialogue", "super"]),
          speaker: z.string().describe("Character name for dialogue, empty otherwise"),
          text: z.string(),
        }),
      ),
    }),
  ),
  voiceStyle: z.string(),
  musicMood: z.string(),
  endCardLine: z.string().describe("Closing line on screen; empty if none"),
  endCardDetail: z.string().describe("Small supporting line such as a supplied brand name; empty unless supplied"),
});

export async function writePlan(input: { brief: Brief; concept: Concept; current?: Plan | null; note?: string; bill: Bill }) {
  const b = input.brief;
  const doc =
    b.kind === "commercial"
      ? "a timed AV plan: beats with what we see, what we hear, voiceover and on-screen words (supers)"
      : "a short scene script expressed as timed beats: scene headings, scene action and brief dialogue";
  const { data, cents } = await structured({
    schema: PlanOut,
    effort: "medium",
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `${briefBlock(b)}

Chosen treatment: ${input.concept.title} — ${input.concept.logline}
Hook: ${input.concept.hook}
Structure: ${input.concept.structure}
Look: ${input.concept.look}
${input.concept.story ? `\nApproved story preview:\n${JSON.stringify(input.concept.story)}\nPreserve this story's events, order, ending and exact spoken/on-screen words. Add timing and production detail, not a different story. Do not invent extra dialogue. Put any closing on-screen copy in the end card, without duplicating it as a super.` : ""}
${input.current ? `\nCurrent plan (revise it, keep what works):\n${planText(input.current)}` : ""}
${input.note ? `\nThe user's note: "${input.note}"` : ""}

${b.script ? `The person supplied this script. Keep its words, speakers and order exactly; only add what is missing (timing, what we see, sound):\n"""${b.script.slice(0, 6000)}"""\n` : ""}
Write ${doc} for exactly ${b.duration} seconds. Describe each beat as what happens on screen in one or two plain sentences; never number shots or write "Shot 1" (shot planning comes later and numbers them). Beats are contiguous whole seconds from 0 to ${b.duration}, ${beatCount(b.duration)} beats. Voiceover must fit its beat at a natural pace (about 2.3 words per second). Keep copy readable: supers of at most 7 words. ${b.kind === "film" ? "Dialogue lines are short; one visible speaker per beat." : "Dialogue is optional; voiceover usually carries a commercial."}`,
  });
  const plan = normalisePlan(data, b.duration, b.kind);
  return { plan, cents };
}

function beatCount(duration: number) {
  if (duration <= 30) return "4 to 5";
  if (duration <= 60) return "5 to 8";
  if (duration <= 90) return "7 to 10";
  return "8 to 12";
}

function normalisePlan(data: z.infer<typeof PlanOut>, duration: number, kind: Kind): Plan {
  const raw = data.beats.filter((b) => b.visual.trim()).sort((a, b) => a.start - b.start);
  if (raw.length < 2) throw new Error("The plan needs at least two beats.");
  // Re-time to contiguous whole seconds covering exactly 0..duration, preserving the model's
  // proportions, with every beat at least two seconds long.
  const bounds = retime(
    raw.map((b) => Math.max(1, b.end - b.start)),
    duration,
  );
  const beats: Beat[] = raw.map((b, i) => {
    const id = `b${i + 1}`;
    return {
      id,
      start: bounds[i],
      end: bounds[i + 1],
      scene: kind === "film" && b.scene.trim() ? b.scene.trim() : undefined,
      visual: b.visual.trim(),
      sound: b.sound.trim(),
      lines: b.lines
        .filter((l) => l.text.trim())
        .map((l, j) => ({ id: `${id}l${j + 1}`, kind: l.kind, speaker: l.kind === "dialogue" ? l.speaker.trim() || undefined : undefined, text: l.text.trim() })),
    };
  });
  return {
    title: data.title,
    summary: data.summary,
    treatment: data.treatment,
    beats,
    voice: { style: data.voiceStyle },
    music: { mood: data.musicMood },
    endCard: data.endCardLine.trim() ? { line: data.endCardLine.trim(), detail: data.endCardDetail.trim() || undefined } : undefined,
  };
}

/** Boundaries [0, …, total] proportional to spans, whole seconds, each span ≥ 2 s. */
export function retime(spans: number[], total: number, min = 2): number[] {
  const sum = spans.reduce((a, b) => a + b, 0);
  const bounds = [0];
  let acc = 0;
  for (let i = 0; i < spans.length - 1; i++) {
    acc += spans[i];
    bounds.push(Math.round((acc / sum) * total));
  }
  bounds.push(total);
  for (let i = 1; i < bounds.length - 1; i++) bounds[i] = Math.max(bounds[i], bounds[i - 1] + min);
  for (let i = bounds.length - 2; i >= 1; i--) bounds[i] = Math.min(bounds[i], bounds[i + 1] - min);
  return bounds;
}

export function planText(plan: Plan): string {
  return plan.beats
    .map(
      (b) =>
        `[${b.id} ${b.start}–${b.end}s]${b.scene ? ` ${b.scene}` : ""} SEE: ${b.visual} | HEAR: ${b.sound}${b.lines.length ? ` | ${b.lines.map((l) => `${l.id} ${l.kind.toUpperCase()}${l.speaker ? ` (${l.speaker})` : ""}: "${l.text}"`).join(" ")}` : ""}`,
    )
    .join("\n");
}

/* ---------------- Assets ---------------- */

const AssetsOut = z.object({
  characters: z.array(z.object({ name: z.string(), description: z.string(), look: z.string().describe("Precise, consistent physical description and wardrobe"), role: z.string().describe("2–6 words, e.g. 'Mechanic who hands it over'"), height: z.number().describe("metres") })),
  locations: z.array(z.object({ name: z.string(), description: z.string(), look: z.string(), role: z.string().describe("2–6 words"), setPreset: z.enum(SET_PRESETS) })),
  props: z.array(z.object({ name: z.string(), description: z.string(), look: z.string(), role: z.string().describe("2–6 words"), size: z.enum(["small", "medium", "large"]).describe("small: hand-held (cup, phone); medium: bag, lamp, box; large: bicycle, bench, vehicle") })),
});

export type PlannedAsset = { kind: AssetKind; name: string; data: AssetData };

export async function planAssets(input: { brief: Brief; concept: Concept; plan: Plan; existing: { kind: AssetKind; name: string; description: string }[]; bill: Bill }) {
  const { data, cents } = await structured({
    schema: AssetsOut,
    effort: "medium",
    maxTokens: 8000,
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `${briefBlock(input.brief)}
Treatment: ${input.concept.title} — ${input.concept.look}
Plan:
${planText(input.plan)}

Existing assets (reuse these names exactly when they fit; uploads are the user's real material):
${input.existing.length ? input.existing.map((a) => `- ${a.kind}: ${a.name} — ${a.description}`).join("\n") : "none"}

List only the recurring cast (max ${LIMITS.characters}), locations (max ${LIMITS.locations}) and hero props (max 4) this plan needs for visual consistency across shots. Descriptions must be specific enough to keep identity stable from shot to shot. Pick the closest set preset for each location's rough layout.`,
  });
  const out: PlannedAsset[] = [
    ...data.characters.slice(0, LIMITS.characters).map((c) => ({ kind: "character" as const, name: c.name, data: { description: c.description, look: c.look, role: c.role, height: clamp(c.height || 1.72, 1.1, 2.05) } })),
    ...data.locations.slice(0, LIMITS.locations).map((l) => ({ kind: "location" as const, name: l.name, data: { description: l.description, look: l.look, role: l.role, set: l.setPreset } })),
    ...data.props.slice(0, 4).map((p) => ({ kind: "prop" as const, name: p.name, data: { description: p.description, look: p.look, role: p.role, size: p.size } })),
  ];
  return { assets: out, cents };
}

/* ---------------- Shots ---------------- */

const FRAMINGS = ["wide", "medium", "close", "detail", "hero", "ots", "pov"] as const;
const MOVES = ["static", "push_in", "pull_out", "pan", "track", "orbit"] as const;

const ShotsOut = z.object({
  shots: z.array(
    z.object({
      title: z.string().describe("3–5 words"),
      summary: z.string().describe("What happens, in at most 10 plain words, e.g. 'She opens the door and looks at the bike'"),
      beatId: z.string(),
      duration: z.number(),
      framing: z.enum(FRAMINGS),
      move: z.enum(MOVES),
      lens: z.number().describe("focal length mm, 18–135"),
      description: z.string().describe("What the frame shows, composition and light"),
      action: z.string().describe("Simple performance only: standing, sitting, walking, turning, looking, simple prop use"),
      location: z.string().describe("Exact location asset name, or empty"),
      characters: z.array(z.string()).describe("Exact character asset names visible"),
      props: z.array(z.string()).describe("Exact prop asset names visible"),
      lineIds: z.array(z.string()).describe("Plan line ids heard or shown over this shot"),
      speaker: z.string().describe("Visible speaking character name, or empty"),
    }),
  ),
});

type AssetRef = { id: string; kind: AssetKind; name: string };

export async function proposeShots(input: { brief: Brief; concept: Concept; plan: Plan; assets: AssetRef[]; note?: string; current?: Shot[]; bill: Bill }) {
  const b = input.brief;
  const target = shotTarget(b.duration);
  const { data, cents } = await structured({
    schema: ShotsOut,
    effort: "medium",
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `${briefBlock(b)}
Treatment look: ${input.concept.look}
Plan:
${planText(input.plan)}

Assets (use these exact names):
${input.assets.map((a) => `- ${a.kind}: ${a.name}`).join("\n")}
${input.current?.length ? `\nCurrent shot list (revise, keep what works; keep a shot's exact title when it is unchanged):\n${input.current.map((s, i) => `${i + 1}. ${s.title} — ${s.framing}/${s.move} ${s.duration}s: ${s.description}`).join("\n")}` : ""}
${input.note ? `\nThe user's note: "${input.note}"` : ""}

Build coverage and pacing for the ${b.aspect} frame: about ${target} shots whose durations add up to exactly ${b.duration} seconds (each ${LIMITS.shotMin}–${LIMITS.shotMax} s; give the emotional moment the longest hold). Every shot belongs to a beat and references the exact assets it shows. Camera moves are limited to static, push_in, pull_out, pan, track and orbit. At most one visible speaker per shot.`,
  });
  return { shots: normaliseShots(data.shots, b.duration, input.assets, input.plan, input.current), cents };
}

function shotTarget(duration: number) {
  return Math.min(LIMITS.shots, Math.max(5, Math.round(duration / 5)));
}

function normaliseShots(raw: z.infer<typeof ShotsOut>["shots"], duration: number, assets: AssetRef[], plan: Plan, current?: Shot[]): Shot[] {
  const byName = (kind: AssetKind, name: string) => assets.find((a) => a.kind === kind && a.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null;
  const lineIds = new Set(plan.beats.flatMap((b) => b.lines.map((l) => l.id)));
  const beatIds = new Set(plan.beats.map((b) => b.id));
  const list = raw.slice(0, LIMITS.shots);
  const durations = fitDurations(
    list.map((s) => s.duration),
    duration,
  );
  return list.map((s, i) => {
    const characterIds = s.characters.map((n) => byName("character", n)).filter((x): x is string => !!x).slice(0, LIMITS.characters);
    const prev = current?.[i];
    return {
      id: prev?.id ?? `s${Date.now().toString(36)}${i.toString(36).padStart(2, "0")}`,
      rev: (prev?.rev ?? 0) + 1,
      title: s.title,
      summary: s.summary,
      beatId: beatIds.has(s.beatId) ? s.beatId : null,
      duration: durations[i],
      framing: s.framing as Framing,
      move: s.move as Move,
      lens: clamp(Math.round(s.lens || 35), 18, 135),
      description: s.description,
      action: s.action,
      locationId: s.location ? byName("location", s.location) : null,
      characterIds,
      propIds: s.props.map((n) => byName("prop", n)).filter((x): x is string => !!x),
      lineIds: s.lineIds.filter((l) => lineIds.has(l)),
      speakerId: s.speaker ? byName("character", s.speaker) : null,
    };
  });
}

/** Scale durations (0.5 s grid) so they sum exactly to `total` within shot limits. */
export function fitDurations(wanted: number[], total: number): number[] {
  const n = wanted.length;
  if (n === 0) return [];
  const safe = wanted.map((w) => clamp(w || total / n, LIMITS.shotMin, LIMITS.shotMax));
  const sum = safe.reduce((a, b) => a + b, 0);
  const out = safe.map((w) => clamp(Math.round(((w * total) / sum) * 2) / 2, LIMITS.shotMin, LIMITS.shotMax));
  let diff = Math.round((total - out.reduce((a, b) => a + b, 0)) * 2) / 2;
  // Distribute the rounding remainder in half-second steps, longest shots first.
  const order = out.map((_, i) => i).sort((a, b) => out[b] - out[a]);
  let guard = 0;
  while (Math.abs(diff) >= 0.5 && guard++ < 400) {
    for (const i of order) {
      if (Math.abs(diff) < 0.5) break;
      const step = diff > 0 ? 0.5 : -0.5;
      const next = out[i] + step;
      if (next >= LIMITS.shotMin && next <= LIMITS.shotMax) {
        out[i] = next;
        diff -= step;
      }
    }
  }
  return out;
}

const ShotEditOut = z.object({
  title: z.string(),
  summary: z.string().describe("What happens, in at most 10 plain words"),
  framing: z.enum(FRAMINGS),
  move: z.enum(MOVES),
  lens: z.number(),
  description: z.string(),
  action: z.string(),
  change: z.string().describe("One short sentence telling the person what changed"),
});

export async function reviseShot(input: { brief: Brief; shot: Shot; note: string; assets: AssetRef[]; bill: Bill }) {
  const s = input.shot;
  const { data, cents } = await structured({
    schema: ShotEditOut,
    effort: "low",
    maxTokens: 4000,
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `${briefBlock(input.brief)}
Shot "${s.title}" (${s.duration}s, ${s.framing}, ${s.move}, ${s.lens}mm)
Description: ${s.description}
Action: ${s.action}
Assets in shot: ${input.assets.filter((a) => [s.locationId, ...s.characterIds, ...s.propIds].includes(a.id)).map((a) => a.name).join(", ") || "none"}

Apply this note and return the full revised shot: "${input.note}". Change only what the note asks for; keep every other detail word for word.`,
  });
  return { data: { ...data, lens: clamp(Math.round(data.lens), 18, 135) }, cents };
}

/* ---------------- Uploads ---------------- */

const UploadsOut = z.object({
  items: z.array(
    z.object({
      kind: z.enum(["character", "location", "prop", "style"]).describe("style = mood/reference only, not an identity to preserve"),
      name: z.string().describe("Short name, e.g. 'Mara', 'The café', 'Ceramic cup'. Use a supplied label if it names the thing."),
      description: z.string(),
      look: z.string().describe("Precise visual description to keep identity consistent"),
    }),
  ),
});

/** Work out what each supplied image is, so real material becomes a kept identity. */
export async function classifyUploads(input: { idea: string; images: { base64: string; label: string }[]; bill: Bill }) {
  const { data, cents } = await structured({
    schema: UploadsOut,
    effort: "low",
    maxTokens: 4000,
    bill: input.bill,
    system: HOUSE_RULES,
    prompt: `The person is making: "${input.idea}". They supplied ${input.images.length} image(s), in order. For each, say whether it is a person to cast, a place, a product/prop whose exact identity matters, or only a style reference. Return one item per image, in the same order.`,
    images: input.images.map((i, n) => ({ mime: "image/jpeg" as const, base64: i.base64, label: `Image ${n + 1} (file: ${i.label}):` })),
  });
  return { items: data.items.slice(0, input.images.length), cents };
}

/* ---------------- Picture prompts ---------------- */

export function conceptImagePrompt(c: Concept, brief: Brief) {
  return `${c.imagePrompt}\n\nVisual language: ${c.look}. A real movie frame for a ${brief.tone} ${kindWords(brief.kind)}. Natural photographic realism, fine film texture. No lettering, no logos, no captions, no UI, no watermarks.`;
}

export function assetReferencePrompt(kind: AssetKind, name: string, data: AssetData, look: string) {
  // One frame only: image models read "reference" as a mood board unless told otherwise.
  const single = "Exactly one photograph filling the whole frame — not a collage, grid, contact sheet, diptych or multiple views. No lettering, no logos, no captions, no watermarks.";
  if (kind === "character")
    return `A single full-length photographic portrait of ${name}: ${data.look}. ${data.description}. Standing in a relaxed three-quarter view, face clearly visible, neutral expression, against a plain, softly lit backdrop. Light and palette: ${look}. ${single}`;
  if (kind === "location") return `A single wide establishing photograph of ${name}, empty of people: ${data.look}. ${data.description}. Eye level, showing the layout, materials and light of the space. Light and palette: ${look}. ${single}`;
  return `A single product photograph of ${name}: ${data.look}. ${data.description}. The whole object in view on a plain neutral surface, true colours and materials, crisp detail. Light and palette: ${look}. ${single}`;
}

export function storyboardPrompt(input: { shot: Shot; staging: string; camera: string; look: string; names: { characters: string[]; location: string | null; props: string[] }; note?: string | null; keepPrevious?: boolean }) {
  const s = input.shot;
  return `A single photographic movie frame. ${s.description}. ${s.action}.
Camera: ${input.camera}. ${s.framing} framing.
Staging: ${input.staging}.
${input.names.location ? `Location: ${input.names.location}. ` : ""}${input.names.characters.length ? `On screen: ${input.names.characters.join(", ")}. ` : ""}${input.names.props.length ? `Props: ${input.names.props.join(", ")}. ` : ""}
${s.direction ? `Standing direction for this shot: ${s.direction}\n` : ""}${input.note ? `Change requested for this version: ${input.note}\n` : ""}${input.keepPrevious ? "The previous version of this frame is supplied: keep its composition and every detail the change does not mention.\n" : ""}Visual language: ${visualLook(input.look)} Keep every person, place and object exactly as in their reference images. No lettering, no logos, no captions, no watermarks, no UI.`;
}

/** The look as pictures only: editing, rhythm and sound words make video models cut and pictures muddled. */
export function visualLook(look: string): string {
  return look
    .split(/(?<=[.;])\s+/)
    .filter((sentence) => !/\b(shots?|cuts?|cutting|edit(?:s|ing)?|montage|sequence|pacing|rhythm|piano|music|score|sound|voice ?over|voice|tracking shot|opens? to)\b/i.test(sentence))
    .join(" ")
    .trim();
}

export function clipPrompt(input: { shot: Shot; camera: string; staging: string; look: string }) {
  const s = input.shot;
  // Video models read a list of events as a sequence and cut between angles. This is one shot.
  return `One continuous shot: a single unbroken take from one camera, with no cuts, no edits and no change of angle or location. It starts exactly on the first frame.
In this shot only: ${s.action}.${s.direction ? ` ${s.direction}` : ""}
Camera: ${input.camera}.
Staging: ${input.staging}.
Natural, unhurried performance; simple, believable movement. Keep every face, the wardrobe, the bike and every object identical to the first frame. ${visualLook(input.look)} No text, no logos.`;
}

/** A further reference view of an asset, made from its approved primary image. */
export function assetViewPrompt(kind: AssetKind, name: string, data: AssetData, look: string, request: string) {
  const single = "Exactly one photograph filling the whole frame — not a collage, grid, contact sheet, diptych or multiple views. No lettering, no logos, no captions, no watermarks.";
  const keep = kind === "character" ? "face, hair, build and clothing" : kind === "location" ? "architecture, materials and light" : "shape, colour and material";
  return `${request} — ${name}: ${data.look}. The supplied reference image is the approved look: keep exactly the same ${keep} unless this request changes them. Light and palette: ${look}. ${single}`;
}

/* ---------------- helpers ---------------- */

export function briefBlock(b: Brief) {
  return `Brief: ${b.title} — a ${b.duration}-second ${kindWords(b.kind)} in ${b.aspect}.
Idea: ${b.idea}
Purpose: ${b.purpose}. Audience: ${b.audience}. Tone: ${b.tone}. Pacing: ${b.pacing}.
User facts: ${b.facts.length ? b.facts.join("; ") : "none beyond the idea"}.
Working assumptions: ${b.assumptions.join("; ") || "none"}.
${b.questions.filter((q) => q.answer).map((q) => `Decided: ${q.question} → ${q.answer}`).join("\n")}`;
}

export function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

export type { Effort };
