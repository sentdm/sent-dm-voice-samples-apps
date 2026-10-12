import type { NextConfig } from "next";

// The development server refuses requests for its own assets from another origin. The phone
// on a second computer opens the app through a tunnel URL, so tunnel hosts are allowed here.
// Add your own with DEV_ORIGINS, comma separated, for example DEV_ORIGINS=voice.example.com
const tunnelOrigins = [
  "*.ngrok-free.dev",
  "*.ngrok-free.app",
  "*.ngrok.app",
  "*.ngrok.io",
  "*.trycloudflare.com",
  ...(process.env.DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  // Strict mode mounts effects twice in development, which would create, destroy and create the
  // SDK client again on every page load. One client per mount keeps the event log readable.
  reactStrictMode: false,

  allowedDevOrigins: tunnelOrigins,

  // cloudflared finds its binary next to its own files, so it runs from node_modules unbundled.
  serverExternalPackages: ["cloudflared"],
};

export default nextConfig;
