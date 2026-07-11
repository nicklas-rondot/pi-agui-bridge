import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AuthManager, normalizeOrigin } from "./auth.js";
import { HttpError, type BridgeServerHandlers, BridgeHttpServer, SseChannel } from "./server.js";
import { buildBridgeState, getLatestUserTextFromRequest } from "./state.js";
import type {
  AgentRequestBody,
  AuthValidationResult,
  BridgeHealthResponse,
  BridgeStateSnapshot,
  PairRequestBody,
  PairResponseBody,
} from "./types.js";
import {
  BRIDGE_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_VERSION,
  DEFAULT_BRIDGE_HOST,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_PAIRING_TIMEOUT_MS,
  DEFAULT_TOKEN_TTL_MS,
} from "./types.js";

interface PendingRun {
  id: string;
  threadId: string;
  runId: string;
  promptText: string;
  channel: SseChannel;
  streamingBehavior?: "steer" | "followUp";
  accepted: boolean;
  started: boolean;
  queuedAt: number;
  assistantMessageId?: string;
  assistantMessageOpen: boolean;
}

export class PiAgUiBridge implements BridgeServerHandlers {
  private readonly auth = new AuthManager(DEFAULT_TOKEN_TTL_MS);
  private readonly passiveChannels = new Set<SseChannel>();
  private readonly pendingRuns: PendingRun[] = [];
  private readonly host: string;
  private readonly port: number;
  private listeningHost: string;
  private listeningPort: number;
  private readonly pi: ExtensionAPI;
  private server?: BridgeHttpServer;
  private currentCtx?: ExtensionContext;
  private baseUrl?: string;
  private activeRun?: PendingRun;
  private isStreaming = false;
  private lastThinkingLevel?: string;
  private pairingPromise?: Promise<PairResponseBody>;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.host = process.env.PI_AGUI_BRIDGE_HOST || DEFAULT_BRIDGE_HOST;
    this.port = Number(process.env.PI_AGUI_BRIDGE_PORT || DEFAULT_BRIDGE_PORT);
    this.listeningHost = this.host;
    this.listeningPort = this.port;
    this.lastThinkingLevel = this.safeGetThinkingLevel();
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.currentCtx = ctx;
    this.lastThinkingLevel = this.safeGetThinkingLevel();

    if (this.server) {
      this.broadcastState();
      return;
    }

