# `opencode session watch`

Folds the server SSE event stream (`GET /api/event`) into per-session live
status and serves it as JSON on localhost, for external widgets, taskbar
indicators, and other OS integrations that cannot (or should not) speak the
full OpenCode client protocol.

## Quick start

```sh
# One JSON snapshot and exit (scripting, smoke tests)
opencode session watch --once

# Serve live status; poll GET / from the widget
opencode session watch --port 4097
# watching 3 sessions at http://127.0.0.1:4097
```

Connection follows the normal CLI rules: managed background service by
default, `--server URL` for an explicit server (needs `OPENCODE_PASSWORD`
when that server requires one), `--standalone` for a private server.

## Response shape

`GET /` returns:

```json
{
  "generatedAt": 1791839125716,
  "sessions": [
    {
      "id": "ses_...",
      "title": "Quick greeting",
      "directory": "C:/Users/gpame/Projects/test-project",
      "projectID": "f1bf42e0906fa9bdd9372c55dd159059cc4461d0",
      "status": "ready",
      "updatedAt": 1791809342219
    }
  ]
}
```

`status` is one of `waiting | running | ready | error | idle`, with this
priority: open permission/form requests (`waiting`) outrank a failed terminal
state (`error`), which outranks activity (`running`); a succeeded run with no
later user prompt is `ready`, otherwise `idle`.

## Semantics a widget should know

- **Seeding.** The roster snapshots `session.list` at startup. Waiting state
  seeds from open permission requests; outcome seeds from each session's
  recorded outcome plus its viewed/idle timestamps. Sessions already running
  resolve to `running` on their next event.
- **MCP elicitations are excluded.** Events attributed to the `global`
  sentinel never flip any single session's status.
- **Forward-compatible.** Unknown event types are ignored, so a newer server
  cannot break an older watcher.
- **Volatile stream.** The server drops slow consumers and misses events
  across disconnects; on stream failure the command exits nonzero so a
  supervisor can restart it into a fresh snapshot. Poll at 1–2s intervals;
  do not use this as the transcript source — fetch transcripts via
  `session export` or the message API when the user opens a session.

## Where the logic lives

- Fold (pure, unit-tested): `packages/cli/src/commands/handlers/session/status.ts`
- Handler + HTTP serving: `packages/cli/src/commands/handlers/session/watch.ts`
- Status priority mirrors the desktop tab logic in
  `packages/app/src/shell/layout/project-avatar-state.ts`
  (`needsAttention` → waiting, unseen error → error, busy → running).
- Event vocabulary: `GET /api/event`, schema in
  `packages/schema/src/session-event.ts`, `permission.ts`, `form.ts`.
