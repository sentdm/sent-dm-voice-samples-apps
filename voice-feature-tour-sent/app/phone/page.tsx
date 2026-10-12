"use client";

import dynamic from "next/dynamic";
import { AppShell } from "@/components/app-shell";

// The voice SDK only runs in the browser, so the phone is never rendered on the server.
const PhoneView = dynamic(
  () => import("@/components/phone/phone-view").then((mod) => mod.PhoneView),
  { ssr: false }
);

export default function PhonePage() {
  return (
    <AppShell>
      <PhoneView />
    </AppShell>
  );
}
