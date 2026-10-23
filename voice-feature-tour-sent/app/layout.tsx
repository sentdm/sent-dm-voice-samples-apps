import type { Metadata } from "next";
import type { PropsWithChildren } from "react";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Sent voice feature tour",
  description:
    "A browser phone on @sentdm/voice-client and the customer backend that mints tokens, answers call questions and receives call webhooks.",
};

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
