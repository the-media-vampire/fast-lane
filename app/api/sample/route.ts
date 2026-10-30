import { ensureSample } from "@/lib/create";

export async function POST() {
  const id = await ensureSample();
  return Response.json({ id });
}
