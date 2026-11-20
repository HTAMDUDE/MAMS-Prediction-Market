import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page is per-user and reads live prices, so nothing is prerendered or cached.
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
