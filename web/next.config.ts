import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone só fora da Netlify (Docker/Railway). O adapter Netlify quebra com standalone.
  ...(process.env.NETLIFY ? {} : { output: "standalone" as const }),
};

export default nextConfig;
