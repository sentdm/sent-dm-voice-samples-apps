import type { Metadata } from "next"
import { Inter } from "next/font/google"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })

export const metadata: Metadata = {
  title: "Sent conversations",
  description: "One customer conversation across messaging and voice, run by an AI agent with people in the loop.",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <Toaster position="top-center" />
      </body>
    </html>
  )
}
