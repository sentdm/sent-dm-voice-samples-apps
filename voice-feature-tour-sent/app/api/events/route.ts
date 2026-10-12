import { subscribe } from "@/lib/server/state";

export const dynamic = "force-dynamic";

const KEEP_ALIVE_MS = 20_000;

/**
 * Server-sent events: every question, answer, webhook, telemetry batch, presence change and
 * call update the server sees, as it happens. The browser opens one EventSource per page.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    clearInterval(keepAlive);
    keepAlive = undefined;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      send("retry: 2000\n\n");
      unsubscribe = subscribe(send);
      keepAlive = setInterval(() => send(": keep-alive\n\n"), KEEP_ALIVE_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel: cleanup,
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
