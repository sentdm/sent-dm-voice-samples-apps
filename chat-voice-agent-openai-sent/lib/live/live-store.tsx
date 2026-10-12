"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { InboxFilter, PhoneCommand, ServerMessage, Snapshot } from "@/lib/types"
import { ConsoleContext, type ConsoleActions, type ConsoleValue } from "@/lib/console-context"
import { activeCall } from "@/lib/policy"
import { inbox } from "@/lib/selectors"
import { PhoneEngine } from "./phone"

/**
 * The server owns the conversations and sends a snapshot over
 * /ws on every change. Actions are POSTs to /api; their results come back as
 * the next snapshot. This tab may also be the phone.
 */
export function LiveConsoleProvider({ csrf, children }: { csrf: string; children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selectedId, setSelectedId] = useState("")
  const [filter, setFilter] = useState<InboxFilter>("open")
  const [clientId] = useState(() => crypto.randomUUID())
  // The phone engine reads the latest snapshot outside React renders, for example when an incoming call rings.
  const snapshotRef = useRef<Snapshot | null>(null)
  const phoneRef = useRef<PhoneEngine | null>(null)

  const post = useCallback(
    async <T,>(path: string, body: object = {}): Promise<T> => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body),
      })
      const json = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) throw new Error(json.error ?? `Request failed (${response.status}).`)
      return json as T
    },
    [csrf],
  )

  const handlePhone = useCallback((command: PhoneCommand) => phoneRef.current?.handle(command), [])

  useEffect(() => {
    let socket: WebSocket | undefined
    let retry: number | undefined
    let closed = false
    const connect = () => {
      socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(csrf)}&clientId=${clientId}`)
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as ServerMessage
        if (message.type === "snapshot") {
          snapshotRef.current = message.snapshot
          setSnapshot(message.snapshot)
        } else if (message.type === "phone") handlePhone(message.command)
        else if (message.level === "error") toast.error(message.message)
        else toast(message.message)
      }
      socket.onclose = () => {
        if (!closed) retry = window.setTimeout(connect, 1_500)
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(retry)
      socket?.close()
    }
  }, [csrf, clientId, handlePhone])

  const start = useCallback(async () => {
    const phone = new PhoneEngine({
      clientId,
      csrf,
      post,
      snapshot: () => snapshotRef.current,
      remoteAudio: () => document.getElementById("remote-audio") as HTMLAudioElement | null,
      notify: (level, message) => (level === "error" ? toast.error(message) : toast(message)),
    })
    phoneRef.current = phone
    await phone.start()
  }, [clientId, csrf, post])

  const stop = useCallback(async () => {
    const phone = phoneRef.current
    phoneRef.current = null
    if (phone?.running) await phone.stop()
    else await post("/api/stop")
  }, [post])

  const setMuted = useCallback((muted: boolean) => phoneRef.current?.setMuted(muted), [])

  const connect = useCallback(
    async (sentKey: string, openaiKey: string) => {
      await post("/api/connect", { sentKey, openaiKey })
    },
    [post],
  )

  const value = useMemo<ConsoleValue | null>(() => {
    if (!snapshot) return null
    const run = (promise: Promise<unknown>) => void promise.catch((error: Error) => toast.error(error.message))
    const path = (id: string, action: string) => `/api/conversations/${id}/${action}`
    const callOf = (id: string) => {
      const conversation = snapshot.conversations.find((c) => c.id === id)
      return conversation ? activeCall(conversation) : undefined
    }
    const callAction = (id: string, action: string, body: object = {}) => {
      const call = callOf(id)
      if (call) run(post(`/api/calls/${call.id}/${action}`, body))
    }
    const actions: ConsoleActions = {
      select: (id) => {
        setSelectedId(id)
        run(post(path(id, "read")))
      },
      setFilter,
      send: (id, text, channel) => run(post(path(id, "send"), { text, channel })),
      sendTemplate: (id, templateId, parameters, channel) => run(post(path(id, "send-template"), { templateId, parameters, channel })),
      takeOver: (id) => run(post(path(id, "take-over"))),
      handBack: (id) => run(post(path(id, "hand-back"))),
      approveHandover: (id, pid) => run(post(`/api/conversations/${id}/proposals/${pid}/approve`, { by: "human" })),
      dismissHandover: (id, pid) => run(post(`/api/conversations/${id}/proposals/${pid}/dismiss`)),
      approveCall: (id, pid, by) => run(post(`/api/conversations/${id}/proposals/${pid}/approve`, { by })),
      dismissCall: (id, pid) => run(post(`/api/conversations/${id}/proposals/${pid}/dismiss`)),
      startCall: (id, by) => run(post(path(id, "call"), { by })),
      answer: (id, by) => callAction(id, "answer", { by }),
      declineCall: (id) => callAction(id, "decline"),
      takeOverCall: (id) => callAction(id, "take-over"),
      toggleListen: (id) => callAction(id, "listen", { on: !callOf(id)?.listening }),
      hangUp: (id) => callAction(id, "hang-up"),
      resolve: (id) => run(post(path(id, "resolve"))),
      reopen: (id) => run(post(path(id, "reopen"))),
      saveSettings: async (settings) => {
        await post("/api/settings", { settings })
      },
      setConsent: (id, granted) => run(post(path(id, "consent"), { granted })),
      setTimeZone: (id, timeZone) => run(post(path(id, "time-zone"), { timeZone })),
      createCampaign: async (input) => {
        await post("/api/campaigns", input)
      },
      stopCampaign: (id) => run(post(`/api/campaigns/${id}/stop`)),
      resumeCampaign: (id) => run(post(`/api/campaigns/${id}/resume`)),
    }

    const visible = inbox(snapshot.conversations, filter)
    const selected = snapshot.conversations.some((c) => c.id === selectedId) ? selectedId : (visible[0]?.id ?? snapshot.conversations[0]?.id ?? "")

    return {
      state: { conversations: snapshot.conversations, settings: snapshot.settings, templates: snapshot.templates ?? [], campaigns: snapshot.campaigns ?? [], selectedId: selected, filter },
      actions,
      live: { system: snapshot.system, isPhone: snapshot.system.phoneId === clientId, connect, start, stop, setMuted },
    }
  }, [snapshot, selectedId, filter, clientId, post, connect, start, stop, setMuted])

  if (!snapshot) {
    return <div className="paper-grid flex h-full items-center justify-center text-sm text-muted-foreground">Connecting to the local server…</div>
  }
  return (
    <ConsoleContext.Provider value={value}>
      {children}
      {/* The Sent voice SDK plays the other party's audio here. Muted unless a person is on the call or listening in. */}
      <audio id="remote-audio" muted aria-hidden="true" />
    </ConsoleContext.Provider>
  )
}
