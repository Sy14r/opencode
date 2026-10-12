import type { EventSubscribeOutput } from "@opencode/client/promise"
import type { SessionInfo } from "@opencode/client"

export type WatchStatus = "waiting" | "running" | "ready" | "error" | "idle"

export interface WatchedSession {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly projectID?: string
  readonly status: WatchStatus
  readonly updatedAt?: number
}

interface Tracked {
  readonly id: string
  title?: string
  directory?: string
  projectID?: string
  updatedAt?: number
  readonly waiting: Set<string>
  running: boolean
  outcome?: "succeeded" | "failed"
  engaged: boolean
}

// MCP elicitations are attributed to a "global" sentinel instead of a real
// session; they must never flip any single session's status.
const GLOBAL_SESSION_ID = "global"

export function snapshot(sessions: ReadonlyArray<SessionInfo>): Map<string, Tracked> {
  return new Map(
    sessions.map((session) => [
      session.id,
      {
        id: session.id,
        title: session.title,
        directory: session.location.directory,
        projectID: session.projectID,
        updatedAt: toTime(session.time.updated),
        waiting: new Set<string>(),
        running: false,
        outcome: session.outcome === "interrupted" ? undefined : session.outcome,
        engaged: seenResult(session),
      },
    ]),
  )
}

export function seedWaiting(store: Map<string, Tracked>, requests: ReadonlyArray<{ id: string; sessionID: string }>) {
  for (const request of requests) {
    if (request.sessionID === GLOBAL_SESSION_ID) continue
    store.get(request.sessionID)?.waiting.add(request.id)
  }
}

export function applyEvent(store: Map<string, Tracked>, event: EventSubscribeOutput): void {
  switch (event.type) {
    case "permission.asked": {
      if (event.data.sessionID === GLOBAL_SESSION_ID) return
      tracked(store, event.data.sessionID).waiting.add(event.data.id)
      return
    }
    case "permission.replied": {
      store.get(event.data.sessionID)?.waiting.delete(event.data.requestID)
      return
    }
    case "form.created": {
      if (event.data.form.sessionID === GLOBAL_SESSION_ID) return
      tracked(store, event.data.form.sessionID).waiting.add(event.data.form.id)
      return
    }
    case "form.replied":
    case "form.cancelled": {
      store.get(event.data.sessionID)?.waiting.delete(event.data.id)
      return
    }
    case "session.execution.started": {
      tracked(store, event.data.sessionID).running = true
      return
    }
    case "session.execution.succeeded": {
      const entry = tracked(store, event.data.sessionID)
      entry.running = false
      entry.outcome = "succeeded"
      return
    }
    case "session.execution.failed":
    case "session.execution.interrupted": {
      const entry = tracked(store, event.data.sessionID)
      entry.running = false
      entry.outcome = event.type === "session.execution.failed" ? "failed" : undefined
      return
    }
    case "session.inbox.enqueued": {
      if (event.data.item.type === "user") tracked(store, event.data.sessionID).engaged = true
      return
    }
    case "session.created": {
      if (!store.has(event.data.sessionID)) {
        store.set(event.data.sessionID, {
          id: event.data.sessionID,
          title: event.data.title,
          directory: event.data.location.directory,
          projectID: event.data.projectID,
          waiting: new Set<string>(),
          running: false,
          engaged: false,
        })
      }
      return
    }
    case "session.deleted": {
      store.delete(event.data.sessionID)
      return
    }
    case "session.moved": {
      const entry = store.get(event.data.sessionID)
      if (entry) {
        entry.directory = event.data.location.directory
        entry.projectID = event.data.projectID
      }
      return
    }
    case "session.renamed": {
      const entry = store.get(event.data.sessionID)
      if (entry) entry.title = event.data.title
      return
    }
    default:
      return
  }
}

export function statusOf(entry: Pick<Tracked, "waiting" | "running" | "outcome" | "engaged">): WatchStatus {
  if (entry.waiting.size > 0) return "waiting"
  if (entry.outcome === "failed") return "error"
  if (entry.running) return "running"
  if (entry.outcome === "succeeded" && !entry.engaged) return "ready"
  return "idle"
}

export function toJSON(store: Map<string, Tracked>): {
  generatedAt: number
  sessions: WatchedSession[]
} {
  return {
    generatedAt: Date.now(),
    sessions: [...store.values()].map((entry) => ({
      id: entry.id,
      title: entry.title,
      directory: entry.directory,
      projectID: entry.projectID,
      status: statusOf(entry),
      updatedAt: entry.updatedAt,
    })),
  }
}

function tracked(store: Map<string, Tracked>, sessionID: string): Tracked {
  const existing = store.get(sessionID)
  if (existing) return existing
  const entry: Tracked = {
    id: sessionID,
    waiting: new Set<string>(),
    running: false,
    engaged: false,
  }
  store.set(sessionID, entry)
  return entry
}

function seenResult(session: SessionInfo): boolean {
  const viewed = toTime(session.time.viewed)
  const idle = toTime(session.time.idle)
  return viewed !== undefined && idle !== undefined && viewed >= idle
}

function toTime(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}
