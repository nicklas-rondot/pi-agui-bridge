export const BRIDGE_NAME = "pi-agui-bridge";
export const BRIDGE_VERSION = "0.1.0";
export const BRIDGE_PROTOCOL_VERSION = "0.1.0";
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_PORT = 4315;
export const DEFAULT_PAIRING_TIMEOUT_MS = 120_000;
export const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export interface BridgeMessageSnapshot {
  id: string;
  role: string;
  text: string;
  content: unknown;
  timestamp?: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
}

export interface BridgeStateSnapshot {
  protocolVersion: string;
  bridgeName: string;
  bridgeVersion: string;
  threadId: string;
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  isStreaming: boolean;
  model?: {
    provider?: string;
    id?: string;
    name?: string;
  };
  thinkingLevel?: string;
  messages: BridgeMessageSnapshot[];
  updatedAt: number;
}

export interface BridgeHealthResponse {
  ok: true;
  bridgeName: string;
  bridgeVersion: string;
  protocolVersion: string;
  host: string;
  port: number;
  url: string;
  pairedOriginCount: number;
  isStreaming: boolean;
  sessionId?: string;
  threadId?: string;
}

export interface PairRequestBody {
  origin?: string;
  clientName?: string;
}

export interface PairResponseBody {
  ok: true;
  token: string;
  expiresAt: number;
  origin: string;
  bridgeUrl: string;
  agentUrl: string;
  stateUrl: string;
  eventsUrl: string;
  protocolVersion: string;
}

export interface AgentRequestMessage {
  id?: string;
  role: string;
  content: unknown;
}

export interface AgentRequestBody {
  threadId?: string;
  runId?: string;
  message?: string;
  messages?: AgentRequestMessage[];
  streamingBehavior?: "steer" | "followUp";
  metadata?: Record<string, unknown>;
}

export interface AuthorizedSession {
  token: string;
  origin: string;
  clientName?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthValidationResult {
  ok: boolean;
  status: number;
  error?: string;
  session?: AuthorizedSession;
}

export interface SseEventBase {
  type: string;
}

export interface RunStartedEvent extends SseEventBase {
  type: "run_started";
  threadId: string;
  runId: string;
}

export interface RunFinishedEvent extends SseEventBase {
  type: "run_finished";
  threadId: string;
  runId: string;
}

export interface RunErrorEvent extends SseEventBase {
  type: "run_error";
  threadId: string;
  runId: string;
  message: string;
}

export interface TextMessageStartEvent extends SseEventBase {
  type: "text_message_start";
  messageId: string;
  role: "assistant" | "user" | "system" | "developer";
}

export interface TextMessageContentEvent extends SseEventBase {
  type: "text_message_content";
  messageId: string;
  delta: string;
}

export interface TextMessageEndEvent extends SseEventBase {
  type: "text_message_end";
  messageId: string;
}

export interface ToolCallStartEvent extends SseEventBase {
  type: "tool_call_start";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface ToolCallArgsEvent extends SseEventBase {
  type: "tool_call_args";
  toolCallId: string;
  delta: string;
}

export interface ToolCallEndEvent extends SseEventBase {
  type: "tool_call_end";
  toolCallId: string;
}

export interface ToolCallResultEvent extends SseEventBase {
  type: "tool_call_result";
  toolCallId: string;
  content: unknown;
  isError?: boolean;
}

export interface StateSnapshotEvent extends SseEventBase {
  type: "state_snapshot";
  state: BridgeStateSnapshot;
}

export interface MessagesSnapshotEvent extends SseEventBase {
  type: "messages_snapshot";
  messages: BridgeMessageSnapshot[];
}

export interface CustomEvent extends SseEventBase {
  type: "custom";
  name: string;
  value: unknown;
}

export type BridgeSseEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | MessagesSnapshotEvent
  | CustomEvent;
