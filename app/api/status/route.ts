import { mediaStatus } from "@/lib/adapters/media";
import { workerStatus } from "@/lib/worker";
import { hasSecret, liveEnabled } from "@/lib/env";

/** Operator view: is the worker alive, is media generation connected, which keys resolve. */
export async function GET() {
  return Response.json({
    worker: workerStatus(),
    media: mediaStatus(),
    live: liveEnabled(),
    keys: { anthropic: hasSecret("ANTHROPIC_API_KEY"), kie: hasSecret("KIE_API_KEY"), blob: hasSecret("BLOB_READ_WRITE_TOKEN"), elevenlabs: hasSecret("ELEVENLABS_API_KEY") },
  });
}
