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

## Frontend integration contract

If you are building a browser client or asking another LLM to build one, implement this exact flow:

1. choose a bridge base URL
   - local: `http://127.0.0.1:4315`
   - Tailscale/proxy: the remote HTTPS URL
2. call `POST /pair` from the browser
3. store the returned bearer token in memory
4. call `GET /state` with `Authorization: Bearer <token>`
5. subscribe to `GET /events?token=<token>` with `EventSource`
6. call `POST /agent` with `Authorization: Bearer <token>`
7. if you get `401`/`403`, or Pi restarts, pair again

Important browser/auth rules:

- tokens are origin-bound to the browser origin that called `/pair`
- `GET /state` and `POST /agent` should use `Authorization: Bearer <token>`
- `GET /events` may use either bearer auth or `?token=...`, but `?token=...` is the easiest browser `EventSource` path because native `EventSource` does not let you set custom headers
- `POST /pair` should be called from the same frontend origin that will later call `/state`, `/events`, and `/agent`
- the token is in-memory only on the bridge; a fresh Pi session restart requires re-pairing
- once your app has chosen a base URL, prefer calling relative routes on that base URL rather than hard-coding the returned absolute URLs

Common auth failures:

- `401 Missing bearer token.`
- `401 Invalid or expired token.`
- `400 Invalid Origin header.`
- `403 Token is not valid for origin <origin>.`

Minimal browser example:

```js
const baseUrl = "https://your-node.your-tailnet.ts.net";

export async function pairBridge(clientName = "Pathset Web") {
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientName }),
  });

  if (!response.ok) {
    throw new Error(`Pair failed: ${response.status}`);
  }

  return response.json();
}

export async function getBridgeState(token) {
  const response = await fetch(`${baseUrl}/state`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`State failed: ${response.status}`);
  }

  return response.json();
}

export function openBridgeEvents(token) {
  return new EventSource(`${baseUrl}/events?token=${encodeURIComponent(token)}`);
}

export async function runAgent(token, body) {
  const response = await fetch(`${baseUrl}/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Agent failed: ${response.status}`);
  }

  return response.body;
}
```

For exact response and event payload shapes, see `docs/bridge-api.md` and `src/types.ts`.

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

See:

- `docs/bridge-api.md` for route payloads and SSE event shapes
- `src/types.ts` for the TypeScript contract
- `src/auth.ts` for origin-bound token behavior
- `src/server.ts` for route/auth/CORS handling

If you are asking another LLM to implement a client, point it to at least:

- `README.md`
- `docs/bridge-api.md`
- `src/types.ts`
