"use client"

import dynamic from "next/dynamic"

// The console needs browser-only APIs (audio, the Sent voice SDK, WebSockets)
// and shows times from the browser clock, so it renders on the client only.
const ConsoleApp = dynamic(() => import("./console-app").then((m) => m.ConsoleApp), {
  ssr: false,
  loading: () => (
    <div className="paper-grid flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading conversations…
    </div>
  ),
})

export function ConsoleRoot() {
  return <ConsoleApp />
}
