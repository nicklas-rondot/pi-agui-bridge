import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extractBearerToken } from "./auth.js";
import type {
  AgentRequestBody,
  AuthValidationResult,
  BridgeHealthResponse,
  BridgeSseEvent,
  BridgeStateSnapshot,
  PairRequestBody,
  PairResponseBody,
} from "./types.js";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SseChannel {
  private closed = false;
  private readonly closeHandlers = new Set<() => void>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly response: ServerResponse) {
    this.response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    this.response.write(": connected\n\n");

    this.heartbeat = setInterval(() => {
      if (!this.closed) {
        this.response.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);

    this.response.on("close", () => this.close());
    this.response.on("error", () => this.close());
  }

  send(event: BridgeSseEvent): void {
    if (this.closed) return;
    this.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const handler of this.closeHandlers) {
      handler();
    }
    this.closeHandlers.clear();
    this.response.end();
  }
}

export interface BridgeRequestContext {
  origin?: string;
  publicBaseUrl: string;
}

export interface BridgeServerHandlers {
  getHealth(requestContext: BridgeRequestContext): BridgeHealthResponse;
  pair(requestContext: BridgeRequestContext, body: PairRequestBody): Promise<PairResponseBody>;
  getState(): BridgeStateSnapshot;
  authorize(origin: string | undefined, token: string | undefined): AuthValidationResult;
  openEventsStream(channel: SseChannel): void;
  handleAgentRequest(body: AgentRequestBody, channel: SseChannel): Promise<void>;
}

export class BridgeHttpServer {
  private server = createServer(this.handleRequest.bind(this));
  private port: number;
  private host: string;
  private readonly handlers: BridgeServerHandlers;

  constructor(host: string, port: number, handlers: BridgeServerHandlers) {
    this.host = host;
    this.port = port;
    this.handlers = handlers;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address() as AddressInfo;
    this.port = address.port;
    this.host = address.address;

    return {
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
    };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const requestContext = buildRequestContext(request, this.host, this.port);
      const url = new URL(request.url ?? "/", requestContext.publicBaseUrl);
      const origin = requestContext.origin;

      if (request.method === "OPTIONS") {
        writeCorsHeaders(response, origin);
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/health" && request.method === "GET") {
        writeCorsHeaders(response, origin);
        writeJson(response, 200, this.handlers.getHealth(requestContext));
        return;
      }

      if (url.pathname === "/pair" && request.method === "POST") {
        writeCorsHeaders(response, origin);
        const body = (await readJsonBody(request)) as PairRequestBody;
        const result = await this.handlers.pair(requestContext, body);
        writeJson(response, 200, result);
        return;
      }

      const token = extractBearerToken(request.headers, url.searchParams.get("token"));
      const authResult = this.handlers.authorize(origin, token);
      writeCorsHeaders(response, origin);

      if (!authResult.ok) {
        writeJson(response, authResult.status, { ok: false, error: authResult.error });
        return;
      }

      if (url.pathname === "/state" && request.method === "GET") {
        writeJson(response, 200, this.handlers.getState());
        return;
      }

      if (url.pathname === "/events" && request.method === "GET") {
        const channel = new SseChannel(response);
        this.handlers.openEventsStream(channel);
        return;
      }

      if (url.pathname === "/agent" && request.method === "POST") {
        const body = (await readJsonBody(request)) as AgentRequestBody;
        const channel = new SseChannel(response);
        await this.handlers.handleAgentRequest(body, channel);
        return;
      }

      writeJson(response, 404, { ok: false, error: `Unknown route: ${request.method} ${url.pathname}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent) {
        writeCorsHeaders(response, normalizeOriginHeader(request.headers.origin));
        writeJson(response, status, { ok: false, error: message });
      } else {
        response.end();
      }
    }
  }
}

function buildRequestContext(request: IncomingMessage, fallbackHost: string, fallbackPort: number): BridgeRequestContext {
  return {
    origin: normalizeOriginHeader(request.headers.origin),
    publicBaseUrl: deriveRequestBaseUrl(request, fallbackHost, fallbackPort),
  };
}

function deriveRequestBaseUrl(request: IncomingMessage, fallbackHost: string, fallbackPort: number): string {
  const fallbackBaseUrl = `http://${fallbackHost}:${fallbackPort}`;
  const forwarded = parseForwardedHeader(getFirstHeaderValue(request.headers.forwarded));
  const protocol =
    normalizeHttpProtocol(getFirstHeaderValue(request.headers["x-forwarded-proto"])) ??
    normalizeHttpProtocol(forwarded.proto) ??
    "http";
  const host =
    getFirstHeaderValue(request.headers["x-forwarded-host"]) ??
    forwarded.host ??
    getFirstHeaderValue(request.headers.host) ??
    `${fallbackHost}:${fallbackPort}`;
  const forwardedPort = getFirstHeaderValue(request.headers["x-forwarded-port"]);

  try {
    const publicUrl = new URL(`${protocol}://${host}`);
    if (!publicUrl.port && forwardedPort) {
      publicUrl.port = forwardedPort;
    }
    return publicUrl.origin;
  } catch {
    return fallbackBaseUrl;
  }
}

function parseForwardedHeader(forwardedHeader: string | undefined): { proto?: string; host?: string } {
  if (!forwardedHeader) {
    return {};
  }

  const firstEntry = forwardedHeader
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);

  if (!firstEntry) {
    return {};
  }

  const result: { proto?: string; host?: string } = {};

  for (const part of firstEntry.split(";")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim().toLowerCase();
    const value = rawValue?.trim().replace(/^"|"$/g, "");
    if (!key || !value) continue;

    if (key === "proto") {
      result.proto = value;
    } else if (key === "host") {
      result.host = value;
    }
  }

  return result;
}

function getFirstHeaderValue(headerValue: string | string[] | undefined): string | undefined {
  const rawValue = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!rawValue) return undefined;

  const firstValue = rawValue
    .split(",")
    .map((value) => value.trim())
    .find(Boolean);

  return firstValue || undefined;
}

function normalizeHttpProtocol(protocol: string | undefined): "http" | "https" | undefined {
  if (!protocol) return undefined;

  const normalized = protocol.trim().toLowerCase().replace(/:$/, "");
  if (normalized === "http" || normalized === "https") {
    return normalized;
  }

  return undefined;
}

function normalizeOriginHeader(originHeader: string | string[] | undefined): string | undefined {
  const rawOrigin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!rawOrigin) return undefined;

  try {
    return new URL(rawOrigin).origin;
  } catch {
    return undefined;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function writeCorsHeaders(response: ServerResponse, origin: string | undefined): void {
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body, null, 2));
}
