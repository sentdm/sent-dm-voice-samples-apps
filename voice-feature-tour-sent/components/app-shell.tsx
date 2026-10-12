"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import { cn } from "cn";
import { PhoneIcon, SlidersHorizontalIcon, TerminalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useIdentity } from "@/lib/client/identity";
import { usePublicConfig } from "@/lib/client/use-public-config";

const links = [
  { href: "/phone", label: "Phone", icon: PhoneIcon },
  { href: "/console", label: "Console", icon: TerminalIcon },
  { href: "/setup", label: "Setup", icon: SlidersHorizontalIcon },
];

export function AppShell({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const { identity } = useIdentity();
  const [config] = usePublicConfig(pathname);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4">
          <Link href="/" className="font-semibold">
            Sent voice feature tour
          </Link>
          <nav className="flex items-center gap-1">
            {links.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "text-muted-foreground hover:text-foreground flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm",
                  pathname.startsWith(href) && "bg-muted text-foreground"
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2 text-sm">
            {config?.configured && config.publicUrlChanged && (
              <Link href="/setup">
                <Badge variant="destructive">Public URL changed</Badge>
              </Link>
            )}
            {config?.configured && (
              <Badge variant="secondary">{config.phoneNumber}</Badge>
            )}
            {config?.configured === false && (
              <Badge variant="destructive">Not set up</Badge>
            )}
            {identity && <Badge>{identity}</Badge>}
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