    this.server = new BridgeHttpServer(this.host, this.port, this);
    const address = await this.server.start();
    this.listeningHost = address.host;
    this.listeningPort = address.port;
    this.baseUrl = address.url;
    this.setStatus(ctx);
    this.broadcastState();
  }

  async stop(): Promise<void> {
    const runsToClose = [...this.pendingRuns];
    this.activeRun = undefined;

    for (const run of runsToClose) {
      this.finishRunWithError(run, "Bridge stopped.");
    }

    for (const channel of this.passiveChannels) {
      channel.close();
    }
    this.passiveChannels.clear();
    this.auth.clear();

    if (this.server) {
      await this.server.stop();
      this.server = undefined;
    }

    this.baseUrl = undefined;
    this.listeningHost = this.host;
    this.listeningPort = this.port;
    this.currentCtx = undefined;
  }

  setContext(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
    this.setStatus(ctx);
  }

  getHealth(): BridgeHealthResponse {
    const state = this.getState();
    return {
      ok: true,
      bridgeName: BRIDGE_NAME,
      bridgeVersion: BRIDGE_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      host: this.listeningHost,
      port: this.listeningPort,
      url: this.requireBaseUrl(),
      pairedOriginCount: this.auth.count(),
      isStreaming: state.isStreaming,
      sessionId: state.sessionId,
      threadId: state.threadId,
    };
  }

  async pair(origin: string | undefined, body: PairRequestBody): Promise<PairResponseBody> {
    if (this.pairingPromise) {
      return this.pairingPromise;
    }

    const normalizedOrigin = normalizeOrigin(body.origin ?? origin);
    if (!normalizedOrigin) {
      throw new HttpError(400, "A valid browser origin is required for pairing.");
    }

    const ctx = this.requireContext();
    if (!ctx.hasUI) {
      throw new HttpError(503, "Pairing requires a Pi UI session so the user can approve access.");
    }

    this.pairingPromise = (async () => {
      const approved = await ctx.ui.confirm(
        "Allow web app access?",
        [
          `Origin: ${normalizedOrigin}`,
          body.clientName ? `Client: ${body.clientName}` : undefined,
          "",
          "This will allow the browser app to read chat history, send prompts, and stream tool output from this Pi session until the token expires.",
        ]
          .filter(Boolean)
          .join("\n"),
        { timeout: DEFAULT_PAIRING_TIMEOUT_MS },
      );

      if (!approved) {
        throw new HttpError(403, "Pairing was denied.");
      }

      const session = this.auth.issue(normalizedOrigin, body.clientName);
      return {
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        origin: session.origin,
        bridgeUrl: this.requireBaseUrl(),
        agentUrl: `${this.requireBaseUrl()}/agent`,
        stateUrl: `${this.requireBaseUrl()}/state`,
        eventsUrl: `${this.requireBaseUrl()}/events`,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
      };
    })();

    try {
      return await this.pairingPromise;
    } finally {
      this.pairingPromise = undefined;
    }
  }

  getState(): BridgeStateSnapshot {
    const ctx = this.requireContext();
    const state = buildBridgeState(ctx, this.isStreaming);
    state.thinkingLevel = this.lastThinkingLevel;
    return state;
  }

  authorize(origin: string | undefined, token: string | undefined): AuthValidationResult {
    return this.auth.validate(token, origin);
  }

  openEventsStream(channel: SseChannel): void {
    this.passiveChannels.add(channel);
    channel.onClose(() => this.passiveChannels.delete(channel));
    channel.send({ type: "state_snapshot", state: this.getState() });
  }

  async handleAgentRequest(body: AgentRequestBody, channel: SseChannel): Promise<void> {
    const promptText = getLatestUserTextFromRequest(body);
    const state = this.getState();
    const threadId = body.threadId || state.threadId;
    const runId = body.runId || randomUUID();

    if (!promptText) {
      channel.send({
        type: "run_error",
        threadId,
        runId,
        message: "Request must include a user message.",
      });
      channel.close();
      return;
    }

    if (this.isStreaming && !body.streamingBehavior) {
      channel.send({
        type: "run_error",
        threadId,
        runId,
        message: "Pi is busy. Retry later or provide streamingBehavior: 'steer' | 'followUp'.",
      });
      channel.close();
      return;
    }

    const run: PendingRun = {
      id: randomUUID(),
      threadId,
      runId,
      promptText,
      channel,
      streamingBehavior: body.streamingBehavior,
      accepted: false,
      started: false,
      queuedAt: Date.now(),
      assistantMessageOpen: false,
    };

    this.pendingRuns.push(run);
    channel.onClose(() => this.removeRun(run.id));
    channel.send({ type: "state_snapshot", state });
    channel.send({
      type: "custom",
      name: "bridge_request_received",
      value: {
        threadId,
        runId,
        queued: this.isStreaming,
        streamingBehavior: body.streamingBehavior,
      },
    });

    try {
      if (this.isStreaming && body.streamingBehavior) {
        this.pi.sendUserMessage(promptText, { deliverAs: body.streamingBehavior });
        channel.send({
          type: "custom",
          name: "bridge_run_queued",
          value: { threadId, runId, mode: body.streamingBehavior },
        });
      } else {
        this.pi.sendUserMessage(promptText);
      }
    } catch (error) {
      this.finishRunWithError(run, error instanceof Error ? error.message : "Failed to send prompt.");
    }
  }

  handleEvent(event: { type: string; [key: string]: any }, ctx: ExtensionContext): void {
    this.currentCtx = ctx;

    switch (event.type) {
      case "session_start":
      case "session_tree":
      case "session_compact":
        this.lastThinkingLevel = this.safeGetThinkingLevel();
        this.broadcastState();
        return;
      case "input":
        this.handleInputEvent(event);
        return;
      case "agent_start":
        this.isStreaming = true;
        this.startNextAcceptedRun();
        this.broadcastState();
        return;
      case "agent_end":
        this.isStreaming = false;
        this.finishActiveRun();
        this.broadcastState();
        return;
      case "message_start":
        this.handleMessageStart(event);
        return;
      case "message_update":
        this.handleMessageUpdate(event);
        return;
      case "message_end":
        this.handleMessageEnd(event);
        this.broadcastState();
        return;
      case "tool_execution_start":
        this.handleToolExecutionStart(event);
        return;
      case "tool_execution_update":
        this.handleToolExecutionUpdate(event);
        return;
      case "tool_execution_end":
        this.handleToolExecutionEnd(event);
        return;
      case "model_select":
        this.broadcastState();
        return;
      case "thinking_level_select":
        this.lastThinkingLevel = event.level;
        this.broadcastState();
        return;
      default:
        return;
    }
  }

  describe(): string {
    const baseUrl = this.baseUrl ?? "not-started";
    return `${baseUrl} | paired origins: ${this.auth.count()} | streaming: ${this.isStreaming ? "yes" : "no"}`;
  }

  resetAuth(): void {
    this.auth.clear();
  }

  private handleInputEvent(event: { source?: string; text?: string }): void {
    if (event.source !== "extension" || typeof event.text !== "string") {
      return;
    }

    const run = this.pendingRuns.find((candidate) => !candidate.accepted && candidate.promptText === event.text);
    if (!run) return;

    run.accepted = true;
    run.channel.send({
      type: "custom",
      name: "bridge_prompt_accepted",
      value: { threadId: run.threadId, runId: run.runId },
    });
  }

  private startNextAcceptedRun(): void {
    if (this.activeRun) {
      return;
    }

    const run = this.pendingRuns.find((candidate) => candidate.accepted && !candidate.started) ?? this.pendingRuns.find((candidate) => !candidate.started);
    if (!run) {
      return;
    }

    run.started = true;
    this.activeRun = run;
    run.channel.send({ type: "run_started", threadId: run.threadId, runId: run.runId });
  }

  private handleMessageStart(event: { message?: { role?: string } }): void {
    if (!this.activeRun || event.message?.role !== "assistant") {
      return;
    }

    this.activeRun.assistantMessageId = randomUUID();
    this.activeRun.assistantMessageOpen = true;
    this.activeRun.channel.send({
      type: "text_message_start",
      messageId: this.activeRun.assistantMessageId,
      role: "assistant",
    });
  }

  private handleMessageUpdate(event: { assistantMessageEvent?: { type?: string; delta?: string; message?: string } }): void {
    if (!this.activeRun || !this.activeRun.assistantMessageId) {
      return;
    }

    const update = event.assistantMessageEvent;
    if (!update || typeof update.type !== "string") {
      return;
    }

    if (update.type === "text_delta" && typeof update.delta === "string") {
      this.activeRun.channel.send({
        type: "text_message_content",
        messageId: this.activeRun.assistantMessageId,
        delta: update.delta,
      });
      return;
    }

    if (update.type === "thinking_delta" && typeof update.delta === "string") {
      this.activeRun.channel.send({
        type: "custom",
        name: "pi_thinking_delta",
        value: {
          messageId: this.activeRun.assistantMessageId,
          delta: update.delta,
        },
      });
      return;
    }

    if (update.type === "error") {
      this.activeRun.channel.send({
        type: "custom",
        name: "pi_message_error",
        value: update,
      });
    }
  }

  private handleMessageEnd(event: { message?: { role?: string } }): void {
    if (!this.activeRun || event.message?.role !== "assistant") {
      return;
    }

    if (this.activeRun.assistantMessageId && this.activeRun.assistantMessageOpen) {
      this.activeRun.channel.send({
        type: "text_message_end",
        messageId: this.activeRun.assistantMessageId,
      });
    }

    this.activeRun.assistantMessageOpen = false;
    this.activeRun.assistantMessageId = undefined;
  }

  private handleToolExecutionStart(event: { toolCallId?: string; toolName?: string; args?: unknown }): void {
    if (!this.activeRun || typeof event.toolCallId !== "string" || typeof event.toolName !== "string") {
      return;
    }

    this.activeRun.channel.send({
      type: "tool_call_start",
      toolCallId: event.toolCallId,
      toolCallName: event.toolName,
      parentMessageId: this.activeRun.assistantMessageId,
    });
    this.activeRun.channel.send({
      type: "tool_call_args",
      toolCallId: event.toolCallId,
      delta: JSON.stringify(event.args ?? {}),
    });
    this.activeRun.channel.send({
      type: "tool_call_end",
      toolCallId: event.toolCallId,
    });
  }

  private handleToolExecutionUpdate(event: { toolCallId?: string; toolName?: string; partialResult?: unknown }): void {
    if (!this.activeRun) {
      return;
    }

    this.activeRun.channel.send({
      type: "custom",
      name: "pi_tool_execution_update",
      value: {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      },
    });
  }

  private handleToolExecutionEnd(event: { toolCallId?: string; result?: { content?: unknown }; isError?: boolean }): void {
    if (!this.activeRun || typeof event.toolCallId !== "string") {
      return;
    }

    this.activeRun.channel.send({
      type: "tool_call_result",
      toolCallId: event.toolCallId,
      content: event.result?.content ?? event.result,
      isError: event.isError,
    });
  }

  private finishActiveRun(): void {
    const run = this.activeRun;
    if (!run) return;

    if (run.assistantMessageId && run.assistantMessageOpen) {
      run.channel.send({
        type: "text_message_end",
        messageId: run.assistantMessageId,
      });
    }

    const state = this.getState();
    run.channel.send({ type: "messages_snapshot", messages: state.messages });
    run.channel.send({ type: "state_snapshot", state });
    run.channel.send({ type: "run_finished", threadId: run.threadId, runId: run.runId });
    run.channel.close();
    this.removeRun(run.id);
    this.activeRun = undefined;
  }

  private finishRunWithError(run: PendingRun, message: string): void {
    run.channel.send({
      type: "run_error",
      threadId: run.threadId,
      runId: run.runId,
      message,
    });
    run.channel.close();
    this.removeRun(run.id);
    if (this.activeRun?.id === run.id) {
      this.activeRun = undefined;
    }
  }

  private removeRun(runId: string): void {
    const index = this.pendingRuns.findIndex((run) => run.id === runId);
    if (index >= 0) {
      this.pendingRuns.splice(index, 1);
    }
  }

  private broadcastState(): void {
    const state = this.getState();
    for (const channel of this.passiveChannels) {
      channel.send({ type: "state_snapshot", state });
    }
  }

  private setStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const url = this.baseUrl ?? `http://${this.host}:${this.port}`;
    ctx.ui.setStatus("pi-agui", `AG-UI bridge ${url}`);
  }

  private requireContext(): ExtensionContext {
    if (!this.currentCtx) {
      throw new HttpError(503, "Pi bridge is not attached to an active session yet.");
    }
    return this.currentCtx;
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl) {
      throw new HttpError(503, "Pi bridge has not started yet.");
    }
    return this.baseUrl;
  }

  private safeGetThinkingLevel(): string | undefined {
    try {
      return this.pi.getThinkingLevel();
    } catch {
      return undefined;
    }
  }
}
