import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"
import { applyEvent, seedWaiting, snapshot, toJSON } from "./status"

const handler = Effect.fn("cli.session.watch")(function* (
  input: Runtime.Input<typeof Commands.commands.session.commands.watch>,
) {
  const server = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
  })
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  const store = snapshot(
    (
      yield* Effect.tryPromise({
        try: (signal) => client.session.list({ parentID: null, order: "desc", limit: 500 }, { signal }),
        catch: (cause) => cause,
      })
    ).data,
  )
  const open = yield* Effect.tryPromise({
    try: (signal) => client.permission.request.list({}, { signal }),
    catch: (cause) => cause,
  })
  seedWaiting(
    store,
    open.data.map((request) => ({ id: request.id, sessionID: request.sessionID })),
  )
  if (input.once) {
    process.stdout.write(JSON.stringify(toJSON(store), null, 2) + EOL)
    return
  }
  const http = Bun.serve({
    port: input.port,
    fetch: () => Response.json(toJSON(store)),
  })
  process.stderr.write(`watching ${store.size} sessions at http://127.0.0.1:${http.port}${EOL}`)
  const events = client.event.subscribe()[Symbol.asyncIterator]()
  yield* Effect.forever(
    Effect.tryPromise({ try: () => events.next(), catch: (cause) => cause }).pipe(
      Effect.flatMap((result) =>
        result.done
          ? Effect.fail(new Error("Event stream disconnected"))
          : Effect.sync(() => applyEvent(store, result.value)),
      ),
    ),
  )
})

export default Runtime.handler(Commands.commands.session.commands.watch, (input) =>
  handler(input).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  ),
)
