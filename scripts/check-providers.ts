/**
 * Free provider check: which keys resolve (never their values) and whether the media adapter
 * is connected. Nothing is billed. Once lib/adapters/media.ts is implemented, this also reads the Kie balance and
 * dry-runs the exact provider requests the studio would send (nothing is submitted).
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/check-providers.ts
 */
async function main() {
  const { hasSecret } = await import("../lib/env");
  const { media, mediaStatus } = await import("../lib/adapters/media");
  const keys = ["ANTHROPIC_API_KEY", "KIE_API_KEY", "ELEVENLABS_API_KEY", "BLOB_READ_WRITE_TOKEN"] as const;
  for (const k of keys) console.log(`${k}: ${hasSecret(k) ? "set" : "missing"}`);
  const status = mediaStatus();
  if (!status.connected) {
    console.log(`media: not connected — implement ${status.adapter} (see README, "Connecting generation").`);
    process.exit(0);
  }
  const credits = await media.credits();
  console.log(`Kie balance: ${credits} credits ≈ $${(credits * 0.005).toFixed(2)}`);
  const frame = "https://example.invalid/frame.png";
  for (const [aspect, seconds, resolution] of [["16:9", 5, "480p"], ["9:16", 5, "480p"], ["9:16", 8, "480p"], ["16:9", 7, "720p"], ["9:16", 10, "720p"]] as const) {
    try {
      const r = await media.dryRun("clipSubmit", { frameUrl: frame, prompt: "She looks up.", seconds, aspect, resolution, cameraFixed: false, pathname: "fast-lane/check.mp4" });
      console.log(`clip ${aspect} ${seconds}s ${resolution}: ok · model ${r.model} · est ${r.estCents}¢`);
    } catch (err) {
      console.log(`clip ${aspect} ${seconds}s ${resolution}: REFUSED · ${(err as Error).message.slice(0, 300)}`);
    }
  }
  const img = await media.dryRun("imageSubmit", { engine: "gptImage", prompt: "A single photograph.", aspect: "9:16", references: [{ url: frame, role: "character", label: "Ruth" }, { url: frame, role: "layout", label: "Grey blocking" }] });
  console.log(`image 9:16 with 2 references: ok · model ${img.model} · est ${img.estCents}¢ · dropped ${img.droppedReferences ?? 0}`);
  const mus = await media.dryRun("musicSubmit", { style: "sparse piano", title: "check", seconds: 120 });
  console.log(`music 120 s: ok · model ${mus.model} · est ${mus.estCents}¢`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
export {};
