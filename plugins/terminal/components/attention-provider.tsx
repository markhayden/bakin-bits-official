'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { sendBrowserNotification, toast, useNavBadge, usePluginEvent } from '@makinbakin/sdk/hooks'
import { PluginLink } from '@makinbakin/sdk/navigation'
import { ATTENTION_EVENT, type AttentionSummary } from '../lib/contracts'
import { api, clientId } from './api'
import { announcements, attentionBadge, claimOnce, otherTabFocused, setFocused, visibleSessionId, watched, WATCHING_BEAT_MS, type Announcement } from './attention'

/** Missed events are caught up by this re-read too. */
const REREAD_MS = 60_000

/**
 * Background component (renders nothing) in the host's `nav-badge-providers`
 * slot. Every attention event, every reconnect and a periodic re-read fetch
 * `GET /attention`; the newest read sets the Terminal nav badge (sessions that
 * want you), and what changed since the last one is told — a toast in every
 * visible tab, one OS notification across tabs — unless a tab on this device
 * has that session open and focused (it acknowledges it; components/attention.ts).
 */
/** How a change is told: the SDK's toast and OS notification (a test gives its own). */
export interface Delivery {
  toast(message: ReactNode): void
  notify(title: string, body: string, href: string): void
}
const SDK_DELIVERY: Delivery = { toast: (message) => { toast(message, 'info') }, notify: sendBrowserNotification }

export function TerminalAttentionProvider({ delivery = SDK_DELIVERY }: { delivery?: Delivery }) {
  const [sessions, setSessions] = useState<AttentionSummary[]>([])
  const known = useRef<Map<string, AttentionSummary> | undefined>(undefined)
  // Reads overlap: only the newest one asked applies (an older answer would bring back what was acknowledged).
  const asked = useRef(0)
  const load = useCallback(async () => {
    const mine = ++asked.current
    let next: AttentionSummary[]
    try { next = (await api<{ sessions: AttentionSummary[] }>('/attention')).sessions } catch { return }
    if (mine !== asked.current) return
    const told = announcements(known.current, next)
    known.current = new Map(next.map((session) => [session.id, session]))
    setSessions(next)
    for (const announcement of told) void tell(announcement, delivery)
  }, [delivery])
  useEffect(() => {
    void load()
    const timer = setInterval(() => { void load() }, REREAD_MS)
    return () => clearInterval(timer)
  }, [load])
  // Whether this tab has focus, for every other tab (the host's OS notification checks only its own).
  useEffect(() => {
    const tab = clientId()
    const beat = () => setFocused(tab, document.visibilityState === 'visible' && document.hasFocus())
    beat()
    const timer = setInterval(beat, WATCHING_BEAT_MS)
    window.addEventListener('focus', beat)
    window.addEventListener('blur', beat)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', beat)
      window.removeEventListener('blur', beat)
      document.removeEventListener('visibilitychange', beat)
      setFocused(tab, false)
    }
  }, [])
  usePluginEvent(ATTENTION_EVENT, () => { void load() })
  // The shell's event stream reconnected: what changed meanwhile is told now.
  usePluginEvent('bakin.reconcile', () => { void load() })
  useNavBadge('terminal', 'terminal', attentionBadge(sessions))
  return null
}

async function tell(announcement: Announcement, delivery: Delivery): Promise<void> {
  // Open and focused in this tab or another on this device: that tab acknowledges it, nobody tells it.
  const here = visibleSessionId(window.location.pathname) === announcement.sessionId && document.visibilityState === 'visible' && document.hasFocus()
  if (here || watched(announcement.sessionId)) return
  // A hidden tab's toast would be stale when it is next looked at.
  if (document.visibilityState === 'visible') {
    delivery.toast(<span data-terminal-attention={announcement.key}>{announcement.title} · <PluginLink to={announcement.href}>Open</PluginLink></span>)
  }
  // One OS notification across tabs, and none while a Bakin tab has focus (its toast is there): the host
  // checks only this tab, so the others are checked here, just before sending.
  if (await claimOnce(announcement.key) && !otherTabFocused(clientId())) delivery.notify(announcement.title, announcement.body, announcement.href)
}
