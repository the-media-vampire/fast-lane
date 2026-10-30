/**
 * Starts the production worker inside the Next.js server process, so generation continues
 * after the browser closes and resumes after a restart.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.FASTLANE_WORKER === "off") return;
  const { startWorker } = await import("./lib/worker");
  startWorker();
}
