import { MessageCircle, MessageSquareText, MessagesSquare, Phone, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { initials } from "@/lib/format"
import type { Channel, Contact } from "@/lib/types"

export const CHANNEL_ICON: Record<Channel | "voice", LucideIcon> = {
  sms: MessageSquareText,
  whatsapp: MessageCircle,
  rcs: MessagesSquare,
  voice: Phone,
}

/** The Sent mark from the other samples: three nodes on two crossed lines. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 18" aria-hidden="true" className={cn("h-[18px] w-6", className)}>
      <line x1="2" y1="3" x2="22" y2="15" stroke="currentColor" strokeWidth="1" />
      <line x1="2" y1="15" x2="22" y2="3" stroke="currentColor" strokeWidth="1" />
      {[3, 12, 21].map((cx) => (
        <circle key={cx} cx={cx} cy="9" r="2.5" fill="var(--paper)" stroke="currentColor" strokeWidth="1" />
      ))}
    </svg>
  )
}

export function ContactAvatar({ contact, size = "default", className }: { contact: Contact; size?: "sm" | "default" | "lg"; className?: string }) {
  return (
    <Avatar size={size} className={cn("rounded-sm after:rounded-sm", className)}>
      <AvatarFallback
        className={cn(
          "rounded-sm text-[11px] font-semibold tracking-tight",
          contact.name ? "bg-ink text-panel" : "bg-muted text-muted-foreground"
        )}
      >
        {initials(contact)}
      </AvatarFallback>
    </Avatar>
  )
}

/** A pulsing dot for anything happening right now. Still when motion is reduced. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2", className)} aria-hidden="true">
      <span className="absolute inset-0 rounded-full bg-current opacity-60 motion-safe:animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  )
}

function seeded(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

/**
 * Call audio drawn as a strip of bars. The heights come from the call id, so a
 * call keeps the same shape on every render. Live strips animate.
 */
export function Waveform({ seed, bars = 56, live = false, className }: { seed: string; bars?: number; live?: boolean; className?: string }) {
  const rand = seeded(seed)
  return (
    <div className={cn("flex h-6 items-center gap-[2px]", className)} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => {
        const envelope = Math.sin((i / bars) * Math.PI) * 0.55 + 0.45
        const height = Math.max(22, Math.round((0.35 + rand() * 0.65) * 100 * envelope))
        return (
          <span
            key={i}
            className={cn("w-[2px] shrink-0 rounded-full bg-current", live && "wave-bar")}
            style={{ height: `${height}%`, animationDelay: live ? `${(i % 9) * -0.12}s` : undefined }}
          />
        )
      })}
    </div>
  )
}
