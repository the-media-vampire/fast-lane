import { createFromIdea, type NewFile } from "@/lib/create";
import { listView } from "@/lib/view";
import { Aspect, Kind, MAX_DURATION, MIN_DURATION } from "@/lib/types";

export async function GET() {
  return Response.json({ projects: listView() });
}

export async function POST(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  let idea = "";
  let kind = "commercial";
  let duration = 45;
  let aspect = "16:9";
  let autopilot = false;
  let allowance = 0;
  let script = "";
  const files: NewFile[] = [];
  if (type.includes("multipart/form-data")) {
    const form = await req.formData();
    idea = String(form.get("idea") ?? "");
    kind = String(form.get("kind") ?? kind);
    duration = Number(form.get("duration") ?? duration);
    aspect = String(form.get("aspect") ?? aspect);
    autopilot = form.get("autopilot") === "true";
    allowance = Number(form.get("allowance") ?? 0);
    script = String(form.get("script") ?? "");
    for (const f of form.getAll("files")) {
      if (typeof f === "string") continue;
      const limit = f.type.startsWith("video/") ? 200 : 20;
      if (f.size > limit * 1024 * 1024) return Response.json({ error: `${f.name} is larger than ${limit} MB.` }, { status: 400 });
      files.push({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) });
    }
  } else {
    const body = (await req.json()) as Record<string, unknown>;
    idea = String(body.idea ?? "");
    kind = String(body.kind ?? kind);
    duration = Number(body.duration ?? duration);
    aspect = String(body.aspect ?? aspect);
    autopilot = body.autopilot === true;
    allowance = Number(body.allowance ?? 0);
    script = String(body.script ?? "");
  }
  const k = Kind.safeParse(kind);
  const a = Aspect.safeParse(aspect);
  if (!k.success || !a.success || !Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    return Response.json({ error: `Choose a commercial or short film, 16:9 or 9:16, and a whole number of seconds from ${MIN_DURATION} to ${MAX_DURATION}.` }, { status: 400 });
  }
  if (!Number.isFinite(allowance) || allowance < 0 || allowance > 50) return Response.json({ error: "The planning allowance is between $0 and $50." }, { status: 400 });
  try {
    const id = await createFromIdea({ idea, kind: k.data, duration, aspect: a.data, autopilot, files, script: script.slice(0, 20000), allowanceCents: Math.round(allowance * 100) });
    return Response.json({ id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
