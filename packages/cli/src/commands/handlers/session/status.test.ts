import { describe, expect, test } from "bun:test"
import type { EventSubscribeOutput } from "@opencode/client/promise"
import type { SessionInfo } from "@opencode/client"
import { applyEvent, seedWaiting, snapshot, statusOf, toJSON } from "./status"

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_test",
    projectID: "proj_test",
    location: { directory: "/work" },
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens: {},
    ...overrides,
  } as SessionInfo
}

function event<T extends EventSubscribeOutput["type"]>(
  type: T,
  data: Extract<EventSubscribeOutput, { type: T }>["data"],
): EventSubscribeOutput {
  return { id: "evt_1", created: 3, type, data } as EventSubscribeOutput
}

describe("session watch status", () => {
  test("fresh snapshot is idle", () => {
    const store = snapshot([session()])
    expect(statusOf(store.get("ses_test")!)).toBe("idle")
  })

  test("waiting outranks running and error", () => {
    const store = snapshot([session()])
    applyEvent(store, event("session.execution.started", { sessionID: "ses_test" }))
    applyEvent(store, event("permission.asked", { id: "perm_1", sessionID: "ses_test" } as never))
    expect(statusOf(store.get("ses_test")!)).toBe("waiting")
    applyEvent(store, event("permission.replied", { sessionID: "ses_test", requestID: "perm_1", reply: "once" }))
    expect(statusOf(store.get("ses_test")!)).toBe("running")
  })

  test("failed terminal state outranks running until a new run succeeds", () => {
    const store = snapshot([session()])
    applyEvent(store, event("session.execution.started", { sessionID: "ses_test" }))
    applyEvent(store, event("session.execution.failed", { sessionID: "ses_test" } as never))
    expect(statusOf(store.get("ses_test")!)).toBe("error")
    applyEvent(store, event("session.execution.started", { sessionID: "ses_test" }))
    expect(statusOf(store.get("ses_test")!)).toBe("error")
    applyEvent(store, event("session.execution.succeeded", { sessionID: "ses_test" }))
    expect(statusOf(store.get("ses_test")!)).toBe("ready")
  })

  test("succeeded without later user input is ready; a later prompt engages", () => {
    const store = snapshot([session()])
    applyEvent(store, event("session.execution.succeeded", { sessionID: "ses_test" }))
    expect(statusOf(store.get("ses_test")!)).toBe("ready")
    applyEvent(
      store,
      event("session.inbox.enqueued", { sessionID: "ses_test", inboxID: "msg_1", item: { type: "user" } } as never),
    )
    expect(statusOf(store.get("ses_test")!)).toBe("idle")
  })

  test("snapshot seeds outcome and viewed state", () => {
    const store = snapshot([
      session({ id: "a", outcome: "succeeded", time: { created: 1, updated: 2, idle: 10, viewed: 5 } }),
      session({ id: "b", outcome: "succeeded", time: { created: 1, updated: 2, idle: 10, viewed: 12 } }),
      session({ id: "c", outcome: "failed", time: { created: 1, updated: 2 } }),
    ])
    expect(statusOf(store.get("a")!)).toBe("ready")
    expect(statusOf(store.get("b")!)).toBe("idle")
    expect(statusOf(store.get("c")!)).toBe("error")
  })

  test("seeded permissions wait and global sentinel never attributes", () => {
    const store = snapshot([session()])
    seedWaiting(store, [
      { id: "perm_9", sessionID: "ses_test" },
      { id: "perm_x", sessionID: "global" },
    ])
    expect(statusOf(store.get("ses_test")!)).toBe("waiting")
    expect(store.has("global")).toBe(false)
    applyEvent(store, event("permission.asked", { id: "perm_g", sessionID: "global" } as never))
    expect(store.has("global")).toBe(false)
  })

  test("form lifecycle waits until replied or cancelled", () => {
    const store = snapshot([session()])
    applyEvent(store, event("form.created", { form: { id: "form_1", sessionID: "ses_test" } } as never))
    expect(statusOf(store.get("ses_test")!)).toBe("waiting")
    applyEvent(store, event("form.replied", { id: "form_1", sessionID: "ses_test", answer: {} } as never))
    expect(statusOf(store.get("ses_test")!)).toBe("idle")
  })

  test("roster follows created, renamed, moved, deleted", () => {
    const store = snapshot([])
    applyEvent(
      store,
      event("session.created", {
        sessionID: "ses_new",
        projectID: "proj_test",
        location: { directory: "/a" },
        title: "hello",
      } as never),
    )
    expect(store.get("ses_new")?.directory).toBe("/a")
    applyEvent(store, event("session.renamed", { sessionID: "ses_new", title: "bye" }))
    applyEvent(
      store,
      event("session.moved", { sessionID: "ses_new", location: { directory: "/b" }, projectID: "proj2" } as never),
    )
    const moved = store.get("ses_new")!
    expect(moved.title).toBe("bye")
    expect(moved.directory).toBe("/b")
    expect(moved.projectID).toBe("proj2")
    applyEvent(store, event("session.deleted", { sessionID: "ses_new" }))
    expect(store.has("ses_new")).toBe(false)
  })

  test("unknown event types are ignored", () => {
    const store = snapshot([session()])
    applyEvent(store, { id: "evt_x", created: 3, type: "session.something.new", data: {} } as never)
    expect(statusOf(store.get("ses_test")!)).toBe("idle")
  })

  test("toJSON carries computed statuses", () => {
    const store = snapshot([session({ id: "a" }), session({ id: "b" })])
    applyEvent(store, event("session.execution.started", { sessionID: "a" }))
    const json = toJSON(store)
    expect(json.sessions.find((item) => item.id === "a")?.status).toBe("running")
    expect(json.sessions.find((item) => item.id === "b")?.status).toBe("idle")
    expect(typeof json.generatedAt).toBe("number")
  })
})
