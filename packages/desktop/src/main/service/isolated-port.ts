import { connect, type Socket } from "node:net"
import { Option, Schema } from "effect"

// The isolated dev server binds a fixed port (see ISOLATED_PORT): the bind is
// the mutual-exclusion lock that keeps a second contender from booting another
// sidecar against the same userData database. Probing first turns the bind
// race into a fast, explainable failure instead of a spawned contender that
// dies with a misleading managed-service error.
export const ISOLATED_PORT = 0x0c0c

export type IsolatedPortProbe =
  | { readonly status: "free" }
  | { readonly status: "occupied"; readonly kind: "sidecar"; readonly version?: string }
  | { readonly status: "occupied"; readonly kind: "unknown" }

const SidecarInfo = Schema.Struct({
  version: Schema.String,
  pid: Schema.Int,
})

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(SidecarInfo))

export function probeIsolatedPort(host: string, port: number, timeoutMs = 1500): Promise<IsolatedPortProbe> {
  return new Promise((resolve) => {
    let settled = false
    let received = Buffer.alloc(0)

    const settle = (result: IsolatedPortProbe) => {
      if (settled) return
      settled = true

      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    // A bound port that never answers still defeats our bind, so a deadline
    // reports occupied-unknown rather than hanging the launch.
    const timer = setTimeout(() => settle(classify(received)), timeoutMs)
    const socket: Socket = connect({ host, port })

    socket.once("error", (error: Error) => {
      settle(isRefused(error) ? { status: "free" } : { status: "occupied", kind: "unknown" })
    })

    socket.once("connect", () => {
      socket.write("GET /api/info HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
    })

    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
    })

    socket.once("end", () => settle(classify(received)))

    socket.once("close", () => settle(classify(received)))
  })
}

function isRefused(error: Error): boolean {
  return "code" in error && error.code === "ECONNREFUSED"
}

function classify(received: Buffer): IsolatedPortProbe {
  const text = received.toString("utf8")
  const head = text.split("\r\n\r\n", 1)[0] ?? ""
  const status = head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1]

  if (status === undefined) return { status: "occupied", kind: "unknown" }

  if (status === "401") return { status: "occupied", kind: "sidecar" }

  if (status === "200") {
    const body = text.slice(head.length + 4)
    const info = Option.getOrUndefined(decodeInfo(body))

    if (info !== undefined) return { status: "occupied", kind: "sidecar", version: info.version }
  }

  return { status: "occupied", kind: "unknown" }
}

export function describeIsolatedPortConflict(
  probe: Extract<IsolatedPortProbe, { status: "occupied" }>,
  platform: NodeJS.Platform = process.platform,
): string {
  const holder =
    probe.kind === "sidecar"
      ? `another OpenCode background service${probe.version ? ` (version ${probe.version})` : ""}`
      : "another process"

  const lookup = platform === "win32" ? `Get-NetTCPConnection -LocalPort ${ISOLATED_PORT}` : `lsof -i :${ISOLATED_PORT}`

  return (
    `Dev background service port ${ISOLATED_PORT} is already in use by ${holder}. ` +
    `Only one dev session can own this port: quit the other dev window, or stop the process holding it ` +
    `(${lookup}), then relaunch. ` +
    "Note: `opencode service set port` only affects the shared background service, not the dev server's fixed port."
  )
}
