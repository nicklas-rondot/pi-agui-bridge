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

export interface BridgeServerHandlers {
  getHealth(): BridgeHealthResponse;
  pair(origin: string | undefined, body: PairRequestBody): Promise<PairResponseBody>;
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
      const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
      const origin = normalizeOriginHeader(request.headers.origin);

      if (request.method === "OPTIONS") {
        writeCorsHeaders(response, origin);
        response.writeHead(204);
        response.end();
        return;
      }

      if (url.pathname === "/health" && request.method === "GET") {
        writeCorsHeaders(response, origin);
        writeJson(response, 200, this.handlers.getHealth());
        return;
      }

      if (url.pathname === "/pair" && request.method === "POST") {
        writeCorsHeaders(response, origin);
        const body = (await readJsonBody(request)) as PairRequestBody;
        const result = await this.handlers.pair(origin, body);
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
