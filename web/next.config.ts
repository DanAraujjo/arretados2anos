import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone só fora da Netlify (Docker/Railway). O adapter Netlify quebra com standalone.
  ...(process.env.NETLIFY ? {} : { output: "standalone" as const }),
  // Fotos (~400MB+) não podem ir no serverless handler da Netlify
  outputFileTracingExcludes: {
    "*": [
      "./public/photos/**/*",
      "./public/photos/**",
      "public/photos/**/*",
      "public/photos/**",
    ],
  },
};

export default nextConfig;
