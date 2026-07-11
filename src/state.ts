import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BridgeMessageSnapshot, BridgeStateSnapshot } from "./types.js";
import { BRIDGE_NAME, BRIDGE_PROTOCOL_VERSION, BRIDGE_VERSION } from "./types.js";

type SessionEntryWithMessage = {
  id: string;
  type: string;
  message?: Record<string, any>;
};

export function buildBridgeState(ctx: ExtensionContext, isStreaming: boolean): BridgeStateSnapshot {
  const entries = ctx.sessionManager.getBranch();
  const messages = entries
    .filter((entry): entry is SessionEntryWithMessage => entry.type === "message")
    .map((entry) => serializeSessionMessage(entry.id, entry.message ?? {}));

  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getHeader()?.id ?? sessionFile ?? "session";
  const threadId = ctx.sessionManager.getLeafId() ?? sessionId;

  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    bridgeName: BRIDGE_NAME,
    bridgeVersion: BRIDGE_VERSION,
    threadId,
    sessionId,
    sessionFile,
    sessionName: ctx.sessionManager.getSessionName(),
    cwd: ctx.cwd,
    isStreaming,
    model: ctx.model
      ? {
          provider: (ctx.model as { provider?: string }).provider,
          id: (ctx.model as { id?: string }).id,
          name: (ctx.model as { name?: string }).name,
        }
      : undefined,
    messages,
    updatedAt: Date.now(),
  };
}

export function serializeSessionMessage(id: string, message: Record<string, any>): BridgeMessageSnapshot {
  return {
    id,
    role: String(message.role ?? "unknown"),
    text: flattenMessageText(message),
    content: message.content,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
    toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
    isError: typeof message.isError === "boolean" ? message.isError : undefined,
  };
}

export function flattenMessageText(message: Record<string, any>): string {
  return flattenContent(message.content);
}

export function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      const typedBlock = block as Record<string, any>;
      switch (typedBlock.type) {
        case "text":
          return typeof typedBlock.text === "string" ? typedBlock.text : "";
        case "thinking":
          return typeof typedBlock.thinking === "string" ? typedBlock.thinking : "";
        case "toolCall":
          return typedBlock.name ? `[tool:${typedBlock.name}]` : "[tool]";
        case "image":
          return "[image]";
        default:
          return typeof typedBlock.text === "string" ? typedBlock.text : "";
      }
    })
    .filter(Boolean)
    .join("");
}

export function getLatestUserTextFromRequest(body: { message?: string; messages?: Array<{ role: string; content: unknown }> }): string | undefined {
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
  }

  if (!Array.isArray(body.messages)) {
    return undefined;
  }

  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (!message || message.role !== "user") continue;
    const text = flattenContent(message.content).trim();
    if (text) return text;
  }

  return undefined;
}
