/**
 * Runs once when the server starts. It makes Node trust the system certificate store, then opens
 * the public tunnel Sent reaches this app through, unless PUBLIC_BASE_URL names a fixed public URL.
 * Not awaited: the tunnel takes a few seconds, and the setup screen shows its progress.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { trustSystemCertificates } = await import("./lib/server/certificates");
  trustSystemCertificates();
  if (process.env.PUBLIC_BASE_URL?.trim()) return;
  const { openTunnel } = await import("./lib/server/tunnel");
  openTunnel(Number(process.env.PORT ?? 3000));
}
