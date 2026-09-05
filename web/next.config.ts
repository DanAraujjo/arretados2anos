import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Smaller image for Railway/Docker; local `next start` still works
  output: "standalone",
};

export default nextConfig;
