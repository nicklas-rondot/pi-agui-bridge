# Pi AG-UI Bridge

A Pi package that exposes a localhost HTTP/SSE bridge for a web app, with optional reverse-proxy/Tailscale-friendly public URL advertising.

## What it does

- starts a local HTTP server when a Pi session starts
- binds to `127.0.0.1` by default
- can advertise a public/proxied base URL for `/health` and `/pair`
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
- `PI_AGUI_BRIDGE_PUBLIC_URL` - absolute `http(s)` URL to advertise to clients; optional, no query string or fragment

If `PI_AGUI_BRIDGE_PUBLIC_URL` is unset, the bridge keeps the current direct-local behavior and will also try to infer the request-visible base URL from `Host`, `Forwarded`, and `X-Forwarded-*` headers when it is behind a reverse proxy.

## Pairing flow

1. Browser calls `POST /pair`
2. Pi shows a local approval prompt
3. If approved, bridge returns a short-lived bearer token
4. Browser uses that token for `/state`, `/events`, and `/agent`

Tokens are currently in-memory and origin-bound.
A fresh Pi session restart requires re-pairing.

## Tailscale Serve example

Keep the bridge local and let Tailscale publish it:

```bash
export PI_AGUI_BRIDGE_HOST=127.0.0.1
export PI_AGUI_BRIDGE_PORT=4315
export PI_AGUI_BRIDGE_PUBLIC_URL=https://your-node.your-tailnet.ts.net

# start pi with the extension, then on the same machine:
tailscale serve 4315
```

Notes:

- leaving `PI_AGUI_BRIDGE_HOST=127.0.0.1` keeps the bridge off your LAN
- `PI_AGUI_BRIDGE_PUBLIC_URL` makes `/health` and `/pair` return the remote HTTPS URL instead of the local `127.0.0.1` URL
- if your proxy already forwards the public host/protocol headers correctly, `PI_AGUI_BRIDGE_PUBLIC_URL` is optional

## Route summary

### `GET /health`
No auth required.
Returns the advertised endpoint URL for the caller: local by default, or the public/proxied URL when configured/detected.

### `POST /pair`
No auth required, but requires local Pi approval.
Returned endpoint URLs follow the same advertised base URL behavior as `/health`.

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
- frontend should use a thin custom connector first rather than assuming full assistant-ui AG-UI compatibility; relative URLs are the safest option when talking to the bridge through a proxy
- queued runs are best-effort and assume the bridge is the main source of extension-originated prompts

## Docs

See `docs/bridge-api.md`.
