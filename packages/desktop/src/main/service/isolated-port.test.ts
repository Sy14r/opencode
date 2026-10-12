import { expect, test } from "bun:test"
import { createServer, type Server, type Socket } from "node:net"
import { describeIsolatedPortConflict, ISOLATED_PORT, probeIsolatedPort } from "./isolated-port"

function listen(respond: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(respond)
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      // SAFETY: a listening TCP socket reports an Address object with a port.
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function freePort(): Promise<number> {
  const { server, port } = await listen(() => {})
  await close(server)

  return port
}

test.each([
  {
    name: "answers 401 like an unauthenticated sidecar",
    respond: (socket: Socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"),
    expected: { status: "occupied", kind: "sidecar" },
  },
  {
    name: "answers versioned JSON like a healthy sidecar",
    respond: (socket: Socket) =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"version":"0.0.0-dev-1","pid":123}'),
    expected: { status: "occupied", kind: "sidecar", version: "0.0.0-dev-1" },
  },
  {
    name: "answers non-JSON from an unrelated occupant",
    respond: (socket: Socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello"),
    expected: { status: "occupied", kind: "unknown" },
  },
  {
    name: "answers bytes that are not HTTP at all",
    respond: (socket: Socket) => socket.end("NOT HTTP\r\n\r\n"),
    expected: { status: "occupied", kind: "unknown" },
  },
  {
    name: "accepts and never answers",
    respond: (_socket: Socket) => {},
    expected: { status: "occupied", kind: "unknown" },
  },
])("probe reports $name", async ({ respond, expected }) => {
  const { server, port } = await listen(respond)

  try {
    expect(await probeIsolatedPort("127.0.0.1", port, 300)).toEqual(expected)
  } finally {
    server.close()
  }
})

test("probe reports a refused port as free", async () => {
  expect(await probeIsolatedPort("127.0.0.1", await freePort(), 300)).toEqual({ status: "free" })
})

test.each([
  { platform: "win32", lookup: "Get-NetTCPConnection -LocalPort 3084" },
  { platform: "darwin", lookup: "lsof -i :3084" },
  { platform: "linux", lookup: "lsof -i :3084" },
] as const)("conflict message on $platform names the port, the lookup, and the fixed-port note", ({
  platform,
  lookup,
}) => {
  const message = describeIsolatedPortConflict({ status: "occupied", kind: "sidecar", version: "0.0.0-dev-1" }, platform)
  expect(message).toContain(`port ${ISOLATED_PORT}`)
  expect(message).toContain(lookup)
  expect(message).toContain("0.0.0-dev-1")
  expect(message).toContain("opencode service set port")
  expect(message).not.toContain("Managed service port")
})

test("conflict message calls a non-sidecar occupant another process", () => {
  const message = describeIsolatedPortConflict({ status: "occupied", kind: "unknown" }, "linux")
  expect(message).toContain("another process")
  expect(message).not.toContain("another OpenCode background service")
})
