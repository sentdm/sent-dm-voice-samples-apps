import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
      // The voice client's bundled calling library keeps AMD branches Turbopack cannot resolve.
      // Temporary: remove this rule and scripts/voice-client-amd-loader.cjs once
      // @sentdm/voice-client 0.2.1 is installed, which strips these branches at build.
      "sinch-rtc.{js,mjs}": {
        condition: { path: /@sentdm\/voice-client\/adapter\// },
        loaders: ["./scripts/voice-client-amd-loader.cjs"],
      },
    },
  },
};

export default nextConfig;
