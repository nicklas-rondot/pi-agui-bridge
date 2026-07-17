# Pi AG-UI Bridge API

## Base URL

Default direct-local address:

```text
http://127.0.0.1:4315
```

When the bridge is behind Tailscale Serve or another reverse proxy, `/health` and `/pair` advertise either:

- `PI_AGUI_BRIDGE_PUBLIC_URL` when set (absolute `http(s)` URL, no query string or fragment)
- otherwise the request-visible host/protocol inferred from proxy headers when available

## Auth model

- `POST /pair` requires local Pi approval, not a bearer token.
- `/state`, `/events`, and `/agent` require a bearer token returned by pairing.
- Tokens are origin-bound.

Use either:

- `Authorization: Bearer <token>`
- or `?token=<token>` for SSE convenience

## Endpoints

### `GET /health`

Response:

```json
{
  "ok": true,
  "bridgeName": "pi-agui-bridge",
  "bridgeVersion": "0.1.0",
  "protocolVersion": "0.1.0",
  "host": "127.0.0.1",
  "port": 4315,
  "url": "http://127.0.0.1:4315",
  "pairedOriginCount": 0,
  "isStreaming": false,
  "sessionId": "...",
  "threadId": "..."
}
```

### `POST /pair`

The returned URLs use the same advertised base URL as `/health`.

Request:

```json
{
  "clientName": "Pathset Web"
}
```

Response:

```json
{
  "ok": true,
  "token": "...",
  "expiresAt": 1760000000000,
  "origin": "https://app.example.com",
  "bridgeUrl": "http://127.0.0.1:4315",
  "agentUrl": "http://127.0.0.1:4315/agent",
  "stateUrl": "http://127.0.0.1:4315/state",
  "eventsUrl": "http://127.0.0.1:4315/events",
  "protocolVersion": "0.1.0"
}
```

### `GET /state`

Response:

```json
{
  "protocolVersion": "0.1.0",
  "bridgeName": "pi-agui-bridge",
  "bridgeVersion": "0.1.0",
  "threadId": "...",
  "sessionId": "...",
  "sessionFile": "/.../session.jsonl",
  "sessionName": "...",
  "cwd": "/path/to/project",
  "isStreaming": false,
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-4-20250514",
    "name": "Claude Sonnet 4"
  },
  "thinkingLevel": "medium",
  "messages": [
    {
      "id": "entry-id",
      "role": "user",
      "text": "hello",
      "content": "hello",
      "timestamp": 1760000000000
    }
  ],
  "updatedAt": 1760000000000
}
```

### `GET /events`

Authenticated passive SSE stream.

Current payloads are mostly:

- `state_snapshot`

### `POST /agent`

Authenticated SSE run endpoint.

Minimal request:

```json
{
  "message": "Inspect the repo and summarize the auth architecture"
}
```

Alternative request:

```json
{
  "threadId": "thread_123",
  "runId": "run_123",
  "messages": [
    { "role": "user", "content": "Inspect the repo and summarize the auth architecture" }
  ]
}
```

If Pi is busy, you can queue a prompt:

```json
{
  "message": "After that, summarize the auth architecture",
  "streamingBehavior": "followUp"
}
```

## SSE event contract

Each frame is sent as:

```text
data: {json}\n\n
```

### Core events

#### `run_started`

```json
{
  "type": "run_started",
  "threadId": "thread_123",
  "runId": "run_123"
}
```

#### `text_message_start`

```json
{
  "type": "text_message_start",
  "messageId": "msg_1",
  "role": "assistant"
}
```

#### `text_message_content`

```json
{
  "type": "text_message_content",
  "messageId": "msg_1",
  "delta": "Hello"
}
```

#### `text_message_end`

```json
{
  "type": "text_message_end",
  "messageId": "msg_1"
}
```

#### `tool_call_start`

```json
{
  "type": "tool_call_start",
  "toolCallId": "call_1",
  "toolCallName": "read",
  "parentMessageId": "msg_1"
}
```

#### `tool_call_args`

```json
{
  "type": "tool_call_args",
  "toolCallId": "call_1",
  "delta": "{\"path\":\"README.md\"}"
}
```

#### `tool_call_end`

```json
{
  "type": "tool_call_end",
  "toolCallId": "call_1"
}
```

#### `tool_call_result`

```json
{
  "type": "tool_call_result",
  "toolCallId": "call_1",
  "content": [{ "type": "text", "text": "..." }],
  "isError": false
}
```

#### `messages_snapshot`

```json
{
  "type": "messages_snapshot",
  "messages": []
}
```

#### `state_snapshot`

```json
{
  "type": "state_snapshot",
  "state": { "threadId": "..." }
}
```

#### `run_finished`

```json
{
  "type": "run_finished",
  "threadId": "thread_123",
  "runId": "run_123"
}
```

#### `run_error`

```json
{
  "type": "run_error",
  "threadId": "thread_123",
  "runId": "run_123",
  "message": "Pi is busy"
}
```

### Custom events

#### `bridge_request_received`
Bridge accepted the HTTP request.

#### `bridge_run_queued`
Bridge queued the prompt while Pi was already streaming.

#### `bridge_prompt_accepted`
Pi accepted the extension-originated user prompt.

#### `pi_thinking_delta`
Streaming Pi thinking text.

#### `pi_tool_execution_update`
Streaming partial tool progress.

#### `pi_message_error`
Pi surfaced an assistant-message stream error.
