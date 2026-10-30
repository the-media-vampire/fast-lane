import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Parallel dev servers (capture worker tests) can use their own build directory.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["playwright-core"],
  devIndicators: false,
};

export default nextConfig;
