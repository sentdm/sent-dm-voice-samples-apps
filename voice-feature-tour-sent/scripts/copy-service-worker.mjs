// Copies the service worker shipped by @sentdm/voice-client into public/, where the SDK expects to
// find it. `pnpm dev` and `pnpm build` run it, so it always matches the installed SDK.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const publicDir = resolve(process.cwd(), "public");
mkdirSync(publicDir, { recursive: true });
copyFileSync(
  require.resolve("@sentdm/voice-client/sw.js"),
  resolve(publicDir, "sw.js")
);
