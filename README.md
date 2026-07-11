# Pi AG-UI Bridge

A Pi package that exposes a localhost HTTP/SSE bridge for a web app.

## What it does

- starts a local HTTP server when a Pi session starts
- binds to `127.0.0.1` by default
- supports browser pairing with local approval in Pi
- exposes:
  - `GET /health`
  - `POST /pair`
  - `GET /state`
  - `GET /events`
  - `POST /agent`
- streams AG-UI-style SSE events for assistant text and tool execution

## Install in Pi

```bash
pi install /absolute/path/to/pi-agui-bridge
```

Or for one-off testing:

```bash
pi -e /absolute/path/to/pi-agui-bridge/src/index.ts
```

## Default address

```text
http://127.0.0.1:4315
```

Override with:

- `PI_AGUI_BRIDGE_HOST`
- `PI_AGUI_BRIDGE_PORT`

## Pairing flow

1. Browser calls `POST /pair`
2. Pi shows a local approval prompt
3. If approved, bridge returns a short-lived bearer token
4. Browser uses that token for `/state`, `/events`, and `/agent`

Tokens are currently in-memory and origin-bound.
A fresh Pi session restart requires re-pairing.

## Route summary

### `GET /health`
No auth required.

### `POST /pair`
No auth required, but requires local Pi approval.

Request:

```json
{
  "clientName": "Pathset Web"
}
```

### `GET /state`
Bearer token required.
Returns the current Pi-thread snapshot.

### `GET /events?token=...`
Bearer token or query token required.
Returns passive SSE `state_snapshot` updates.

### `POST /agent`
Bearer token required.
Returns SSE for a single run.

Request body:

```json
{
  "threadId": "optional-thread-id",
  "runId": "optional-run-id",
  "message": "Help me refactor auth",
  "streamingBehavior": "followUp"
}
```

You can also send:

```json
{
  "messages": [
    { "role": "user", "content": "Help me refactor auth" }
  ]
}
```

## SSE event types

Implemented core events:

- `run_started`
- `run_finished`
- `run_error`
- `text_message_start`
- `text_message_content`
- `text_message_end`
- `tool_call_start`
- `tool_call_args`
- `tool_call_end`
- `tool_call_result`
- `state_snapshot`
- `messages_snapshot`
- `custom`

Custom bridge-specific events include:

- `bridge_request_received`
- `bridge_run_queued`
- `bridge_prompt_accepted`
- `pi_thinking_delta`
- `pi_tool_execution_update`
- `pi_message_error`

## Pi commands

- `/agui-bridge-info`
- `/agui-bridge-reset-auth`

## Current limitations

- one active controlling browser flow is the intended v1 model
- tokens are not persisted across Pi restarts
- frontend should use a thin custom connector first rather than assuming full assistant-ui AG-UI compatibility
- queued runs are best-effort and assume the bridge is the main source of extension-originated prompts

## Docs

See `docs/bridge-api.md`.
